// Streaming reverse proxy for the Ollama HTTP API with two loopback backends: `gpu` and `cpu`.
//
// Routing is decided per request from the CURRENT PLAN for the model named in the JSON body:
//   route 'gpu'     -> GPU backend, model name unchanged
//   route 'partial' -> GPU backend, request JSON `model` rewritten to plan.variantTag (response untouched)
//   route 'cpu'     -> CPU backend
//   unknown model / GET / non-JSON body / no plan at all -> CPU backend (the router never blocks on the manager)
//
// Failover: a connection error or a 5xx status BEFORE any response byte reaches the client is retried
// once on the other backend (GPU failure -> CPU with the ORIGINAL model name). After the first byte has
// been sent nothing is ever retried. If a backend dies mid-stream the client socket is destroyed so the
// truncation is visible as an error rather than looking like a clean end.
//
// No timeouts on upstream responses: a non-streaming generation sends nothing for many minutes and must
// never be cut. In-flight requests are only ever aborted by the client going away.
//
// Design choices for non-inference endpoints:
//   GET /api/ps   -> merged: both instances queried, each model entry tagged with `penny_backend`
//   GET /api/tags -> proxied to the CPU instance (same model store), GPU only if the CPU instance fails
//   everything else without a model -> CPU first, GPU on failover

import http from 'node:http';

export const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_EVENTS = 50;
const BACKENDS = ['gpu', 'cpu'];
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

function stripHopByHop(headers) {
  const named = new Set(
    String(headers.connection || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  );
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower) || named.has(lower)) continue;
    out[lower] = value;
  }
  return out;
}

const modelKey = (name) => (name.includes(':') ? name : `${name}:latest`);
const pathOf = (url) => url.split('?')[0];

function parseBackend(label, value) {
  let u;
  try { u = new URL(value); } catch { throw new Error(`backend ${label}: invalid URL`); }
  if (u.protocol !== 'http:' || !LOOPBACK_HOSTS.has(u.hostname.replace(/^\[|\]$/g, ''))) {
    throw new Error(`backend ${label} must be a loopback http URL`);
  }
  return u;
}

function getJson(target, path, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: target.hostname, port: target.port, path, agent: false, timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(e); }
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

