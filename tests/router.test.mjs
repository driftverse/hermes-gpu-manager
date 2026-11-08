import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRouter, MAX_BODY_BYTES } from '../src/router.mjs';
import { fakeBackend, echoHandler, deadUrl, request, postJson, openStream, sleep, until, listen, close } from './helpers/net.mjs';

const cleanup = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()(); });

async function setup({ gpu, cpu, gpuUrl, cpuUrl, options = {} } = {}) {
  const g = gpu === null ? null : await fakeBackend('gpu', gpu || echoHandler('gpu'));
  const c = cpu === null ? null : await fakeBackend('cpu', cpu || echoHandler('cpu'));
  if (g) cleanup.push(g.close);
  if (c) cleanup.push(c.close);
  const router = createRouter({
    backends: { gpu: gpuUrl || g.url, cpu: cpuUrl || c.url },
    ...options,
  });
  const port = await router.listen(0);
  cleanup.push(() => router.close());
  return { g, c, router, port };
}

test('unknown plan defaults to the CPU backend (never blocks)', async () => {
  const { port, g, c } = await setup();
  const r = await postJson(port, '/api/chat', { model: 'lfm3:1.7b-100000', messages: [] });
  assert.equal(r.json.backend, 'cpu');
  assert.equal(c.seen.length, 1);
  assert.equal(g.seen.length, 0);
});

test('plan gpu routes to the GPU backend with the model name unchanged', async () => {
  const { port, g, router } = await setup();
  router.setPlan('lfm3:1.7b-100000', { route: 'gpu' });
  const r = await postJson(port, '/api/generate', { model: 'lfm3:1.7b-100000', prompt: 'hi' });
  assert.equal(r.json.backend, 'gpu');
  assert.equal(g.seen[0].json.model, 'lfm3:1.7b-100000');
});

test('plan partial routes to GPU with only the JSON model rewritten; response untouched', async () => {
  const { port, g, router } = await setup({
    gpu: (req, res, rec) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ model: rec.json.model, note: 'model-in-response-is-not-rewritten' })); },
  });
  router.setPlan('lfm3:1.7b-100000', { route: 'partial', variantTag: 'lfm3:1.7b-100000-g12' });
  const r = await postJson(port, '/api/chat', { model: 'lfm3:1.7b-100000', stream: false, options: { num_ctx: 70000 }, messages: [{ role: 'user', content: 'model' }] });
  assert.equal(g.seen[0].json.model, 'lfm3:1.7b-100000-g12');
  assert.deepEqual(g.seen[0].json.options, { num_ctx: 70000 });
  assert.equal(g.seen[0].json.messages[0].content, 'model');
  assert.equal(r.json.model, 'lfm3:1.7b-100000-g12'); // backend echoed what it got; router does not touch responses
  assert.equal(r.json.note, 'model-in-response-is-not-rewritten');
});

test('plan cpu routes to CPU; GET and non-JSON bodies go to CPU', async () => {
  const { port, c, g, router } = await setup();
  router.setPlan('m', { route: 'cpu' });
  assert.equal((await postJson(port, '/api/chat', { model: 'm' })).json.backend, 'cpu');
  assert.equal((await request(port, { path: '/api/tags' })).json.backend, 'cpu');
  const nonJson = await request(port, { method: 'POST', path: '/api/chat', headers: { 'content-type': 'text/plain' }, body: 'model=lfm3' });
  assert.equal(nonJson.json.backend, 'cpu');
  assert.equal(g.seen.length, 0);
  assert.equal(c.seen.length, 3);
});

test('OpenAI-compatible /v1 paths route by model too', async () => {
  const { port, g, router } = await setup();
  router.setPlan('m', { route: 'gpu' });
  const r = await postJson(port, '/v1/chat/completions', { model: 'm', messages: [] });
  assert.equal(r.json.backend, 'gpu');
  assert.equal(g.seen[0].url, '/v1/chat/completions');
});

test('clearPlan returns the model to the CPU default', async () => {
  const { port, router } = await setup();
  router.setPlan('m', { route: 'gpu' });
  router.clearPlan('m');
  assert.equal((await postJson(port, '/api/chat', { model: 'm' })).json.backend, 'cpu');
});

test('streaming passthrough: chunks arrive incrementally and in order (NDJSON)', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { port, router } = await setup({
    gpu: async (req, res) => {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.write('{"n":1}\n');
      await gate;
      res.write('{"n":2}\n');
      res.end('{"n":3,"done":true}\n');
    },
  });
  router.setPlan('m', { route: 'gpu' });
  const s = openStream(port, { path: '/api/chat', body: { model: 'm' } });
  const first = await s.nextChunk();
  assert.equal(first, '{"n":1}\n'); // delivered while the backend is still waiting on the gate
  assert.equal(s.done, false);
  release();
  await s.finished();
  assert.equal(s.chunks.join(''), '{"n":2}\n{"n":3,"done":true}\n');
});

