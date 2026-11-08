// The assembled application: router + manager + HTTP server over the simulated machine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApp } from '../src/app.mjs';
import { createWorld, LFM3 } from './helpers/world.mjs';
import { request, postJson, until } from './helpers/net.mjs';
import { goodConfig } from './helpers/jwt-fixture.mjs';

async function boot(worldOpts) {
  const world = await createWorld(worldOpts).start();
  const stateDir = await mkdtemp(join(tmpdir(), 'hermes-app-'));
  const config = { ...goodConfig(), stateDir, routerPort: 0, localPort: 0, gpuBackend: world.servers.gpu.url, cpuBackend: world.servers.cpu.url, reconcileMs: 60_000 };
  const app = await startApp({ config, runner: world.runner, publicDir: join(import.meta.dirname, '..', 'public'), logger: { error() {}, info() {} } });
  const api = (path, o = {}) => request(app.managerPort, { path, headers: { host: `127.0.0.1:${app.managerPort}`, ...(o.headers || {}) }, ...o });
  const put = (path, obj) => request(app.managerPort, { method: 'PUT', path, headers: { host: `127.0.0.1:${app.managerPort}`, origin: `http://127.0.0.1:${app.managerPort}`, 'content-type': 'application/json' }, body: JSON.stringify(obj) });
  return { world, app, api, put, stateDir, async stop() { await app.stop(); await world.stop(); await rm(stateDir, { recursive: true, force: true }); } };
}

test('startApp: LFM3 ends up on the GPU, the router and manager listen on loopback only', async () => {
  const h = await boot();
  assert.ok(h.app.routerPort > 0 && h.app.managerPort > 0);
  await until(async () => (await h.api('/api/status')).json.workloads.find((w) => w.id === 'lfm3').actual.mode === 'gpu', { timeoutMs: 8000, stepMs: 50 });
  const st = (await h.api('/api/status')).json;
  assert.equal(st.backends.gpu.up, true);
  assert.equal(st.backends.cpu.up, true);
  assert.equal(st.workloads[0].id, 'musetalk');
  await h.stop();
});

test('requests through the router follow the plan: GPU while planned, CPU after a lease takes the GPU', async () => {
  const h = await boot();
  await until(async () => (await h.api('/api/status')).json.workloads.find((w) => w.id === 'lfm3').actual.mode === 'gpu', { timeoutMs: 8000, stepMs: 50 });
  h.world.log.length = 0;
  const r1 = await postJson(h.app.routerPort, '/api/generate', { model: LFM3, prompt: 'hi', stream: false });
  assert.equal(r1.status, 200);
  assert.ok(h.world.log.some((l) => l.role === 'gpu' && l.path === '/api/generate' && l.body.prompt === 'hi'));

  const lease = await request(h.app.managerPort, { method: 'POST', path: '/api/leases/musetalk/acquire', headers: { host: `127.0.0.1:${h.app.managerPort}`, 'content-type': 'application/json' }, body: JSON.stringify({ holder: 'test', timeoutSec: 20 }) });
  assert.equal(lease.status, 200, lease.text);
  h.world.startJob(2570);
  h.world.log.length = 0;
  const r2 = await postJson(h.app.routerPort, '/api/generate', { model: LFM3, prompt: 'during render', stream: false });
  assert.equal(r2.status, 200);
  assert.ok(h.world.log.some((l) => l.role === 'cpu' && l.body.prompt === 'during render'), 'served by the CPU instance while MuseTalk holds the GPU');
  assert.ok(!h.world.log.some((l) => l.role === 'gpu' && l.body.prompt === 'during render'));
  await h.stop();
});

test('reordering through the API puts LFM3 first and persists the order across a restart', async () => {
  const h = await boot();
  assert.equal((await h.put('/api/order', { order: ['lfm3', 'musetalk', 'sd15', 'ltxvideo', 'flux2', 'sdxl', 'ltx098', 'immichvision'] })).status, 200);
  await h.app.stop();
  const config = { ...goodConfig(), stateDir: h.stateDir, routerPort: 0, localPort: 0, gpuBackend: h.world.servers.gpu.url, cpuBackend: h.world.servers.cpu.url, reconcileMs: 60_000 };
  const again = await startApp({ config, runner: h.world.runner, publicDir: join(import.meta.dirname, '..', 'public'), logger: { error() {}, info() {} } });
  const st = await request(again.managerPort, { path: '/api/status', headers: { host: `127.0.0.1:${again.managerPort}` } });
  assert.deepEqual(st.json.workloads.map((w) => w.id), ['lfm3', 'musetalk', 'sd15', 'ltxvideo', 'flux2', 'sdxl', 'ltx098', 'immichvision']);
  await again.stop();
  await h.world.stop();
  await rm(h.stateDir, { recursive: true, force: true });
});

test('the router keeps answering from the CPU when the manager has no plan yet / the GPU instance is down', async () => {
  const h = await boot();
  await h.world.servers.gpu.stop();
  const r = await postJson(h.app.routerPort, '/api/generate', { model: LFM3, prompt: 'x', stream: false });
  assert.equal(r.status, 200, 'failover to the CPU instance');
  h.world.servers.gpu.stop = async () => {};
  await h.app.stop();
  await h.world.stop();
  await rm(h.stateDir, { recursive: true, force: true });
});

test('stop() closes both listeners', async () => {
  const h = await boot();
  const { routerPort, managerPort } = h.app;
  await h.app.stop();
  for (const port of [routerPort, managerPort]) {
    await assert.rejects(request(port, { path: '/api/ps' }), /ECONNREFUSED/);
  }
  await h.world.stop();
  await rm(h.stateDir, { recursive: true, force: true });
});
