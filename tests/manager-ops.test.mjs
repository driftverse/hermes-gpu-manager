import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { harness, until } from './helpers/harness.mjs';
import { LFM3, LFM3_SIZE } from './helpers/world.mjs';

const cleanup = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()(); });

async function make(opts) {
  const h = await harness(opts);
  cleanup.push(() => h.stop());
  return h;
}

const sleepReal = (ms) => new Promise((r) => setTimeout(r, ms));
const wl = (s, id) => s.workloads.find((w) => w.id === id);

async function drive(h, promise, { stepMs = 500, maxSteps = 400 } = {}) {
  let done = false; let value; let error;
  promise.then((v) => { done = true; value = v; }, (e) => { done = true; error = e; });
  for (let i = 0; i < maxSteps && !done; i += 1) { await sleepReal(8); await h.clock.advance(stepMs); }
  if (!done) throw new Error('did not settle');
  if (error) throw error;
  return value;
}

// Advance fake time in steps, letting real I/O catch up each step, until cond() holds.
async function advanceUntil(h, cond, { stepMs = 1000, maxSteps = 300 } = {}) {
  for (let i = 0; i < maxSteps; i += 1) {
    if (await cond()) return;
    await sleepReal(8);
    await h.clock.advance(stepMs);
  }
  throw new Error('condition not reached');
}

const steady = async (opts) => {
  const h = await make({ ...opts, start: false });
  await h.manager.start();
  await h.settle();
  return h;
};

// ---- dwell -------------------------------------------------------------------------------------

test('dwell: a non-forced placement change right after another is held, then applied once the dwell has passed', async () => {
  const h = await steady();
  await h.clock.advance(1000);
  h.journal.length = 0;

  await h.manager.setSettings({ reservedMiB: 3296 }); // wants a partial split now
  await h.settle();
  let s = await h.manager.status();
  assert.equal(wl(s, 'lfm3').planned.mode, 'partial');
  assert.equal(wl(s, 'lfm3').actual.mode, 'gpu', 'nothing moved yet');
  assert.match(s.pending[0].blockedReason, /holding .*s/i);
  assert.equal(h.ops('unload').length, 0);
  assert.equal(h.ops('drain').length, 0);

  await advanceUntil(h, async () => wl(await h.manager.status(), 'lfm3').actual.mode === 'partial', { stepMs: 5000, maxSteps: 40 });
  await h.settle();
  s = await h.manager.status();
  assert.equal(wl(s, 'lfm3').actual.gpuLayers, 16);
  assert.equal(s.pending.length, 0);
});

test('dwell: POST /api/apply (force) and leases bypass the dwell', async () => {
  const h = await steady();
  await h.clock.advance(1000);
  await h.manager.setSettings({ reservedMiB: 3296 });
  await h.settle();
  assert.equal(wl(await h.manager.status(), 'lfm3').actual.mode, 'gpu');
  await h.manager.apply({ force: true });
  await h.settle();
  assert.equal(wl(await h.manager.status(), 'lfm3').actual.mode, 'partial');
});

// ---- drift + backoff -----------------------------------------------------------------------

test('drift: a model evicted from the GPU outside our control is reloaded and the drift is logged', async () => {
  const h = await steady();
  h.world.servers.gpu.loaded.delete(LFM3);
  await h.manager.reconcile();
  await h.settle();
  assert.ok(h.world.servers.gpu.loaded.has(LFM3));
  const s = await h.manager.status();
  assert.ok(s.events.some((e) => e.type === 'drift' && /LFM3/.test(e.message)), JSON.stringify(s.events.map((e) => e.type)));
});

test('drift: Ollama placing fewer layers than planned is detected and corrected', async () => {
  const h = await steady();
  const entry = h.world.servers.gpu.loaded.get(LFM3);
  entry.sizeVram = Math.floor(LFM3_SIZE / 2); // half on the GPU, not what we planned
  await h.manager.reconcile();
  await h.settle();
  const s = await h.manager.status();
  assert.equal(wl(s, 'lfm3').actual.mode, 'gpu');
  assert.ok(h.ops('unload').some((j) => j.instance === 'gpu'));
});

