import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planWorkloads } from '../src/planner.mjs';

const musetalk = { id: 'musetalk', kind: 'job', fullGpuMiB: 2570, allowPartial: false, active: true, minUsefulGpuMiB: 2570 };
const lfm3 = { id: 'lfm3', kind: 'ollama', fullGpuMiB: 1200, layers: 24, allowPartial: true, active: true, minUsefulGpuMiB: 400 };

const byId = (result) => Object.fromEntries(result.placements.map((p) => [p.id, p]));

test('a single active workload that fits gets full GPU', () => {
  const r = planWorkloads({ workloads: [lfm3], gpuTotalMiB: 4096, reservedMiB: 1500 });
  const p = byId(r).lfm3;
  assert.equal(p.mode, 'gpu');
  assert.equal(p.gpuMiB, 1200);
  assert.equal(p.gpuLayers, null);
  assert.match(p.reason, /fits/i);
  assert.equal(r.freeMiB, 4096 - 1500 - 1200);
});

test('higher priority job takes the GPU; lower resident falls to CPU with nothing left', () => {
  const r = planWorkloads({ workloads: [musetalk, lfm3], gpuTotalMiB: 4096, reservedMiB: 1500 });
  const p = byId(r);
  assert.equal(p.musetalk.mode, 'gpu');
  assert.equal(p.musetalk.gpuMiB, 2570);
  assert.equal(p.lfm3.mode, 'cpu');
  assert.equal(p.lfm3.gpuMiB, 0);
  assert.equal(p.lfm3.gpuLayers, 0);
  assert.match(p.lfm3.reason, /musetalk|higher|left/i);
});

test('inactive workload is idle with 0 and does not consume budget', () => {
  const r = planWorkloads({
    workloads: [{ ...musetalk, active: false }, lfm3],
    gpuTotalMiB: 4096,
    reservedMiB: 1500,
  });
  const p = byId(r);
  assert.equal(p.musetalk.mode, 'idle');
  assert.equal(p.musetalk.gpuMiB, 0);
  assert.equal(p.lfm3.mode, 'gpu');
});

test('partial offload when allowed and above the minimum useful size', () => {
  const p = byId(planWorkloads({ workloads: [lfm3], gpuTotalMiB: 4096, reservedMiB: 3296 })).lfm3;
  assert.equal(p.mode, 'partial');
  assert.equal(p.gpuMiB, 800);
  assert.equal(p.gpuLayers, 16);
  assert.match(p.reason, /16 of 24 layers/);
});

test('below minUsefulGpuMiB goes to CPU even if partial is allowed', () => {
  const p = byId(planWorkloads({ workloads: [lfm3], gpuTotalMiB: 4096, reservedMiB: 3796 })).lfm3; // 300 left
  assert.equal(p.mode, 'cpu');
  assert.equal(p.gpuMiB, 0);
});

test('partial not allowed -> cpu', () => {
  const r = planWorkloads({ workloads: [{ ...lfm3, allowPartial: false }], gpuTotalMiB: 4096, reservedMiB: 3296 });
  assert.equal(byId(r).lfm3.mode, 'cpu');
});

test('partial layer count is never 0 and never full', () => {
  const tiny = { ...lfm3, minUsefulGpuMiB: 1 };
  const low = byId(planWorkloads({ workloads: [tiny], gpuTotalMiB: 4096, reservedMiB: 4096 - 5 })).lfm3;
  assert.equal(low.mode, 'partial');
  assert.equal(low.gpuLayers, 1);
  const high = byId(planWorkloads({ workloads: [tiny], gpuTotalMiB: 4096, reservedMiB: 4096 - 1199 })).lfm3;
  assert.equal(high.mode, 'partial');
  assert.equal(high.gpuLayers, 23);
});

test('partial requires a known layer count of at least 2', () => {
  const noLayers = { ...lfm3, layers: undefined };
  assert.equal(byId(planWorkloads({ workloads: [noLayers], gpuTotalMiB: 4096, reservedMiB: 3296 })).lfm3.mode, 'cpu');
  const oneLayer = { ...lfm3, layers: 1 };
  assert.equal(byId(planWorkloads({ workloads: [oneLayer], gpuTotalMiB: 4096, reservedMiB: 3296 })).lfm3.mode, 'cpu');
});

test('externalUsedMiB larger than reserved shrinks the budget; smaller does not grow it', () => {
  const bigger = planWorkloads({ workloads: [lfm3], gpuTotalMiB: 4096, reservedMiB: 1500, externalUsedMiB: 3296 });
  assert.equal(byId(bigger).lfm3.mode, 'partial');
  const smaller = planWorkloads({ workloads: [lfm3], gpuTotalMiB: 4096, reservedMiB: 1500, externalUsedMiB: 200 });
  assert.equal(smaller.budgetMiB, 4096 - 1500);
});