test('SSE passthrough keeps content-type and event order', async () => {
  const { port, router } = await setup({
    gpu: async (req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      for (let i = 1; i <= 3; i += 1) { res.write(`data: {"i":${i}}\n\n`); await sleep(5); }
      res.end('data: [DONE]\n\n');
    },
  });
  router.setPlan('m', { route: 'gpu' });
  const s = openStream(port, { path: '/v1/chat/completions', body: { model: 'm', stream: true } });
  await s.ready;
  assert.equal(s.response.headers['content-type'], 'text/event-stream');
  await s.finished();
  assert.equal(s.chunks.join(''), 'data: {"i":1}\n\ndata: {"i":2}\n\ndata: {"i":3}\n\ndata: [DONE]\n\n');
});

test('hop-by-hop headers are not forwarded; Host is rewritten; end-to-end headers survive', async () => {
  const { port, g, router } = await setup();
  router.setPlan('m', { route: 'gpu' });
  await request(port, {
    method: 'POST', path: '/api/chat',
    headers: { 'content-type': 'application/json', connection: 'keep-alive, x-custom-hop', 'x-custom-hop': 'secret', 'keep-alive': 'timeout=5', 'proxy-authorization': 'x', te: 'trailers', 'x-keep-me': 'yes', authorization: 'Bearer abc' },
    body: JSON.stringify({ model: 'm' }),
  });
  const h = g.seen[0].headers;
  assert.equal(h['x-custom-hop'], undefined);
  assert.equal(h['keep-alive'], undefined);
  assert.equal(h['proxy-authorization'], undefined);
  assert.equal(h['x-keep-me'], 'yes');
  assert.equal(h.authorization, 'Bearer abc');
  assert.equal(h.host, `127.0.0.1:${g.port}`);
});

test('failover: GPU refuses the connection -> retried once on CPU with the original model name', async () => {
  const gpuUrl = await deadUrl();
  const { port, c, router } = await setup({ gpuUrl, gpu: null });
  router.setPlan('lfm3', { route: 'partial', variantTag: 'lfm3-g12' });
  const r = await postJson(port, '/api/chat', { model: 'lfm3', messages: [] });
  assert.equal(r.status, 200);
  assert.equal(r.json.backend, 'cpu');
  assert.equal(c.seen[0].json.model, 'lfm3'); // base tag restored, not the GPU variant
  const st = router.getState();
  assert.equal(st.failovers.length, 1);
  assert.equal(st.failovers[0].from, 'gpu');
  assert.equal(st.failovers[0].to, 'cpu');
  assert.equal(st.failovers[0].model, 'lfm3');
  assert.match(st.failovers[0].reason, /ECONNREFUSED/);
});

test('failover: a 5xx before any byte is retried on the other backend', async () => {
  const { port, c, router } = await setup({ gpu: (req, res) => { res.writeHead(503, { 'content-type': 'application/json' }); res.end('{"error":"busy"}'); } });
  router.setPlan('m', { route: 'gpu' });
  const r = await postJson(port, '/api/chat', { model: 'm' });
  assert.equal(r.json.backend, 'cpu');
  assert.equal(c.seen.length, 1);
  assert.match(router.getState().failovers[0].reason, /503/);
});

test('failover: CPU failure is retried once on the GPU', async () => {
  const cpuUrl = await deadUrl();
  const { port, g, router } = await setup({ cpuUrl, cpu: null });
  const r = await postJson(port, '/api/chat', { model: 'unplanned' });
  assert.equal(r.json.backend, 'gpu');
  assert.equal(g.seen.length, 1);
  assert.equal(router.getState().failovers[0].from, 'cpu');
});