test('drift: a missing CPU warm copy is restored', async () => {
  const h = await steady();
  h.world.servers.cpu.loaded.clear();
  await h.manager.reconcile();
  await h.settle();
  assert.ok(h.world.servers.cpu.loaded.has(LFM3));
});

test('preload failure: router is NOT flipped to the GPU; retried with backoff, then succeeds', async () => {
  const h = await make();
  h.world.servers.gpu.fail['/api/generate'] = 500;
  await h.manager.start();
  await h.settle();
  assert.ok(!h.journal.some((j) => j.op === 'route' && j.route === 'gpu'));
  let s = await h.manager.status();
  assert.match(s.pending[0].blockedReason, /error: .*500/);
  const attempts = h.ops('load').filter((j) => j.instance === 'gpu').length;

  await h.manager.reconcile(); // too soon: backoff
  await h.settle();
  assert.equal(h.ops('load').filter((j) => j.instance === 'gpu').length, attempts);

  delete h.world.servers.gpu.fail['/api/generate'];
  await advanceUntil(h, async () => h.router.getPlan(LFM3)?.route === 'gpu', { stepMs: 2000, maxSteps: 30 });
  await h.settle();
  s = await h.manager.status();
  assert.equal(wl(s, 'lfm3').actual.mode, 'gpu');
  assert.equal(s.pending.length, 0);
});

// ---- waiting for memory / CPU safety / probe ------------------------------------------------

test('moves onto the GPU only when free VRAM really exists; waits and then loads', async () => {
  const h = await make();
  h.world.startJob(2570); // something outside our control holds the GPU
  await h.manager.setSettings({ gpuTotalMiB: 8192 }).catch(() => {});
  await h.manager.start();
  await h.manager.setSettings({ gpuTotalMiB: 8192 });
  await h.settle();
  const s = await h.manager.status();
  assert.equal(wl(s, 'lfm3').planned.mode, 'gpu');
  assert.match(s.pending[0].blockedReason, /waiting for GPU memory \(need 1200 MiB, 26 MiB free\)/);
  assert.equal(h.ops('load').filter((j) => j.instance === 'gpu').length, 0, 'must not even try to load');
  assert.ok(!h.world.servers.gpu.loaded.has(LFM3));

  h.world.stopJob();
  await h.manager.apply({ force: true });
  await h.settle();
  assert.ok(h.world.servers.gpu.loaded.has(LFM3));
  assert.equal(h.router.getPlan(LFM3).route, 'gpu');
});

test('never leaves the GPU unless the CPU instance really holds the model', async () => {
  const h = await steady();
  h.world.servers.cpu.loaded.clear();
  h.world.servers.cpu.fail['/api/generate'] = 500;
  const r = await drive(h, h.manager.acquireLease({ holder: 'x', timeoutSec: 20 }));
  assert.equal(r.ok, false);
  assert.match(r.reason, /CPU instance could not load/);
  assert.ok(h.world.servers.gpu.loaded.has(LFM3), 'GPU copy untouched');
  assert.equal(h.ops('drain').length, 0);
  assert.equal(h.ops('unload').length, 0);
});

test('probe outage: plan uses the fallback size, GPU moves are blocked with a clear reason, recovery converges', async () => {
  const h = await make();
  h.world.nvidiaDown = true;
  await h.manager.start();
  await h.settle();
  let s = await h.manager.status();
  assert.equal(s.vram.ok, false);
  assert.match(s.vram.error, /NVML/);
  assert.equal(s.vram.totalMiB, 4096);
  assert.match(s.pending[0].blockedReason, /GPU probe unavailable/);
  assert.ok(s.events.some((e) => e.type === 'probe'));

  h.world.nvidiaDown = false;
  await h.manager.apply({ force: true });
  await h.settle();
  s = await h.manager.status();
  assert.equal(s.vram.ok, true);
  assert.equal(wl(s, 'lfm3').actual.mode, 'gpu');
});

test('reserveWhenIdle keeps the GPU reserved for MuseTalk even without a lease', async () => {
  const h = await steady();
  await h.manager.setSettings({ reserveWhenIdle: { musetalk: true } });
  await h.manager.apply({ force: true });
  await h.settle();
  const s = await h.manager.status();
  assert.equal(wl(s, 'musetalk').planned.mode, 'gpu');
  assert.equal(wl(s, 'lfm3').planned.mode, 'cpu');
  assert.equal(wl(s, 'lfm3').actual.mode, 'cpu');
  assert.equal(s.lease, null);
});

