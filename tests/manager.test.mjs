import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { harness, drainTimeout, until } from './helpers/harness.mjs';
import { LFM3 } from './helpers/world.mjs';

const cleanup = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()(); });

async function make(opts) {
  const h = await harness(opts);
  cleanup.push(() => h.stop());
  return h;
}

const sleepReal = (ms) => new Promise((r) => setTimeout(r, ms));

// Drive fake time (and real I/O) until a promise settles.
async function drive(h, promise, { stepMs = 500, maxSteps = 400 } = {}) {
  let done = false;
  let value;
  let error;
  promise.then((v) => { done = true; value = v; }, (e) => { done = true; error = e; });
  for (let i = 0; i < maxSteps && !done; i += 1) {
    await sleepReal(8);
    await h.clock.advance(stepMs);
  }
  if (!done) throw new Error('promise did not settle while driving the clock');
  if (error) throw error;
  return value;
}

const wl = (status, id) => status.workloads.find((w) => w.id === id);

test('startup: LFM3 goes fully onto the GPU, a warm copy stays on the CPU, router flips only after the preload', async () => {
  const h = await make();
  await h.manager.start();
  await h.settle();

  assert.ok(h.world.servers.gpu.loaded.has(LFM3));
  assert.ok(h.world.servers.cpu.loaded.has(LFM3));
  assert.equal(h.router.getPlan(LFM3).route, 'gpu');

  const loadGpu = h.journal.findIndex((j) => j.op === 'load' && j.instance === 'gpu');
  const flip = h.journal.findIndex((j) => j.op === 'route' && j.route === 'gpu');
  assert.ok(loadGpu >= 0 && flip > loadGpu, 'router must flip to gpu only after the GPU preload finished');

  const s = await h.manager.status();
  const lfm3 = wl(s, 'lfm3');
  assert.equal(lfm3.planned.mode, 'gpu');
  assert.equal(lfm3.actual.mode, 'gpu');
  assert.equal(lfm3.routed, 'gpu');
  assert.equal(wl(s, 'musetalk').planned.mode, 'idle');
  assert.equal(s.vram.totalMiB, 4096);
  assert.equal(s.pending.length, 0);
});

test('startup: little free VRAM -> partial variant is created, loaded on the GPU and routed with its tag', async () => {
  const h = await make({ world: { desktopMiB: 2900 } });
  await h.manager.start();
  await h.settle();

  const lfm3 = (await h.manager.status()).workloads.find((w) => w.id === 'lfm3');
  assert.equal(lfm3.planned.mode, 'partial');
  assert.equal(lfm3.planned.gpuLayers, 23);
  assert.deepEqual(h.router.getPlan(LFM3), { route: 'partial', variantTag: 'lfm3:1.7b-100000-g23' });
  assert.ok(h.world.servers.gpu.loaded.has('lfm3:1.7b-100000-g23'));
  assert.equal(lfm3.actual.mode, 'partial');
  assert.equal(lfm3.actual.gpuLayers, 23);
  assert.equal(h.ops('ensureVariant').length, 1);
});

test('lease acquire: CPU warm -> route away -> drain GPU -> unload; ok only once VRAM is really free', async () => {
  const h = await make();
  await h.manager.start();
  await h.settle();
  h.world.servers.cpu.loaded.clear(); // make the "ensure CPU has the model" step observable
  h.journal.length = 0;

  const r = await drive(h, h.manager.acquireLease({ holder: 'render-1' }));
  assert.equal(r.ok, true);
  assert.match(r.leaseId, /^[0-9a-f-]{36}$/);
  assert.ok(h.world.freeMiB() >= 2570, `free ${h.world.freeMiB()} MiB`);

  const order = ['load:cpu', 'route:cpu', 'drain:gpu', 'unload:gpu'].map((k) => {
    const [op, arg] = k.split(':');
    return h.journal.findIndex((j) => j.op === op && (j.instance === arg || j.route === arg || j.backend === arg));
  });
  assert.ok(order.every((i) => i >= 0), `missing step: ${JSON.stringify(order)}`);
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'steps happened out of order');
  assert.equal(h.router.getPlan(LFM3).route, 'cpu');
  assert.equal(h.journal.find((j) => j.op === 'drain').ms, 180_000);

  const s = await h.manager.status();
  assert.equal(wl(s, 'lfm3').planned.mode, 'cpu');
  assert.equal(wl(s, 'lfm3').actual.mode, 'cpu');
  assert.equal(wl(s, 'musetalk').planned.mode, 'gpu');
  assert.equal(s.lease.state, 'active');
});