test('4xx responses are NOT failed over', async () => {
  const { port, c, router } = await setup({ gpu: (req, res) => { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"error":"model not found"}'); } });
  router.setPlan('m', { route: 'gpu' });
  const r = await postJson(port, '/api/chat', { model: 'm' });
  assert.equal(r.status, 404);
  assert.equal(c.seen.length, 0);
  assert.equal(router.getState().failovers.length, 0);
});

test('no failover once bytes were sent: mid-stream backend death is not retried', async () => {
  const { port, c, router } = await setup({
    gpu: async (req, res) => { res.writeHead(200, { 'content-type': 'application/x-ndjson' }); res.write('{"n":1}\n'); await sleep(20); req.socket.destroy(); },
  });
  router.setPlan('m', { route: 'gpu' });
  const s = openStream(port, { path: '/api/chat', body: { model: 'm' } });
  await s.finished();
  assert.equal(s.chunks.join('').includes('{"n":1}'), true);
  assert.ok(s.error, 'client must see the truncation as an error, not a clean end');
  assert.equal(c.seen.length, 0);
  assert.equal(router.getState().failovers.length, 0);
  await until(() => router.getState().inflight.gpu === 0);
});

test('both backends down -> 502 JSON error, counters back to zero', async () => {
  const { port, router } = await setup({ gpuUrl: await deadUrl(), cpuUrl: await deadUrl(), gpu: null, cpu: null });
  const r = await postJson(port, '/api/chat', { model: 'm' });
  assert.equal(r.status, 502);
  assert.match(r.json.error, /backend/i);
  const st = router.getState();
  assert.deepEqual(st.inflight, { gpu: 0, cpu: 0 });
});

test('in-flight counters per backend and per model; drain waits for a slow streaming request', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { port, router } = await setup({
    gpu: async (req, res) => { res.writeHead(200); res.write('start\n'); await gate; res.end('end\n'); },
  });
  router.setPlan('m', { route: 'gpu' });
  const s = openStream(port, { path: '/api/chat', body: { model: 'm' } });
  await s.nextChunk();
  const st = router.getState();
  assert.equal(st.inflight.gpu, 1);
  assert.equal(st.inflight.cpu, 0);
  assert.equal(st.byModel.m.gpu, 1);

  let drained = false;
  const drain = router.drain('gpu', 5000).then(() => { drained = true; });
  await sleep(50);
  assert.equal(drained, false);
  release();
  await drain;
  assert.equal(drained, true);
  await s.finished();
  assert.equal(router.getState().inflight.gpu, 0);
  assert.equal(router.getState().byModel.m.gpu, 0);
});

test('drain resolves immediately when idle', async () => {
  const { router } = await setup();
  await router.drain('gpu', 50);
});

test('drain times out with a clear error and NEVER cuts the in-flight request', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { port, router } = await setup({ gpu: async (req, res) => { res.writeHead(200); res.write('a'); await gate; res.end('b'); } });
  router.setPlan('m', { route: 'gpu' });
  const s = openStream(port, { path: '/api/chat', body: { model: 'm' } });
  await s.nextChunk();
  await assert.rejects(router.drain('gpu', 60), (err) => {
    assert.equal(err.code, 'DRAIN_TIMEOUT');
    assert.equal(err.inflight, 1);
    assert.equal(err.backend, 'gpu');
    assert.match(err.message, /still serving 1 request/);
    return true;
  });
  assert.equal(router.getState().inflight.gpu, 1); // untouched
  release();
  await s.finished();
  assert.equal(s.error, null);
  assert.equal(s.chunks.join(''), 'b');
});

test('drain rejects an unknown backend name', async () => {
  const { router } = await setup();
  await assert.rejects(router.drain('tpu', 10), /unknown backend/i);
});

test('client abort frees the counter and aborts the upstream request', async () => {
  const { port, g, router } = await setup({ gpu: async (req, res) => { res.writeHead(200); res.write('x'); await sleep(5000); res.end(); } });
  router.setPlan('m', { route: 'gpu' });
  const s = openStream(port, { path: '/api/chat', body: { model: 'm' } });
  await s.nextChunk();
  assert.equal(router.getState().inflight.gpu, 1);
  s.abort();
  await until(() => router.getState().inflight.gpu === 0);
  await until(() => g.seen[0].closed === true);
  assert.equal(router.getState().byModel.m.gpu, 0);
  assert.ok(router.getState().events.some((e) => e.type === 'client-abort'));
});

test('client abort before the backend answers (non-streaming wait) also frees the counter', async () => {
  const { port, g, router } = await setup({ gpu: async () => { await sleep(5000); } });
  router.setPlan('m', { route: 'gpu' });
  const s = openStream(port, { path: '/api/chat', body: { model: 'm' } });
  await until(() => router.getState().inflight.gpu === 1);
  s.abort();
  await until(() => router.getState().inflight.gpu === 0);
  await until(() => g.seen[0].closed === true);
});

test('request body cap: default is 8 MiB', () => {
  assert.equal(MAX_BODY_BYTES, 8 * 1024 * 1024);
});

test('request body over the cap -> 413 (Content-Length), nothing reaches a backend', async () => {
  const { port, g, c } = await setup({ options: { maxBodyBytes: 1024 } });
  const r = await request(port, { method: 'POST', path: '/api/chat', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'm', pad: 'x'.repeat(4000) }) });
  assert.equal(r.status, 413);
  assert.equal(g.seen.length + c.seen.length, 0);
});