// ---- leases: ttl + heartbeat -----------------------------------------------------------------

test('lease expires without heartbeats and placements are restored; heartbeats keep it alive', async () => {
  const h = await make({ mutate: (s) => { s.settings.leaseTtlSec = 30; } });
  await h.manager.start();
  await h.settle();
  const r = await drive(h, h.manager.acquireLease({ holder: 'crashy' }));
  assert.equal(r.ok, true);

  await h.clock.advance(20_000);
  assert.deepEqual(await h.manager.heartbeatLease({ leaseId: r.leaseId }), { ok: true, expiresInSec: 30 });
  await h.clock.advance(20_000);
  await h.manager.reconcile();
  assert.ok((await h.manager.status()).lease, 'still alive thanks to the heartbeat');

  await advanceUntil(h, async () => (await h.manager.status()).lease === null, { stepMs: 5000, maxSteps: 30 });
  await advanceUntil(h, async () => h.world.servers.gpu.loaded.has(LFM3), { stepMs: 2000, maxSteps: 40 });
  await h.settle();
  const s = await h.manager.status();
  assert.ok(s.events.some((e) => e.type === 'lease' && /expired/i.test(e.message)));
  assert.equal(wl(s, 'lfm3').actual.mode, 'gpu');
  assert.deepEqual(await h.manager.heartbeatLease({ leaseId: r.leaseId }), { ok: false, reason: 'unknown or expired lease', code: 'unknown_lease' });
  assert.equal((await h.manager.releaseLease({ leaseId: r.leaseId })).ok, false);
});

// ---- CRUD ----------------------------------------------------------------------------------

test('setOrder: must be a permutation; persists; a new order changes who wins the GPU', async () => {
  const h = await steady();
  await assert.rejects(h.manager.setOrder(['lfm3']), (e) => e.status === 400 && /permutation/.test(e.message));
  await assert.rejects(h.manager.setOrder(['lfm3', 'lfm3']), /permutation/);
  await assert.rejects(h.manager.setOrder('lfm3'), /array/);
  await h.manager.setOrder(['lfm3', 'musetalk', 'sd15', 'ltxvideo', 'flux2', 'sdxl', 'ltx098', 'immichvision']);
  assert.deepEqual((await h.store.load()).state.order, ['lfm3', 'musetalk', 'sd15', 'ltxvideo', 'flux2', 'sdxl', 'ltx098', 'immichvision']);
  const r = await drive(h, h.manager.acquireLease({ holder: 'x' }));
  assert.equal(r.ok, false);
  assert.match(r.reason, /cannot fit/);
  assert.equal(wl(await h.manager.status(), 'lfm3').actual.mode, 'gpu');
});

test('setSettings: validates, rejects unknown keys, persists', async () => {
  const h = await steady();
  await assert.rejects(h.manager.setSettings({ reservedMiB: -5 }), (e) => e.status === 400 && /reservedMiB/.test(e.message));
  await assert.rejects(h.manager.setSettings({ nope: 1 }), /unknown setting/);
  await assert.rejects(h.manager.setSettings({ reserveWhenIdle: { lfm3: true } }), /job/);
  const out = await h.manager.setSettings({ drainTimeoutSec: 90, gpuTotalMiB: null });
  assert.equal(out.settings.drainTimeoutSec, 90);
  assert.equal((await h.store.load()).state.settings.drainTimeoutSec, 90);
});

