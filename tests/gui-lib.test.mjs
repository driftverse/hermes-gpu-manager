// Pure GUI helpers (public/lib.js): everything the page decides, without a DOM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fmtMiB, vramSegments, placementBadge, rowNote, moveInOrder, eventView, ageText,
  parseSettingsForm, parseWorkloadForm, parseAddForm, summaryLine,
} from '../public/lib.js';

const wl = (over = {}) => ({
  id: 'lfm3', name: 'LFM3 1.7B (Ollama)', kind: 'ollama', builtin: true, tag: 'lfm3:1.7b-100000', layers: 24,
  fullGpuMiB: 1200, minUsefulGpuMiB: 400, allowPartial: true, priority: 2,
  planned: { mode: 'gpu', gpuMiB: 1200, gpuLayers: null, reason: 'Fits fully on the GPU (1200 MiB).' },
  actual: { mode: 'gpu', gpuMiB: 1180, gpuLayers: null }, routed: 'gpu', inflight: { gpu: 0, cpu: 0 }, pending: null, matches: true,
  ...over,
});
const job = (over = {}) => ({
  id: 'musetalk', name: 'MuseTalk lip-sync', kind: 'job', builtin: true, fullGpuMiB: 2570, minUsefulGpuMiB: 2570, allowPartial: false,
  priority: 1, planned: { mode: 'idle', gpuMiB: 0, gpuLayers: 0, reason: 'Not running, so it holds no GPU memory.' },
  actual: { mode: 'idle', gpuMiB: 0, gpuLayers: 0 }, inflight: { gpu: 0, cpu: 0 }, pending: null, matches: true, ...over,
});
const status = (over = {}) => ({
  now: 1_000_000,
  vram: { ok: true, error: null, totalMiB: 4096, usedMiB: 2700, freeMiB: 1396, externalMiB: 1500, managedMiB: 1180, reservedMiB: 1500, budgetMiB: 2596, plannedFreeMiB: 1396 },
  workloads: [job(), wl()],
  ...over,
});

test('fmtMiB: thousands separators, em dash for unknown', () => {
  assert.equal(fmtMiB(1236), '1,236 MiB');
  assert.equal(fmtMiB(0), '0 MiB');
  assert.equal(fmtMiB(null), '—');
  assert.equal(fmtMiB(undefined), '—');
  assert.equal(fmtMiB(NaN), '—');
});

test('vramSegments: system, each workload that holds memory, then free; they add up to the total', () => {
  const segs = vramSegments(status());
  assert.deepEqual(segs.map((s) => s.kind), ['system', 'workload', 'free']);
  assert.equal(segs[0].mib, 1500);
  assert.equal(segs[1].label, 'LFM3 1.7B (Ollama)');
  assert.equal(segs[1].mib, 1180);
  assert.equal(segs[2].mib, 4096 - 1500 - 1180);
  assert.equal(segs.reduce((s, x) => s + x.mib, 0), 4096);
  assert.ok(Math.abs(segs.reduce((s, x) => s + x.pct, 0) - 100) < 0.01);
});

test('vramSegments: a running job and a split model both show; workloads with 0 MiB are omitted', () => {
  const s = status({
    workloads: [job({ actual: { mode: 'gpu', gpuMiB: 2570, gpuLayers: null } }), wl({ actual: { mode: 'cpu', gpuMiB: 0, gpuLayers: 0 } })],
  });
  const segs = vramSegments(s);
  assert.deepEqual(segs.map((x) => x.label), ['System', 'MuseTalk lip-sync', 'Free']);
  const split = vramSegments(status({ workloads: [job(), wl({ actual: { mode: 'partial', gpuMiB: 600, gpuLayers: 12 } })] }));
  assert.equal(split.find((x) => x.label === 'LFM3 1.7B (Ollama)').mib, 600);
});

test('vramSegments: never negative and never over 100% even when readings disagree', () => {
  const s = status({ vram: { ...status().vram, externalMiB: 3900 }, workloads: [job({ actual: { mode: 'gpu', gpuMiB: 2570 } }), wl()] });
  const segs = vramSegments(s);
  assert.ok(segs.every((x) => x.mib >= 0 && x.pct >= 0));
  assert.ok(segs.reduce((a, x) => a + x.pct, 0) <= 100.0001);
});