test('request body over the cap -> 413 (chunked, no Content-Length)', async () => {
  const { port, g, c } = await setup({ options: { maxBodyBytes: 1024 } });
  const r = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/chat', headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' }, agent: false }, (res) => {
      let t = ''; res.on('data', (d) => { t += d; }); res.on('end', () => resolve({ status: res.statusCode, t }));
    });
    req.on('error', (e) => resolve({ status: 'error', e }));
    req.write('{"model":"m","pad":"');
    req.write('x'.repeat(600));
    req.write('x'.repeat(600));
    req.end('"}');
  });
  assert.ok(r.status === 413 || r.status === 'error');
  assert.equal(g.seen.length + c.seen.length, 0);
});

test('body exactly at the cap is accepted', async () => {
  const { port, c } = await setup({ options: { maxBodyBytes: 200 } });
  const base = JSON.stringify({ model: 'm', p: '' });
  const body = JSON.stringify({ model: 'm', p: 'x'.repeat(200 - base.length) });
  assert.equal(Buffer.byteLength(body), 200);
  const r = await request(port, { method: 'POST', path: '/api/chat', headers: { 'content-type': 'application/json' }, body });
  assert.equal(r.status, 200);
  assert.equal(c.seen.length, 1);
});

test('concurrency: 60 parallel requests across both backends, correct routing, counters return to zero', async () => {
  let peak = 0;
  const slow = (tag) => async (req, res, rec) => {
    peak += 1;
    await sleep(20);
    peak -= 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ backend: tag, model: rec.json.model }));
  };
  const { port, router, g, c } = await setup({ gpu: slow('gpu'), cpu: slow('cpu') });
  router.setPlan('a', { route: 'gpu' });
  router.setPlan('b', { route: 'cpu' });
  const results = await Promise.all(Array.from({ length: 60 }, (_, i) => postJson(port, '/api/chat', { model: i % 2 ? 'a' : 'b', i })));
  results.forEach((r, i) => assert.equal(r.json.backend, i % 2 ? 'gpu' : 'cpu'));
  assert.equal(g.seen.length, 30);
  assert.equal(c.seen.length, 30);
  assert.ok(peak >= 0);
  const st = router.getState();
  assert.deepEqual(st.inflight, { gpu: 0, cpu: 0 });
  assert.equal(st.totals.requests, 60);
});

test('/api/ps merges both instances and tags each entry with its backend', async () => {
  const ps = (name) => (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ models: [{ name, size_vram: 1 }] })); };
  const { port } = await setup({ gpu: ps('on-gpu'), cpu: ps('on-cpu') });
  const r = await request(port, { path: '/api/ps' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.models.map((m) => [m.name, m.penny_backend]), [['on-gpu', 'gpu'], ['on-cpu', 'cpu']]);
});

test('/api/ps still answers when one instance is down', async () => {
  const { port } = await setup({ gpuUrl: await deadUrl(), gpu: null, cpu: (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ models: [{ name: 'x' }] })); } });
  const r = await request(port, { path: '/api/ps' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.models.map((m) => m.penny_backend), ['cpu']);
});

test('event log keeps only the last 50 events', async () => {
  const { port, router } = await setup({ gpuUrl: await deadUrl(), gpu: null });
  router.setPlan('m', { route: 'gpu' });
  for (let i = 0; i < 60; i += 1) await postJson(port, '/api/chat', { model: 'm' });
  const st = router.getState();
  assert.equal(st.events.length, 50);
  assert.equal(st.totals.failovers, 60);
});

test('refuses to listen on anything but loopback', async () => {
  const { router } = await setup();
  const other = createRouter({ backends: { gpu: 'http://127.0.0.1:1', cpu: 'http://127.0.0.1:2' } });
  await assert.rejects(other.listen(0, '0.0.0.0'), /loopback/i);
  await assert.rejects(other.listen(0, '192.168.1.5'), /loopback/i);
  assert.ok(router);
});

test('backends must be loopback http URLs', () => {
  assert.throws(() => createRouter({ backends: { gpu: 'http://example.com:11434', cpu: 'http://127.0.0.1:1' } }), /loopback/i);
});

test('router keeps serving after a handler throws on a malformed request', async () => {
  const { port } = await setup();
  const bad = await request(port, { method: 'POST', path: '/api/chat', headers: { 'content-type': 'application/json' }, body: '{not json' });
  assert.equal(bad.json.backend, 'cpu'); // unparseable JSON is forwarded untouched to the CPU backend
  const ok = await postJson(port, '/api/chat', { model: 'm' });
  assert.equal(ok.status, 200);
  void listen; void close;
});
