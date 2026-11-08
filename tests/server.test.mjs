// HTTP surface: auth (local + Cloudflare Access), routing, limits, static GUI, lease endpoints.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAppServer } from '../src/server.mjs';
import { ApiError } from '../src/manager.mjs';
import { request, postJson, sleep } from './helpers/net.mjs';
import { makeKey, signToken, goodConfig, jwksFetcher } from './helpers/jwt-fixture.mjs';

function stubManager(over = {}) {
  const calls = [];
  const rec = (name, result) => async (...args) => {
    calls.push([name, ...args]);
    return typeof result === 'function' ? result(...args) : result;
  };
  const m = {
    calls,
    status: rec('status', { now: 1, workloads: [], events: [] }),
    setOrder: rec('setOrder', (ids) => ({ ok: true, order: ids })),
    setSettings: rec('setSettings', (p) => ({ ok: true, settings: p })),
    addWorkload: rec('addWorkload', (d) => ({ ok: true, workload: d })),
    updateWorkload: rec('updateWorkload', (id, p) => ({ ok: true, workload: { id, ...p } })),
    removeWorkload: rec('removeWorkload', { ok: true }),
    apply: rec('apply', { ok: true }),
    listModels: rec('listModels', ['lfm3:1.7b', 'lfm3:1.7b-100000']),
    acquireLease: rec('acquireLease', { ok: true, leaseId: 'L1' }),
    releaseLease: rec('releaseLease', { ok: true }),
    heartbeatLease: rec('heartbeatLease', { ok: true, expiresInSec: 1200 }),
    ...over,
  };
  return m;
}