test('vramSegments: an unreadable GPU gives no segments and a reason', () => {
  const segs = vramSegments(status({ vram: { ...status().vram, ok: false, error: 'nvidia-smi failed' } }));
  assert.deepEqual(segs, []);
});

test('placementBadge: actual placement, with split layers spelled out', () => {
  assert.deepEqual(placementBadge(wl()), { text: 'GPU', tone: 'gpu' });
  assert.deepEqual(placementBadge(wl({ actual: { mode: 'cpu', gpuMiB: 0 } })), { text: 'CPU', tone: 'cpu' });
  assert.deepEqual(placementBadge(wl({ actual: { mode: 'partial', gpuMiB: 600, gpuLayers: 12 } })), { text: 'SPLIT 12/24 layers on GPU', tone: 'split' });
  assert.deepEqual(placementBadge(job()), { text: 'IDLE', tone: 'idle' });
  assert.deepEqual(placementBadge(job({ actual: { mode: 'gpu', gpuMiB: 2570 } })), { text: 'GPU · RUNNING', tone: 'gpu' });
  assert.deepEqual(placementBadge(wl({ actual: { mode: 'unloaded', gpuMiB: 0 } })), { text: 'NOT LOADED', tone: 'idle' });
  assert.deepEqual(placementBadge(wl({ actual: { mode: 'unknown', gpuMiB: 0 } })), { text: 'UNKNOWN', tone: 'warn' });
});

test('rowNote: silent when actual matches the plan; otherwise plan + reason, and what it is waiting for', () => {
  assert.equal(rowNote(wl()), null);
  const moving = wl({ matches: false, actual: { mode: 'gpu' }, planned: { mode: 'cpu', gpuMiB: 0, reason: 'Only 0 of 1200 MiB are left after musetalk and it cannot be split; running on the CPU.' } });
  assert.match(rowNote(moving), /^Moving to CPU\. Only 0 of 1200 MiB/);
  const blocked = wl({ ...moving, pending: { blockedReason: 'blocked: still serving 2 request(s)' } });
  assert.match(rowNote(blocked), /Waiting: still serving 2 request\(s\)/);
  assert.match(rowNote(wl({ matches: false, planned: { mode: 'partial', gpuLayers: 12, reason: 'r' } })), /^Moving to SPLIT 12 layers on GPU\./);
});

test('rowNote: a running job that is now outranked says it is finishing and will not get the GPU back', () => {
  const outranked = job({ actual: { mode: 'gpu', gpuMiB: 2570 }, planned: { mode: 'cpu', gpuMiB: 0, reason: 'Only 1396 of 2570 MiB of GPU are left after lfm3 and it cannot be split; running on the CPU.' } });
  const note = rowNote(outranked);
  assert.match(note, /^Finishing the current run\./);
  assert.match(note, /higher-priority/);
  assert.equal(rowNote(job({ actual: { mode: 'gpu', gpuMiB: 2570 }, planned: { mode: 'gpu', gpuMiB: 2570, reason: 'ok' } })), null);
  assert.equal(rowNote(job()), null);
});

test('moveInOrder: moves one step, stops at the ends, never mutates its input, ignores unknown ids', () => {
  const order = ['a', 'b', 'c'];
  assert.deepEqual(moveInOrder(order, 'b', -1), ['b', 'a', 'c']);
  assert.deepEqual(moveInOrder(order, 'b', +1), ['a', 'c', 'b']);
  assert.equal(moveInOrder(order, 'a', -1), null);
  assert.equal(moveInOrder(order, 'c', +1), null);
  assert.equal(moveInOrder(order, 'zzz', +1), null);
  assert.deepEqual(order, ['a', 'b', 'c']);
});

test('eventView: time as HH:MM:SS, plain message, level class', () => {
  const v = eventView({ t: Date.UTC(2026, 10, 1, 12, 34, 56), level: 'warn', type: 'blocked', message: 'Waiting for 1 request to finish before moving LFM3 to the CPU' });
  assert.match(v.time, /^\d\d:\d\d:\d\d$/);
  assert.equal(v.text, 'Waiting for 1 request to finish before moving LFM3 to the CPU');
  assert.equal(v.level, 'warn');
  assert.equal(eventView({ t: 1, level: 'weird', message: 'x' }).level, 'info');
});

