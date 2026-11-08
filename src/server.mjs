// HTTP surface for the manager: the GUI, the JSON API and the (local-only) lease endpoints.
//
// Every request is authorised FIRST (auth.mjs: loopback or Cloudflare Access), before routing, so an
// unauthenticated caller cannot tell a real path from a missing one. Static files come from a fixed
// allowlist (no path joining from the URL), request bodies are capped at 64 KiB and must be JSON.
//
// Lease calls come from the renderer on this machine; they are refused on the public host (auth.mjs) and
// a lease whose client disconnected before the answer arrived is released again, so a vanished renderer
// cannot hold the GPU until the lease TTL runs out.

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { authorizeRequest } from './auth.mjs';
import { ApiError } from './manager.mjs';

export const MAX_API_BODY = 64 * 1024;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,39}$/;

const STATIC_FILES = Object.freeze({
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/lib.js': ['lib.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
});

const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self' data:",
  "connect-src 'self'", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'self'",
].join('; ');

const SECURITY_HEADERS = Object.freeze({
  'content-security-policy': CSP,
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
});

function send(res, status, body, extra = {}) {
  if (res.headersSent) return res.end();
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  const payload = isJson ? JSON.stringify(body) : body;
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'content-type': isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    ...extra,
  });
  return res.end(payload);
}

const sendError = (res, status, message, extra) => send(res, status, { error: message }, extra);

// Reads at most MAX_API_BODY bytes. Resolves { tooLarge } instead of rejecting so the caller can answer 413.
function readBody(req, limit = MAX_API_BODY) {
  return new Promise((resolve) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) return resolve({ tooLarge: true });
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    req.on('data', (c) => {
      if (done) return;
      size += c.length;
      if (size > limit) { chunks.length = 0; finish({ tooLarge: true }); return; }
      chunks.push(c);
    });
    req.on('end', () => finish({ buffer: Buffer.concat(chunks) }));
    req.on('error', () => finish({ aborted: true }));
    req.on('close', () => finish({ aborted: true }));
  });
}

function drainBounded(req) {
  let extra = 0;
  req.on('data', (c) => { extra += c.length; if (extra > 1024 * 1024) req.destroy(); });
  req.on('error', () => {});
  req.resume();
}

function decodeId(raw) {
  let id;
  try { id = decodeURIComponent(raw); } catch { return null; }
  return ID_PATTERN.test(id) ? id : null;
}