async function boot({ manager = stubManager(), config = {}, authDeps } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'hermes-gui-'));
  await writeFile(join(dir, 'index.html'), '<!doctype html><title>t</title><script src="/app.js"></script>');
  await writeFile(join(dir, 'app.js'), 'export {};');
  await writeFile(join(dir, 'lib.js'), 'export {};');
  await writeFile(join(dir, 'style.css'), 'body{}');
  await writeFile(join(dir, 'secret.txt'), 'nope');
  const cfg = { ...goodConfig(), ...config };
  const app = createAppServer({ manager, config: cfg, publicDir: dir, authDeps });
  const port = await app.listen(0);
  cfg.localPort = port;
  const local = { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}` };
  return {
    app, port, manager, cfg, local, dir,
    get: (path, headers = {}) => request(port, { path, headers: { host: local.host, ...headers } }),
    send: (method, path, obj, headers = {}) => request(port, {
      method, path,
      headers: { host: local.host, origin: local.origin, 'content-type': 'application/json', ...headers },
      body: obj === undefined ? undefined : JSON.stringify(obj),
    }),
    async stop() { await app.close(); await rm(dir, { recursive: true, force: true }); },
  };
}

test('GET /api/status is served locally with no-store and nosniff', async () => {
  const s = await boot();
  const r = await s.get('/api/status');
  assert.equal(r.status, 200);
  assert.equal(r.json.now, 1);
  assert.equal(r.headers['cache-control'], 'no-store');
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
  assert.match(r.headers['content-type'], /^application\/json/);
  await s.stop();
});

test('static GUI: index with the strict CSP, scripts and styles as separate files', async () => {
  const s = await boot();
  const html = await s.get('/');
  assert.equal(html.status, 200);
  assert.match(html.headers['content-type'], /^text\/html/);
  const csp = html.headers['content-security-policy'];
  for (const part of ["default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self' data:", "connect-src 'self'", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'self'"]) {
    assert.ok(csp.includes(part), `CSP lacks ${part}`);
  }
  assert.equal(html.headers['referrer-policy'], 'no-referrer');
  assert.equal(html.headers['x-content-type-options'], 'nosniff');
  assert.match((await s.get('/app.js')).headers['content-type'], /javascript/);
  assert.match((await s.get('/lib.js')).headers['content-type'], /javascript/);
  assert.match((await s.get('/style.css')).headers['content-type'], /text\/css/);
  await s.stop();
});

test('static GUI: only the allowlisted files exist; traversal and extras are 404', async () => {
  const s = await boot();
  for (const p of ['/secret.txt', '/../src/manager.mjs', '/%2e%2e/src/manager.mjs', '/..%2fsrc/manager.mjs', '/app.js/../secret.txt', '//etc/passwd', '/index.html.bak']) {
    const r = await s.get(p);
    assert.equal(r.status, 404, p);
  }
  await s.stop();
});

test('GET /api/models lists the installed Ollama tags for the add-model form', async () => {
  const s = await boot();
  const r = await s.get('/api/models');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.models, ['lfm3:1.7b', 'lfm3:1.7b-100000']);
  assert.equal((await s.send('POST', '/api/models', {})).status, 405);
  await s.stop();
  const down = await boot({ manager: stubManager({ listModels: async () => { throw new ApiError(503, 'cannot list Ollama models: ECONNREFUSED'); } }) });
  const r2 = await down.get('/api/models');
  assert.equal(r2.status, 503);
  await down.stop();
});

test('unknown API path -> 404, wrong method -> 405', async () => {
  const s = await boot();
  assert.equal((await s.get('/api/nope')).status, 404);
  assert.equal((await s.send('DELETE', '/api/status')).status, 405);
  assert.equal((await s.send('POST', '/api/status', {})).status, 405);
  assert.equal((await s.send('GET', '/api/order')).status, 405);
  await s.stop();
});

test('auth: unknown Host is refused before anything is read', async () => {
  const s = await boot();
  const r = await request(s.port, { path: '/api/status', headers: { host: 'evil.example.com' } });
  assert.equal(r.status, 403);
  assert.equal(s.manager.calls.length, 0);
  await s.stop();
});

test('auth: a mutating request needs a matching Origin', async () => {
  const s = await boot();
  const missing = await request(s.port, { method: 'PUT', path: '/api/order', headers: { host: s.local.host, 'content-type': 'application/json' }, body: JSON.stringify({ order: ['a'] }) });
  assert.equal(missing.status, 403);
  const wrong = await s.send('PUT', '/api/order', { order: ['a'] }, { origin: 'https://evil.example.com' });
  assert.equal(wrong.status, 403);
  assert.equal(s.manager.calls.filter((c) => c[0] === 'setOrder').length, 0);
  await s.stop();
});

test('auth: proxy headers on the local host are refused', async () => {
  const s = await boot();
  const r = await s.get('/api/status', { 'cf-connecting-ip': '1.2.3.4' });
  assert.equal(r.status, 403);
  await s.stop();
});

test('PUT /api/order forwards the ids; a manager ApiError keeps its status and message', async () => {
  const s = await boot({ manager: stubManager({ setOrder: async () => { throw new ApiError(400, 'order must be a permutation of the workload ids'); } }) });
  const r = await s.send('PUT', '/api/order', { order: ['x'] });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /permutation/);
  await s.stop();
  const ok = await boot();
  const good = await ok.send('PUT', '/api/order', { order: ['lfm3', 'musetalk'] });
  assert.equal(good.status, 200);
  assert.deepEqual(ok.manager.calls.find((c) => c[0] === 'setOrder')[1], ['lfm3', 'musetalk']);
  await ok.stop();
});

test('settings, workloads and apply are routed to the manager', async () => {
  const s = await boot();
  assert.equal((await s.send('PUT', '/api/settings', { reservedMiB: 1600 })).status, 200);
  assert.deepEqual(s.manager.calls.find((c) => c[0] === 'setSettings')[1], { reservedMiB: 1600 });
  assert.equal((await s.send('POST', '/api/workloads', { id: 'a', tag: 'a:1b' })).status, 200);
  assert.equal(s.manager.calls.find((c) => c[0] === 'addWorkload')[1].id, 'a');
  assert.equal((await s.send('PUT', '/api/workloads/lfm3', { allowPartial: false })).status, 200);
  assert.deepEqual(s.manager.calls.find((c) => c[0] === 'updateWorkload').slice(1), ['lfm3', { allowPartial: false }]);
  assert.equal((await s.send('DELETE', '/api/workloads/tiny')).status, 200);
  assert.equal(s.manager.calls.find((c) => c[0] === 'removeWorkload')[1], 'tiny');
  assert.equal((await s.send('POST', '/api/apply')).status, 200);
  await s.stop();
});

test('workload ids in the path are validated, not passed through blindly', async () => {
  const s = await boot();
  for (const id of ['..', '%2e%2e', 'A', 'a%20b', 'x'.repeat(60), 'a%00b']) {
    const r = await s.send('DELETE', `/api/workloads/${id}`);
    assert.equal(r.status, 400, id);
  }
  assert.equal(s.manager.calls.filter((c) => c[0] === 'removeWorkload').length, 0);
  await s.stop();
});

test('request bodies: 64 KiB cap (413), bad JSON (400), wrong content type (415), non-object (400)', async () => {
  const s = await boot();
  const big = await request(s.port, { method: 'PUT', path: '/api/settings', headers: { host: s.local.host, origin: s.local.origin, 'content-type': 'application/json' }, body: JSON.stringify({ pad: 'x'.repeat(70 * 1024) }) });
  assert.equal(big.status, 413);
  const bad = await request(s.port, { method: 'PUT', path: '/api/settings', headers: { host: s.local.host, origin: s.local.origin, 'content-type': 'application/json' }, body: '{nope' });
  assert.equal(bad.status, 400);
  const type = await request(s.port, { method: 'PUT', path: '/api/settings', headers: { host: s.local.host, origin: s.local.origin, 'content-type': 'text/plain' }, body: '{}' });
  assert.equal(type.status, 415);
  const arr = await request(s.port, { method: 'PUT', path: '/api/settings', headers: { host: s.local.host, origin: s.local.origin, 'content-type': 'application/json' }, body: '[1]' });
  assert.equal(arr.status, 400);
  assert.equal(s.manager.calls.filter((c) => c[0] === 'setSettings').length, 0);
  await s.stop();
});

test('an unexpected manager error is a generic 500 with no message or stack leaked', async () => {
  const s = await boot({ manager: stubManager({ status: async () => { throw new Error('secret path /home/example/x'); } }) });
  const r = await s.get('/api/status');
  assert.equal(r.status, 500);
  assert.ok(!r.text.includes('secret'));
  assert.ok(!r.text.includes('/home/example'));
  await s.stop();
});

test('leases: local callers may omit Origin; a foreign Origin is still refused', async () => {
  const s = await boot();
  const noOrigin = await request(s.port, { method: 'POST', path: '/api/leases/musetalk/acquire', headers: { host: s.local.host, 'content-type': 'application/json' }, body: JSON.stringify({ holder: 'render-1' }) });
  assert.equal(noOrigin.status, 200);
  assert.equal(noOrigin.json.leaseId, 'L1');
  assert.equal(s.manager.calls.find((c) => c[0] === 'acquireLease')[1].holder, 'render-1');
  const foreign = await request(s.port, { method: 'POST', path: '/api/leases/musetalk/acquire', headers: { host: s.local.host, origin: 'https://evil.example.com', 'content-type': 'application/json' }, body: '{}' });
  assert.equal(foreign.status, 403);
  await s.stop();
});

test('leases: acquire/heartbeat/release pass their ids and options; busy and unknown map to 409/404', async () => {
  const seenRelease = [];
  const m = stubManager({
    acquireLease: async () => ({ ok: false, reason: 'busy: lease held by x' }),
    releaseLease: async (a) => { seenRelease.push(a); return { ok: false, reason: 'unknown or expired lease', code: 'unknown_lease' }; },
    heartbeatLease: async () => ({ ok: false, reason: 'unknown or expired lease', code: 'unknown_lease' }),
  });
  const s = await boot({ manager: m });
  const lease = (path, obj) => request(s.port, { method: 'POST', path, headers: { host: s.local.host, 'content-type': 'application/json' }, body: JSON.stringify(obj) });
  assert.equal((await lease('/api/leases/musetalk/acquire', { holder: 'a' })).status, 409);
  assert.equal((await lease('/api/leases/musetalk/release', { leaseId: 'zzz' })).status, 404);
  assert.equal((await lease('/api/leases/musetalk/heartbeat', { leaseId: 'zzz' })).status, 404);
  assert.equal((await lease('/api/leases/other/acquire', {})).status, 400, 'job ids are validated');
  for (const job of ['sd15', 'ltxvideo', 'flux2', 'sdxl', 'ltx098', 'immichvision']) assert.equal((await lease(`/api/leases/${job}/acquire`, { holder: 'a' })).status, 409, `${job} is a lease job`);
  assert.equal(seenRelease[0].leaseId, 'zzz');
  await s.stop();
});

test('leases: a client that disconnects while waiting does not leak the lease', async () => {
  let resolveAcquire;
  const m = stubManager({ acquireLease: () => new Promise((resolve) => { resolveAcquire = resolve; }) });
  const s = await boot({ manager: m });
  const http = await import('node:http');
  const req = http.request({ host: '127.0.0.1', port: s.port, method: 'POST', path: '/api/leases/musetalk/acquire', headers: { host: s.local.host, 'content-type': 'application/json' }, agent: false });
  req.on('error', () => {});
  req.end(JSON.stringify({ holder: 'gone' }));
  await sleep(100);
  req.destroy();
  await sleep(100);
  resolveAcquire({ ok: true, leaseId: 'LEAKED' });
  await sleep(100);
  const rel = m.calls.find((c) => c[0] === 'releaseLease');
  assert.ok(rel, 'the orphaned lease must be released');
  assert.equal(rel[1].leaseId, 'LEAKED');
  await s.stop();
});

// ---- Cloudflare Access (public host) ----------------------------------------------------------------------------

async function remoteBoot(extra = {}) {
  const key = makeKey();
  const authDeps = { fetchJwks: jwksFetcher([key]) };
  const s = await boot({ authDeps, ...extra });
  const remoteHeaders = (token) => ({ host: 'gpu.example.com', ...(token ? { 'cf-access-jwt-assertion': token } : {}) });
  return { s, key, remoteHeaders, token: (over = {}) => signToken({ key, ...over }) };
}

test('public host: no token -> 401, forged token -> 401, valid owner token -> 200', async () => {
  const { s, remoteHeaders, token } = await remoteBoot();
  assert.equal((await request(s.port, { path: '/api/status', headers: remoteHeaders() })).status, 401);
  assert.equal((await request(s.port, { path: '/api/status', headers: remoteHeaders('a.b.c') })).status, 401);
  const ok = await request(s.port, { path: '/api/status', headers: remoteHeaders(token()) });
  assert.equal(ok.status, 200);
  // A genuine Access token for someone who is not the owner is authenticated but not allowed: 403.
  const stranger = await request(s.port, { path: '/api/status', headers: remoteHeaders(token({ payload: { email: 'stranger@example.com' } })) });
  assert.equal(stranger.status, 403);
  await s.stop();
});

test('public host: mutating calls need the https Origin and still reach the manager', async () => {
  const { s, remoteHeaders, token } = await remoteBoot();
  const headers = { ...remoteHeaders(token()), origin: 'https://gpu.example.com', 'content-type': 'application/json' };
  const r = await request(s.port, { method: 'PUT', path: '/api/order', headers, body: JSON.stringify({ order: ['lfm3', 'musetalk'] }) });
  assert.equal(r.status, 200);
  const { origin: _dropped, ...withoutOrigin } = headers;
  const noOrigin = await request(s.port, { method: 'PUT', path: '/api/order', headers: withoutOrigin, body: JSON.stringify({ order: ['lfm3'] }) });
  assert.equal(noOrigin.status, 403);
  await s.stop();
});

test('public host: lease endpoints are 403 even with a valid token', async () => {
  const { s, remoteHeaders, token } = await remoteBoot();
  const headers = { ...remoteHeaders(token()), origin: 'https://gpu.example.com', 'content-type': 'application/json' };
  const r = await request(s.port, { method: 'POST', path: '/api/leases/musetalk/acquire', headers, body: '{}' });
  assert.equal(r.status, 403);
  assert.equal(s.manager.calls.filter((c) => c[0] === 'acquireLease').length, 0);
  await s.stop();
});

test('public host with missing Access configuration -> 503 for everything', async () => {
  const s = await boot({ config: { accessAud: '' } });
  const r = await request(s.port, { path: '/api/status', headers: { host: 'gpu.example.com' } });
  assert.equal(r.status, 503);
  const page = await request(s.port, { path: '/', headers: { host: 'gpu.example.com' } });
  assert.equal(page.status, 503);
  await s.stop();
});

test('the GUI itself also needs authentication (page and scripts)', async () => {
  const { s, remoteHeaders } = await remoteBoot();
  for (const p of ['/', '/app.js', '/style.css']) {
    assert.equal((await request(s.port, { path: p, headers: remoteHeaders() })).status, 401, p);
  }
  await s.stop();
});

// ---- real manager over the simulated machine --------------------------------------------------------------------

test('end to end over HTTP with the real manager: acquire, status, release', async () => {
  const { harness } = await import('./helpers/harness.mjs');
  const h = await harness({ start: true });
  await h.settle();
  const s = await boot({ manager: h.manager });
  const lease = (path, obj) => request(s.port, { method: 'POST', path, headers: { host: s.local.host, 'content-type': 'application/json' }, body: JSON.stringify(obj) });

  // Fake clock + real HTTP: tick the simulated clock while the acquire is pending.
  const pending = lease('/api/leases/musetalk/acquire', { holder: 'e2e', wait: false });
  for (let i = 0; i < 400 && !h.manager.getState; i += 1) await sleep(5);
  const timer = setInterval(() => { h.clock.advance(500); }, 5);
  const got = await pending;
  clearInterval(timer);
  assert.equal(got.status, 200, got.text);
  assert.ok(got.json.leaseId);

  const status = await s.get('/api/status');
  assert.equal(status.json.lease.state, 'active');
  assert.equal(status.json.workloads.find((w) => w.id === 'lfm3').planned.mode !== 'gpu', true);

  h.world.stopJob();
  const rel = await lease('/api/leases/musetalk/release', { leaseId: got.json.leaseId });
  assert.equal(rel.status, 200);
  await s.stop();
  await h.stop();
});
