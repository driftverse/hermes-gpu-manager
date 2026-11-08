// Ollama adapter: talks to the two loopback instances (`gpu`, `cpu`) over their native HTTP API.
// The HTTP client is injectable. Only loopback http URLs are accepted. No CLI, no systemctl.
//
// Endpoints used:  GET /api/ps  /api/tags  /api/version     POST /api/show  /api/create  /api/generate

import http from 'node:http';

const MiB = 1024 * 1024;
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);
const INSTANCES = ['gpu', 'cpu'];

export const variantTag = (base, gpuLayers) => `${base}-g${gpuLayers}`;

export function defaultHttp({ method, url, body, timeoutMs = 30_000 }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const headers = payload ? { 'content-type': 'application/json', 'content-length': String(payload.length) } : {};
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method, headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, json, text });
      });
      res.on('error', reject);
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timed out after ${timeoutMs} ms`)));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function checkUrl(label, value) {
  let u;
  try { u = new URL(value); } catch { throw new Error(`ollama ${label}: invalid URL`); }
  if (u.protocol !== 'http:' || !LOOPBACK.has(u.hostname.replace(/^\[|\]$/g, ''))) {
    throw new Error(`ollama ${label} must be a loopback http URL`);
  }
  return u.origin;
}

export function createOllamaAdapter({ urls, http: client = defaultHttp, loadTimeoutMs = 15 * 60 * 1000, requestTimeoutMs = 30_000 }) {
  const base = {};
  for (const name of INSTANCES) base[name] = checkUrl(name, urls?.[name]);

  async function call(instance, method, path, body, timeoutMs = requestTimeoutMs) {
    if (!base[instance]) throw new Error(`unknown ollama instance: ${instance}`);
    const res = await client({ method, url: `${base[instance]}${path}`, body, timeoutMs });
    if (res.status < 200 || res.status >= 300) {
      const detail = res.json?.error || res.text || '';
      throw new Error(`ollama ${instance} ${method} ${path}: HTTP ${res.status}: ${String(detail).slice(0, 300)}`);
    }
    return res.json ?? {};
  }

  const adapter = {
    async ps(instance) {
      const out = await call(instance, 'GET', '/api/ps');
      return (out.models || []).map((m) => {
        const sizeBytes = Number(m.size) || 0;
        const sizeVramBytes = Number(m.size_vram) || 0;
        return {
          name: m.name || m.model,
          sizeBytes,
          sizeVramBytes,
          sizeMiB: Math.round(sizeBytes / MiB),
          sizeVramMiB: Math.round(sizeVramBytes / MiB),
          vramFraction: sizeBytes > 0 ? Math.min(1, sizeVramBytes / sizeBytes) : 0,
          expiresAt: m.expires_at || null,
        };
      });
    },

    async tags(instance = 'cpu') {
      const out = await call(instance, 'GET', '/api/tags');
      return (out.models || []).map((m) => m.name || m.model).filter(Boolean);
    },

    async healthy(instance) {
      try {
        await call(instance, 'GET', '/api/version', undefined, 3000);
        return true;
      } catch {
        return false;
      }
    },

    async numCtx(model) {
      const out = await call('cpu', 'POST', '/api/show', { model, name: model });
      const m = /^\s*num_ctx\s+(\d+)/m.exec(String(out.parameters || ''));
      return m ? Number(m[1]) : null;
    },

    // Partial-offload variant: same weights (shared store), num_ctx copied from the base, num_gpu pinned.
    async ensureVariant({ base: baseTag, gpuLayers }) {
      const tag = variantTag(baseTag, gpuLayers);
      if ((await adapter.tags('cpu')).includes(tag)) return { tag, created: false };
      const numCtx = await adapter.numCtx(baseTag);
      const parameters = { ...(numCtx ? { num_ctx: numCtx } : {}), num_gpu: gpuLayers };
      // `model` is the current field, `name` the legacy one; unknown fields are ignored by Ollama.
      await call('cpu', 'POST', '/api/create', { model: tag, name: tag, from: baseTag, parameters, stream: false }, loadTimeoutMs);
      return { tag, created: true };
    },

    // Load and pin (keep_alive -1) a model on one instance. An empty prompt loads without generating.
    async load(instance, model) {
      await call(instance, 'POST', '/api/generate', { model, prompt: '', keep_alive: -1, stream: false }, loadTimeoutMs);
    },

    async unload(instance, model) {
      await call(instance, 'POST', '/api/generate', { model, keep_alive: 0 }, requestTimeoutMs);
    },
  };
  return adapter;
}
