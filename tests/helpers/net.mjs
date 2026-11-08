// Test-only network helpers: fake Ollama backends and a tiny HTTP client. Loopback + ephemeral ports only.
import http from 'node:http';

export function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

export function close(server) {
  return new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}

export function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// A programmable fake backend. `handler(req, res, record)` runs after the request is recorded.
export async function fakeBackend(name, handler) {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    const body = await readBody(req);
    const record = { method: req.method, url: req.url, headers: req.headers, body: body.toString('utf8') };
    try { record.json = JSON.parse(record.body); } catch { /* not json */ }
    seen.push(record);
    record.closed = false;
    res.on('close', () => { record.closed = true; });
    await handler(req, res, record);
  });
  const port = await listen(server);
  return { name, server, port, url: `http://127.0.0.1:${port}`, seen, close: () => close(server) };
}

export const echoHandler = (tag) => (req, res, record) => {
  res.writeHead(200, { 'content-type': 'application/json', 'x-backend': tag });
  res.end(JSON.stringify({ backend: tag, model: record.json?.model ?? null, path: req.url }));
};

// Reserve a port that nothing listens on (connection refused).
export async function deadUrl() {
  const server = http.createServer();
  const port = await listen(server);
  await close(server);
  return `http://127.0.0.1:${port}`;
}

export function request(port, { method = 'GET', path = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json;
        try { json = JSON.parse(text); } catch { /* not json */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
      res.on('error', reject);
      res.on('aborted', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8'), aborted: true }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

export const postJson = (port, path, obj, headers = {}) =>
  request(port, { method: 'POST', path, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(obj) });

// Open a streaming request and expose each chunk as it arrives.
export function openStream(port, { method = 'POST', path, body, headers = {} }) {
  const chunks = [];
  const waiters = [];
  let done = false;
  let error = null;
  let response;
  const req = http.request({ host: '127.0.0.1', port, method, path, headers: { 'content-type': 'application/json', ...headers }, agent: false });
  const ready = new Promise((resolve) => {
    req.on('response', (res) => {
      response = res;
      res.on('data', (c) => { chunks.push(c.toString('utf8')); while (waiters.length) waiters.shift()(); });
      res.on('end', () => { done = true; while (waiters.length) waiters.shift()(); });
      res.on('error', (e) => { error = e; done = true; while (waiters.length) waiters.shift()(); });
      res.on('aborted', () => { error = error || new Error('aborted'); done = true; while (waiters.length) waiters.shift()(); });
      resolve(res);
    });
  });
  req.on('error', (e) => { error = e; done = true; while (waiters.length) waiters.shift()(); });
  if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body));
  req.end();
  return {
    req,
    ready,
    get response() { return response; },
    get chunks() { return chunks; },
    get done() { return done; },
    get error() { return error; },
    async nextChunk() {
      if (chunks.length) return chunks.shift();
      if (done) return null;
      await new Promise((r) => waiters.push(r));
      return chunks.shift() ?? null;
    },
    async finished() { while (!done) await new Promise((r) => waiters.push(r)); },
    abort() { req.destroy(); },
  };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function until(fn, { timeoutMs = 3000, stepMs = 5 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return;
    await sleep(stepMs);
  }
  throw new Error('condition not met in time');
}