function parseJsonBody(req, buffer) {
  if (!buffer.length) return { value: {} };
  const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') return { status: 415, message: 'Content-Type must be application/json.' };
  let value;
  try { value = JSON.parse(buffer.toString('utf8')); } catch { return { status: 400, message: 'The request body is not valid JSON.' }; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { status: 400, message: 'The request body must be a JSON object.' };
  return { value };
}

export function createAppServer({
  manager, config, publicDir, authDeps = {}, leaseJobs = ['musetalk', 'sd15', 'ltxvideo', 'flux2', 'sdxl', 'ltx098', 'immichvision'], logger = console, readStatic = readFile,
}) {
  let server = null;

  // ---- lease endpoints ---------------------------------------------------------------------------------------

  async function handleLease(req, res, body, jobId, action) {
    if (!leaseJobs.includes(jobId)) return sendError(res, 400, 'Unknown job.');
    let clientGone = false;
    res.on('close', () => { if (!res.writableFinished) clientGone = true; });

    if (action === 'acquire') {
      const opts = { jobId };
      if (typeof body.holder === 'string' && body.holder.trim()) opts.holder = body.holder.trim().slice(0, 80);
      if (body.wait !== undefined) opts.wait = body.wait === true;
      if (Number.isInteger(body.timeoutSec) && body.timeoutSec >= 1 && body.timeoutSec <= 3600) opts.timeoutSec = body.timeoutSec;
      const result = await manager.acquireLease(opts);
      if (result.ok && clientGone) {
        await manager.releaseLease({ leaseId: result.leaseId }).catch((err) => logger.error?.(`orphaned lease release failed: ${err.message}`));
        return undefined;
      }
      if (result.ok) return send(res, 200, result);
      return send(res, /^busy/.test(result.reason || '') ? 409 : 503, result);
    }

    const leaseId = typeof body.leaseId === 'string' ? body.leaseId : '';
    const result = action === 'release' ? await manager.releaseLease({ leaseId }) : await manager.heartbeatLease({ leaseId });
    if (result.ok) return send(res, 200, result);
    return send(res, result.code === 'unknown_lease' ? 404 : 400, result);
  }

  // ---- routing -----------------------------------------------------------------------------------------------

  // Returns { methods, run } for an API path, or null.
  function route(path) {
    if (path === '/api/status') return { methods: ['GET'], run: async () => manager.status() };
    if (path === '/api/models') return { methods: ['GET'], run: async () => ({ models: await manager.listModels() }) };
    if (path === '/api/order') return { methods: ['PUT'], run: async (b) => manager.setOrder(b.order) };
    if (path === '/api/settings') return { methods: ['PUT'], run: async (b) => manager.setSettings(b) };
    if (path === '/api/apply') return { methods: ['POST'], run: async () => manager.apply({ force: true }) };
    if (path === '/api/workloads') return { methods: ['POST'], run: async (b) => manager.addWorkload(b) };
    const wl = /^\/api\/workloads\/([^/]+)$/.exec(path);
    if (wl) {
      const id = decodeId(wl[1]);
      return {
        methods: ['PUT', 'DELETE'],
        invalid: id === null,
        run: async (b, method) => (method === 'PUT' ? manager.updateWorkload(id, b) : manager.removeWorkload(id)),
      };
    }
    return null;
  }

  async function serveStatic(res, path) {
    const entry = Object.hasOwn(STATIC_FILES, path) ? STATIC_FILES[path] : null;
    if (!entry) return sendError(res, 404, 'Not found.');
    let data;
    try { data = await readStatic(join(publicDir, entry[0])); } catch { return sendError(res, 404, 'Not found.'); }
    return send(res, 200, data, { 'content-type': entry[1] });
  }

  async function handle(req, res) {
    const path = String(req.url || '/').split('?')[0];
    const verdict = await authorizeRequest(
      { method: req.method, path, headers: req.headers, remoteAddress: req.socket.remoteAddress }, config, authDeps,
    );
    if (!verdict.ok) return sendError(res, verdict.status, verdict.message);

    if (!path.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendError(res, 405, 'Method not allowed.', { allow: 'GET, HEAD' });
      return serveStatic(res, path);
    }

    const lease = /^\/api\/leases\/([^/]+)\/(acquire|release|heartbeat)$/.exec(path);
    const found = lease ? { methods: ['POST'] } : route(path);
    if (!found) return sendError(res, 404, 'Not found.');
    if (!found.methods.includes(req.method)) return sendError(res, 405, 'Method not allowed.', { allow: found.methods.join(', ') });
    if (found.invalid) return sendError(res, 400, 'Invalid workload id.');

    let body = {};
    if (req.method !== 'GET') {
      const read = await readBody(req);
      if (read.aborted) return undefined;
      if (read.tooLarge) {
        res.once('finish', () => drainBounded(req));
        return sendError(res, 413, 'The request body is too large.', { connection: 'close' });
      }
      const parsed = parseJsonBody(req, read.buffer);
      if (!parsed.value) return sendError(res, parsed.status, parsed.message);
      body = parsed.value;
    }

    if (lease) return handleLease(req, res, body, lease[1], lease[2]);
    const result = await found.run(body, req.method);
    return send(res, 200, result);
  }

  function handler(req, res) {
    handle(req, res).catch((err) => {
      if (err instanceof ApiError) return sendError(res, err.status, err.message);
      logger.error?.(`request failed: ${err?.stack || err}`);
      return sendError(res, 500, 'Internal error.');
    });
  }

  return {
    async listen(port, host = '127.0.0.1') {
      if (!LOOPBACK_HOSTS.has(host)) throw new Error(`the manager may only listen on loopback, not ${host}`);
      server = http.createServer(handler);
      server.on('clientError', (err, socket) => { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); });
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
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