test('order matters: swapping priority swaps who gets the GPU', () => {
  const a = byId(planWorkloads({ workloads: [musetalk, lfm3], gpuTotalMiB: 4096, reservedMiB: 1500 }));
  const b = byId(planWorkloads({ workloads: [lfm3, musetalk], gpuTotalMiB: 4096, reservedMiB: 1500 }));
  assert.equal(a.musetalk.mode, 'gpu');
  assert.equal(a.lfm3.mode, 'cpu');
  assert.equal(b.lfm3.mode, 'gpu');
  assert.equal(b.musetalk.mode, 'cpu'); // non-partial job with 1396 left
});

test('upgrading the GPU lets lower workloads move up', () => {
  const small = byId(planWorkloads({ workloads: [musetalk, lfm3], gpuTotalMiB: 4096, reservedMiB: 1500 }));
  const big = byId(planWorkloads({ workloads: [musetalk, lfm3], gpuTotalMiB: 8192, reservedMiB: 1500 }));
  assert.equal(small.lfm3.mode, 'cpu');
  assert.equal(big.lfm3.mode, 'gpu');
  assert.equal(big.musetalk.mode, 'gpu');
});

test('four workloads cascade down the list', () => {
  const mk = (id, full, extra = {}) => ({ id, kind: 'ollama', fullGpuMiB: full, layers: 20, allowPartial: true, active: true, minUsefulGpuMiB: 200, ...extra });
  const r = byId(planWorkloads({
    workloads: [mk('a', 1000), mk('b', 1000), mk('c', 1000), mk('d', 1000)],
    gpuTotalMiB: 3000,
    reservedMiB: 0,
  }));
  assert.deepEqual([r.a.mode, r.b.mode, r.c.mode, r.d.mode], ['gpu', 'gpu', 'gpu', 'cpu']);
  const r2 = byId(planWorkloads({
    workloads: [mk('a', 1000), mk('b', 1000), mk('c', 1000), mk('d', 1000)],
    gpuTotalMiB: 2500,
    reservedMiB: 0,
  }));
  assert.deepEqual([r2.a.mode, r2.b.mode, r2.c.mode, r2.d.mode], ['gpu', 'gpu', 'partial', 'cpu']);
  assert.equal(r2.c.gpuMiB, 500);
  assert.equal(r2.c.gpuLayers, 10);
});

test('negative or oversubscribed budgets never go below zero', () => {
  const r = planWorkloads({ workloads: [musetalk, lfm3], gpuTotalMiB: 1000, reservedMiB: 1500 });
  assert.equal(r.budgetMiB, 0);
  assert.equal(r.freeMiB, 0);
  for (const p of r.placements) assert.equal(p.gpuMiB, 0);
});

test('property: total allocation never exceeds budget, over many random inputs', () => {
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  for (let i = 0; i < 2000; i += 1) {
    const n = 1 + Math.floor(rnd() * 5);
    const workloads = Array.from({ length: n }, (_, k) => ({
      id: `w${k}`,
      kind: rnd() < 0.5 ? 'job' : 'ollama',
      fullGpuMiB: 100 + Math.floor(rnd() * 3000),
      layers: rnd() < 0.8 ? 2 + Math.floor(rnd() * 60) : undefined,
      allowPartial: rnd() < 0.6,
      active: rnd() < 0.8,
      minUsefulGpuMiB: Math.floor(rnd() * 800),
    }));
    const gpuTotalMiB = Math.floor(rnd() * 12000);
    const reservedMiB = Math.floor(rnd() * 3000);
    const externalUsedMiB = rnd() < 0.5 ? Math.floor(rnd() * 3000) : 0;
    const r = planWorkloads({ workloads, gpuTotalMiB, reservedMiB, externalUsedMiB });
    const used = r.placements.reduce((s, p) => s + p.gpuMiB, 0);
    assert.ok(used <= r.budgetMiB, `used ${used} > budget ${r.budgetMiB}`);
    assert.equal(r.freeMiB, r.budgetMiB - used);
    assert.equal(r.placements.length, n);
    r.placements.forEach((p, k) => {
      const w = workloads[k];
      assert.equal(p.id, w.id);
      if (!w.active) assert.deepEqual([p.mode, p.gpuMiB], ['idle', 0]);
      if (p.mode === 'cpu') assert.equal(p.gpuMiB, 0);
      if (p.mode === 'gpu') assert.equal(p.gpuMiB, w.fullGpuMiB);
      if (p.mode === 'partial') {
        assert.ok(p.gpuLayers >= 1 && p.gpuLayers < w.layers, `layers ${p.gpuLayers}/${w.layers}`);
        assert.ok(p.gpuMiB < w.fullGpuMiB && p.gpuMiB >= w.minUsefulGpuMiB);
      }
      assert.ok(p.reason.length > 5);
    });
  }
});

test('property: a lower workload never gets GPU memory the higher one could have used', () => {
  // Giving the first workload more budget can never reduce its allocation.
  for (let total = 0; total <= 6000; total += 250) {
    const a = byId(planWorkloads({ workloads: [musetalk, lfm3], gpuTotalMiB: total, reservedMiB: 1500 }));
    const b = byId(planWorkloads({ workloads: [musetalk, lfm3], gpuTotalMiB: total + 250, reservedMiB: 1500 }));
    assert.ok(b.musetalk.gpuMiB >= a.musetalk.gpuMiB);
  }
});