test('blocked drain: nothing is killed, the transition stays pending with a clear reason, acquire times out and rolls back', async () => {
  const h = await make();
  await h.manager.start();
  await h.settle();
  h.router.drainImpl = async () => { throw drainTimeout(1); };
  h.journal.length = 0;

  const acquire = h.manager.acquireLease({ holder: 'render-2', timeoutSec: 30 });
  let sawPending = null;
  const watcher = (async () => {
    for (let i = 0; i < 100 && !sawPending; i += 1) {
      await sleepReal(8);
      const s = await h.manager.status();
      if (s.pending.length) sawPending = s.pending[0];
      await h.clock.advance(500);
    }
  })();
  const r = await drive(h, acquire);
  await watcher;

  assert.equal(r.ok, false);
  assert.match(r.reason, /still serving 1 request/);
  assert.ok(sawPending, 'pending transition was visible while blocked');
  assert.equal(sawPending.id, 'lfm3');
  assert.match(sawPending.blockedReason, /blocked: still serving 1 request\(s\)/);
  assert.equal(h.ops('unload').filter((j) => j.instance === 'gpu').length, 0, 'must never unload while requests are in flight');
  assert.ok(h.world.servers.gpu.loaded.has(LFM3), 'the model is still on the GPU');

  // Rolled back: the job lease is gone and LFM3 is routed to the GPU again without a reload.
  await h.settle();
  const s = await h.manager.status();
  assert.equal(s.lease, null);
  assert.equal(h.router.getPlan(LFM3).route, 'gpu');
  assert.equal(h.ops('load').filter((j) => j.instance === 'gpu').length, 0);
});

test('blocked drain is retried on a timer and completes once the requests finish', async () => {
  const h = await make();
  await h.manager.start();
  await h.settle();
  let attempts = 0;
  h.router.drainImpl = async () => { attempts += 1; if (attempts < 3) throw drainTimeout(2); };

  const r = await drive(h, h.manager.acquireLease({ holder: 'render-3', timeoutSec: 600 }));
  assert.equal(r.ok, true);
  assert.ok(attempts >= 3);
  assert.ok(!h.world.servers.gpu.loaded.has(LFM3));
});

test('release: placements are restored (LFM3 returns to the GPU) and the lease is gone', async () => {
  const h = await make();
  await h.manager.start();
  await h.settle();
  const r = await drive(h, h.manager.acquireLease({ holder: 'render-4' }));
  h.world.startJob(2570); // the renderer is using the GPU now
  assert.equal((await h.manager.status()).workloads.find((w) => w.id === 'lfm3').actual.mode, 'cpu');

  h.world.stopJob(); // renderer finished and freed its memory
  const rel = await h.manager.releaseLease({ leaseId: r.leaseId });
  assert.equal(rel.ok, true);
  await drive(h, h.manager.idle());
  await until(() => h.world.servers.gpu.loaded.has(LFM3));
  await h.settle();

  const s = await h.manager.status();
  assert.equal(s.lease, null);
  assert.equal(wl(s, 'lfm3').actual.mode, 'gpu');
  assert.equal(h.router.getPlan(LFM3).route, 'gpu');
});

test('acquire fails fast with a reason when the job cannot fit at all', async () => {
  const h = await make({ world: { desktopMiB: 2000 } });
  await h.manager.start();
  await h.settle();
  const r = await drive(h, h.manager.acquireLease({ holder: 'render-5' }));
  assert.equal(r.ok, false);
  assert.match(r.reason, /cannot fit|not enough/i);
  assert.equal((await h.manager.status()).lease, null);
});

test('only one lease at a time: a second acquire is busy, or waits when asked to', async () => {
  const h = await make();
  await h.manager.start();
  await h.settle();
  const first = await drive(h, h.manager.acquireLease({ holder: 'a' }));
  assert.equal(first.ok, true);

  const busy = await drive(h, h.manager.acquireLease({ holder: 'b' }));
  assert.equal(busy.ok, false);
  assert.match(busy.reason, /busy/i);

  const waiting = h.manager.acquireLease({ holder: 'b', wait: true, timeoutSec: 600 });
  await sleepReal(20);
  await h.manager.releaseLease({ leaseId: first.leaseId });
  const second = await drive(h, waiting);
  assert.equal(second.ok, true);
  assert.notEqual(second.leaseId, first.leaseId);
});

test('the studio image and video jobs can hold the lease under their own names and LFM3 steps aside', async () => {
  for (const jobId of ['sd15', 'ltxvideo']) {
    const h = await make();
    await h.manager.start();
    await h.settle();
    const got = await drive(h, h.manager.acquireLease({ holder: `studio-${jobId}`, jobId, wait: true, timeoutSec: 60 }));
    assert.equal(got.ok, true, JSON.stringify(got));
    let s = await h.manager.status();
    assert.equal(s.lease.jobId, jobId);
    assert.equal(wl(s, jobId).planned.mode, 'gpu');
    assert.equal(wl(s, 'musetalk').planned.mode, 'idle');
    const freed = await drive(h, h.manager.releaseLease({ leaseId: got.leaseId }));
    assert.equal(freed.ok, true);
    await h.settle();
    s = await h.manager.status();
    assert.equal(s.lease, null);
    assert.equal(wl(s, 'lfm3').planned.mode, 'gpu');
  }
});

test('an unlisted job id is still refused', async () => {
  const h = await make();
  await h.manager.start();
  const got = await h.manager.acquireLease({ holder: 'x', jobId: 'ghost' });
  assert.equal(got.ok, false);
  assert.match(got.reason, /unknown job/);
});