test('addWorkload: tag must exist on the CPU instance; fields validated; appended, persisted, planned and warmed', async () => {
  const h = await steady();
  h.world.catalog.set('qwen3:4b', { name: 'qwen3:4b', size: 2_000_000_000, layers: 36, numCtx: 8192, base: null });
  const def = { id: 'qwen3', name: 'Qwen3 4B', tag: 'qwen3:4b', layers: 36, fullGpuMiB: 2000, minUsefulGpuMiB: 600, allowPartial: false };

  await assert.rejects(h.manager.addWorkload({ ...def, tag: 'ghost:1b' }), (e) => e.status === 400 && /not found in Ollama/i.test(e.message));
  await assert.rejects(h.manager.addWorkload({ ...def, id: 'Bad Id' }), /id/);
  await assert.rejects(h.manager.addWorkload({ ...def, tag: LFM3 }), /already/i);
  await assert.rejects(h.manager.addWorkload({ ...def, id: 'lfm3' }), /already/i);
  await assert.rejects(h.manager.addWorkload({ ...def, layers: undefined, allowPartial: true }), /layers/);
  await assert.rejects(h.manager.addWorkload({ ...def, kind: 'job' }), /kind/);

  await h.manager.addWorkload(def);
  await h.settle();
  assert.deepEqual((await h.store.load()).state.order, ['musetalk', 'sd15', 'ltxvideo', 'flux2', 'sdxl', 'ltx098', 'immichvision', 'lfm3', 'qwen3']);
  const s = await h.manager.status();
  assert.equal(wl(s, 'qwen3').priority, s.workloads.length);
  assert.equal(wl(s, 'qwen3').planned.mode, 'cpu'); // 1396 MiB left after LFM3, no partial allowed
  assert.equal(wl(s, 'qwen3').actual.mode, 'cpu');
  assert.ok(h.world.servers.cpu.loaded.has('qwen3:4b'));
});

test('removeWorkload: built-ins are protected; custom ones are drained, unloaded and forgotten', async () => {
  const h = await steady();
  await assert.rejects(h.manager.removeWorkload('lfm3'), (e) => e.status === 403 && /built-in/i.test(e.message));
  await assert.rejects(h.manager.removeWorkload('musetalk'), /built-in/i);
  await assert.rejects(h.manager.removeWorkload('ghost'), (e) => e.status === 404);

  h.world.catalog.set('tiny:1b', { name: 'tiny:1b', size: 500_000_000, layers: 16, numCtx: 4096, base: null });
  await h.manager.addWorkload({ id: 'tiny', name: 'Tiny', tag: 'tiny:1b', layers: 16, fullGpuMiB: 400, minUsefulGpuMiB: 100, allowPartial: true });
  await h.settle();
  assert.ok(h.world.servers.gpu.loaded.has('tiny:1b'));

  h.journal.length = 0;
  await h.manager.removeWorkload('tiny');
  await h.settle();
  assert.ok(!h.world.servers.gpu.loaded.has('tiny:1b'));
  assert.ok(!h.world.servers.cpu.loaded.has('tiny:1b'));
  assert.equal(h.router.getPlan('tiny:1b'), null);
  assert.ok(h.journal.findIndex((j) => j.op === 'drain') < h.journal.findIndex((j) => j.op === 'unload'));
  assert.deepEqual((await h.store.load()).state.order, ['musetalk', 'sd15', 'ltxvideo', 'flux2', 'sdxl', 'ltx098', 'immichvision', 'lfm3']);
});

test('updateWorkload: allowPartial and sizes can be edited; tag and id cannot', async () => {
  const h = await steady();
  const out = await h.manager.updateWorkload('lfm3', { allowPartial: false });
  assert.equal(out.workload.allowPartial, false);
  assert.equal((await h.store.load()).state.workloads.lfm3.allowPartial, false);
  await assert.rejects(h.manager.updateWorkload('lfm3', { tag: 'other:1b' }), /cannot be changed|unknown field/i);
  await assert.rejects(h.manager.updateWorkload('lfm3', { id: 'x' }), /cannot be changed|unknown field/i);
  await assert.rejects(h.manager.updateWorkload('lfm3', { fullGpuMiB: 0 }), (e) => e.status === 400);
  await assert.rejects(h.manager.updateWorkload('ghost', { allowPartial: true }), (e) => e.status === 404);
});

// ---- status + state recovery ---------------------------------------------------------------