export function createRouter({ backends, maxBodyBytes = MAX_BODY_BYTES, now = Date.now } = {}) {
  const targets = {};
  for (const name of BACKENDS) targets[name] = parseBackend(name, backends?.[name]);

  const plans = new Map(); // modelKey -> { route, variantTag }
  const inflight = { gpu: 0, cpu: 0 };
  const byModel = new Map(); // model -> { gpu, cpu }
  const totals = { requests: 0, failovers: 0, aborts: 0, errors: 0, tooLarge: 0 };
  const events = [];
  const failovers = [];
  let waiters = []; // { backend, resolve }
  let server = null;

  function record(type, data = {}) {
    const event = { t: now(), type, ...data };
    events.push(event);
    if (events.length > MAX_EVENTS) events.shift();
    return event;
  }

  function notifyWaiters() {
    waiters = waiters.filter((w) => {
      if (inflight[w.backend] > 0) return true;
      w.resolve();
      return false;
    });
  }

  function acquire(ctx, backend) {
    inflight[backend] += 1;
    let m = byModel.get(ctx.model);
    if (!m) byModel.set(ctx.model, (m = { gpu: 0, cpu: 0 }));
    m[backend] += 1;
    ctx.counted = backend;
  }

  function release(ctx) {
    const backend = ctx.counted;
    if (!backend) return;
    ctx.counted = null;
    inflight[backend] -= 1;
    byModel.get(ctx.model)[backend] -= 1;
    notifyWaiters();
  }

  // ---- body handling -------------------------------------------------------------------------

  function rejectTooLarge(req, res) {
    totals.tooLarge += 1;
    record('body-too-large', { url: pathOf(req.url), limit: maxBodyBytes });
    res.writeHead(413, { 'content-type': 'application/json', connection: 'close' });
    res.end(JSON.stringify({ error: `request body exceeds ${maxBodyBytes} bytes` }));
    // Let the client finish sending (bounded) so it can read the 413 instead of seeing a reset.
    let extra = 0;
    req.on('data', (c) => { extra += c.length; if (extra > maxBodyBytes) req.destroy(); });
    req.on('error', () => {});
    req.resume();
  }

  function readBody(req, res) {
    return new Promise((resolve) => {
      const declared = Number(req.headers['content-length']);
      if (Number.isFinite(declared) && declared > maxBodyBytes) {
        rejectTooLarge(req, res);
        return resolve(null);
      }
      const chunks = [];
      let size = 0;
      let settled = false;
      const settle = (v) => { if (!settled) { settled = true; resolve(v); } };
      req.on('data', (c) => {
        if (settled) return;
        size += c.length;
        if (size > maxBodyBytes) {
          chunks.length = 0;
          rejectTooLarge(req, res);
          settle(null);
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => settle(Buffer.concat(chunks)));
      req.on('error', () => settle(null));
      req.on('aborted', () => settle(null));
    });
  }

  // ---- forwarding ----------------------------------------------------------------------------

  // Resolves once the outcome is decided: { failed: true, reason } when the attempt may be failed over
  // (nothing has been sent to the client), or { failed: false } once the response is being piped.
  function forward(ctx, backend, final) {
    return new Promise((resolve) => {
      const target = targets[backend];
      const headers = stripHopByHop(ctx.req.headers);
      delete headers.expect;
      headers.host = target.host;
      const payload = ctx.bodyFor(backend);
      if (ctx.hasBody) headers['content-length'] = String(payload.length);

      let responded = false;
      const up = http.request({
        host: target.hostname, port: target.port, method: ctx.req.method, path: ctx.req.url, headers, agent: false,
      });
      ctx.upstream = up;

      up.on('response', (upRes) => {
        responded = true;
        if (ctx.closed) { upRes.destroy(); return resolve({ failed: false }); }
        if (upRes.statusCode >= 500 && !final) {
          upRes.destroy();
          return resolve({ failed: true, reason: `HTTP ${upRes.statusCode}` });
        }
        const res = ctx.res;
        res.writeHead(upRes.statusCode, upRes.statusMessage, stripHopByHop(upRes.headers));
        res.flushHeaders();
        ctx.started = true;
        let ended = false;
        upRes.on('end', () => { ended = true; });
        upRes.on('error', () => {});
        upRes.on('close', () => {
          if (ended || ctx.closed) return;
          totals.errors += 1;
          record('upstream-lost', { backend, model: ctx.model, note: 'backend closed the stream early; client connection dropped' });
          res.destroy();
        });
        upRes.pipe(res);
        resolve({ failed: false });
      });

      up.on('error', (err) => {
        if (ctx.closed) return resolve({ failed: false });
        if (!responded) return resolve({ failed: true, reason: err.code || err.message });
        // Response already underway; upRes 'close' handler above deals with it.
      });

      up.end(payload);
    });
  }

  async function dispatch(req, res) {
    totals.requests += 1;
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
    const body = await readBody(req, res);
    if (body === null) return;

    let json = null;
    let model = null;
    if (body.length && body[0] === 0x7b /* { */) {
      try {
        const parsed = JSON.parse(body.toString('utf8'));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          json = parsed;
          if (typeof parsed.model === 'string' && parsed.model) model = parsed.model;
        }
      } catch { /* forwarded untouched */ }
    }

    const plan = model ? plans.get(modelKey(model)) : undefined;
    const route = plan?.route ?? 'cpu';
    const primary = route === 'cpu' ? 'cpu' : 'gpu';
    const bodyFor = (backend) => {
      if (backend === 'gpu' && route === 'partial' && json && plan.variantTag) {
        return Buffer.from(JSON.stringify({ ...json, model: plan.variantTag }));
      }
      return body;
    };

    const ctx = { req, res, model: model || '(none)', hasBody, bodyFor, closed: false, started: false, counted: null, upstream: null };

    res.on('finish', () => release(ctx));
    res.on('close', () => {
      if (!res.writableFinished && !ctx.closed) {
        ctx.closed = true;
        totals.aborts += 1;
        record('client-abort', { backend: ctx.counted, model: ctx.model, url: pathOf(req.url) });
        ctx.upstream?.destroy();
      }
      release(ctx);
    });
    res.on('error', () => {});

    acquire(ctx, primary);
    let outcome = await forward(ctx, primary, false);
    if (outcome.failed && !ctx.closed) {
      const other = primary === 'gpu' ? 'cpu' : 'gpu';
      totals.failovers += 1;
      const fo = record('failover', { from: primary, to: other, model: ctx.model, reason: outcome.reason, url: pathOf(req.url) });
      failovers.push(fo);
      if (failovers.length > MAX_EVENTS) failovers.shift();
      release(ctx);
      acquire(ctx, other);
      const firstReason = outcome.reason;
      outcome = await forward(ctx, other, true);
      if (outcome.failed && !ctx.closed) {
        totals.errors += 1;
        record('no-backend', { model: ctx.model, reason: `${primary}: ${firstReason}; ${other}: ${outcome.reason}` });
        release(ctx);
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: `no backend available (${primary}: ${firstReason}; ${other}: ${outcome.reason})` }));
      }
    }
  }

  // GET /api/ps: ask both instances, tag entries with the instance that reports them.
  async function mergedPs(res) {
    const settled = await Promise.allSettled(BACKENDS.map((b) => getJson(targets[b], '/api/ps')));
    const models = [];
    let any = false;
    settled.forEach((r, i) => {
      if (r.status !== 'fulfilled') return;
      any = true;
      for (const m of r.value?.models || []) models.push({ ...m, penny_backend: BACKENDS[i] });
    });
    if (!any) {
      res.writeHead(502, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'no backend available for /api/ps' }));
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ models }));
  }

  function handler(req, res) {
    const run = async () => {
      if (req.method === 'GET' && pathOf(req.url) === '/api/ps') return mergedPs(res);
      return dispatch(req, res);
    };
    run().catch((err) => {
      totals.errors += 1;
      record('router-error', { message: String(err?.message || err) });
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'router error' }));
      } else {
        res.destroy();
      }
    });
  }

  return {
    setPlan(model, { route, variantTag } = {}) {
      if (!['gpu', 'partial', 'cpu'].includes(route)) throw new Error(`invalid route: ${route}`);
      if (route === 'partial' && !variantTag) throw new Error('partial route needs a variantTag');
      const key = modelKey(model);
      const prev = plans.get(key);
      plans.set(key, { route, variantTag: route === 'partial' ? variantTag : undefined });
      if (!prev || prev.route !== route || prev.variantTag !== (route === 'partial' ? variantTag : undefined)) {
        record('plan', { model, route, variantTag });
      }
    },
    clearPlan(model) {
      if (plans.delete(modelKey(model))) record('plan', { model, route: null });
    },
    getPlan(model) {
      return plans.get(modelKey(model)) || null;
    },
    getState() {
      return {
        backends: { gpu: targets.gpu.origin, cpu: targets.cpu.origin },
        plan: Object.fromEntries(plans),
        inflight: { ...inflight },
        byModel: Object.fromEntries([...byModel].map(([k, v]) => [k, { ...v }])),
        totals: { ...totals },
        failovers: failovers.map((f) => ({ ...f })),
        events: events.map((e) => ({ ...e })),
      };
    },
    drain(backend, timeoutMs) {
      if (!BACKENDS.includes(backend)) return Promise.reject(new Error(`unknown backend: ${backend}`));
      if (inflight[backend] === 0) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const waiter = { backend, resolve: () => { clearTimeout(timer); resolve(); } };
        const timer = setTimeout(() => {
          waiters = waiters.filter((w) => w !== waiter);
          const n = inflight[backend];
          const err = new Error(`drain timed out after ${timeoutMs} ms: still serving ${n} request(s) on ${backend}`);
          err.code = 'DRAIN_TIMEOUT';
          err.backend = backend;
          err.inflight = n;
          reject(err);
        }, timeoutMs);
        timer.unref?.();
        waiters.push(waiter);
      });
    },
    async listen(port, host = '127.0.0.1') {
      if (!LOOPBACK_HOSTS.has(host)) throw new Error(`router may only listen on loopback, not ${host}`);
      server = http.createServer(handler);
      server.on('connection', (socket) => socket.setNoDelay(true));
      server.on('clientError', (err, socket) => { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); });
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, resolve);
      });
      return server.address().port;
    },
    close() {
      return new Promise((resolve) => {
        if (!server) return resolve();
        server.closeAllConnections?.();
        server.close(() => resolve());
      });
    },
  };
}