test('ageText', () => {
  assert.equal(ageText(10_000, 9_500), 'just now');
  assert.equal(ageText(20_000, 14_000), '6 s ago');
  assert.equal(ageText(400_000, 100_000), '5 min ago');
  assert.equal(ageText(10_000, 12_000), 'just now');
  assert.equal(ageText(10_000, undefined), 'never');
});

test('parseSettingsForm: ints in range, blank GPU total means automatic, errors are readable', () => {
  const ok = parseSettingsForm({ reservedMiB: '1600', gpuTotalMiB: '', drainTimeoutSec: '180', minDwellSec: '30' });
  assert.deepEqual(ok, { patch: { reservedMiB: 1600, gpuTotalMiB: null, drainTimeoutSec: 180, minDwellSec: 30 }, errors: [] });
  const bad = parseSettingsForm({ reservedMiB: 'abc', gpuTotalMiB: '-5', drainTimeoutSec: '0', minDwellSec: '1.5' });
  assert.equal(bad.errors.length, 4);
  assert.match(bad.errors[0], /Reserved memory/);
  assert.deepEqual(bad.patch, {});
});

test('parseWorkloadForm: only editable fields, layers/sizes as integers, toggles as booleans', () => {
  const ok = parseWorkloadForm('ollama', { fullGpuMiB: '1200', minUsefulGpuMiB: '400', layers: '24', allowPartial: true });
  assert.deepEqual(ok, { patch: { fullGpuMiB: 1200, minUsefulGpuMiB: 400, layers: 24, allowPartial: true }, errors: [] });
  const jobOk = parseWorkloadForm('job', { fullGpuMiB: '2570', minUsefulGpuMiB: '2570', reserveWhenIdle: false });
  assert.deepEqual(jobOk.patch, { fullGpuMiB: 2570, minUsefulGpuMiB: 2570, reserveWhenIdle: false });
  assert.equal(parseWorkloadForm('ollama', { fullGpuMiB: '0', minUsefulGpuMiB: '400', layers: '24', allowPartial: true }).errors.length, 1);
  assert.equal(parseWorkloadForm('ollama', { fullGpuMiB: '1200', minUsefulGpuMiB: '9999', layers: '24', allowPartial: true }).errors.length, 1);
});

test('parseAddForm: id derived safely from the tag when blank; partial offload needs layers', () => {
  const ok = parseAddForm({ tag: 'qwen3:1.7b', name: '', id: '', layers: '28', fullGpuMiB: '1500', minUsefulGpuMiB: '400', allowPartial: true });
  assert.equal(ok.errors.length, 0);
  assert.deepEqual(ok.def, { id: 'qwen3-1-7b', name: 'qwen3:1.7b', kind: 'ollama', tag: 'qwen3:1.7b', layers: 28, fullGpuMiB: 1500, minUsefulGpuMiB: 400, allowPartial: true });
  const noLayers = parseAddForm({ tag: 'x:1b', name: 'X', id: 'x', layers: '', fullGpuMiB: '900', minUsefulGpuMiB: '100', allowPartial: true });
  assert.match(noLayers.errors.join(' '), /layers/i);
  const cpuOnlyOk = parseAddForm({ tag: 'x:1b', name: 'X', id: 'x', layers: '', fullGpuMiB: '900', minUsefulGpuMiB: '0', allowPartial: false });
  assert.equal(cpuOnlyOk.errors.length, 0);
  assert.equal(cpuOnlyOk.def.layers, undefined);
  assert.match(parseAddForm({ tag: '', name: '', id: '', layers: '', fullGpuMiB: '1', minUsefulGpuMiB: '0', allowPartial: false }).errors.join(' '), /model/i);
});

test('summaryLine: one sentence of where everything is, jobs omitted when idle', () => {
  assert.equal(summaryLine(status()), 'LFM3 1.7B (Ollama) on GPU.');
  const busy = status({ workloads: [job({ actual: { mode: 'gpu', gpuMiB: 2570 } }), wl({ actual: { mode: 'cpu', gpuMiB: 0 } })] });
  assert.equal(summaryLine(busy), 'MuseTalk lip-sync on GPU (running). LFM3 1.7B (Ollama) on CPU.');
});