test('status: backend health, vram numbers, router counters and the event log are all reported', async () => {
  const h = await steady();
  await h.world.servers.cpu.stop();
  const s = await h.manager.status();
  assert.equal(s.backends.gpu.up, true);
  assert.equal(s.backends.cpu.up, false);
  assert.match(s.backends.cpu.error, /ECONNREFUSED/);
  assert.equal(s.vram.totalMiB, 4096);
  assert.equal(s.vram.usedMiB, 1500 + Math.ceil(LFM3_SIZE / 1048576));
  assert.equal(s.vram.externalMiB, 1500);
  assert.equal(s.vram.reservedMiB, 1500);
  assert.ok(s.router.totals && s.router.inflight);
  assert.ok(Array.isArray(s.events) && s.events.length > 0);
  assert.ok(s.events.every((e) => typeof e.t === 'number' && typeof e.message === 'string'));
  assert.ok(s.events.some((e) => e.type === 'backend' && /CPU/.test(e.message)));
  h.world.servers.cpu.stop = async () => {}; // already stopped
});

test('state recovery: a corrupt state file is reported in the event log and defaults are used', async () => {
  const h = await make();
  await writeFile(join(h.dir, 'state.json'), '{{{ nope');
  await h.manager.start();
  await h.settle();
  const s = await h.manager.status();
  assert.ok(s.events.some((e) => e.type === 'state' && /state\.json\.bad/.test(e.message)));
  assert.deepEqual(s.workloads.map((w) => w.id), ['musetalk', 'sd15', 'ltxvideo', 'flux2', 'sdxl', 'ltx098', 'immichvision', 'lfm3']);
});

test('the event log never grows past 100 entries', async () => {
  const h = await steady();
  for (let i = 0; i < 150; i += 1) await h.manager.setSettings({ reservedMiB: 1500 + (i % 2) * 1600 }).catch(() => {});
  assert.ok((await h.manager.status()).events.length <= 100);
  void until;
});

// ---- split that cannot load ----------------------------------------------------------------------

test('split load fails (compute buffers do not fit): LFM3 settles on the CPU, says why, and does not retry every cycle', async () => {
  const h = await make({ world: { desktopMiB: 2900 } });
  h.world.servers.gpu.failLoad.add('lfm3:1.7b-100000-g23');
  await h.manager.start();
  await h.settle();
  await advanceUntil(h, async () => wl(await h.manager.status(), 'lfm3').actual.mode === 'cpu', { stepMs: 5000, maxSteps: 60 });

  let s = await h.manager.status();
  assert.equal(wl(s, 'lfm3').actual.mode, 'cpu');
  assert.equal(wl(s, 'lfm3').routed, 'cpu');
  assert.equal(wl(s, 'lfm3').planned.mode, 'cpu', 'the plan matches reality instead of nagging about a split that cannot happen');
  assert.equal(wl(s, 'lfm3').matches, true);
  assert.equal(s.pending.length, 0);
  assert.ok(s.events.some((e) => e.level === 'warn' && /split/i.test(e.message) && /CPU/.test(e.message)), 'event explains the fallback');

  const attempts = h.world.log.filter((l) => l.role === 'gpu' && l.path === '/api/generate' && l.body.model === 'lfm3:1.7b-100000-g23' && l.body.keep_alive !== 0).length;
  await h.clock.advance(10 * 60 * 1000);
  await h.settle();
  const later = h.world.log.filter((l) => l.role === 'gpu' && l.path === '/api/generate' && l.body.model === 'lfm3:1.7b-100000-g23' && l.body.keep_alive !== 0).length;
  assert.equal(later, attempts, 'no further split attempts while memory is unchanged');
});

test('split load failed earlier: when clearly more GPU memory frees up, the model is tried on the GPU again', async () => {
  const h = await make({ world: { desktopMiB: 2900 } });
  h.world.servers.gpu.failLoad.add('lfm3:1.7b-100000-g23');
  await h.manager.start();
  await h.settle();
  await advanceUntil(h, async () => wl(await h.manager.status(), 'lfm3').actual.mode === 'cpu', { stepMs: 5000, maxSteps: 60 });

  h.world.servers.gpu.failLoad.clear();
  h.world.desktopMiB = 1500; // the desktop gave memory back: now there is room for everything
  await h.manager.apply({ force: true });
  await advanceUntil(h, async () => wl(await h.manager.status(), 'lfm3').actual.mode === 'gpu', { stepMs: 5000, maxSteps: 60 });
  assert.equal(wl(await h.manager.status(), 'lfm3').routed, 'gpu');
});
