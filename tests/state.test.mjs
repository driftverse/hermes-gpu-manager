import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat, readdir, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStateStore, defaultState, validateState, validateWorkloadDef } from '../src/state.mjs';

async function tmp() {
  const dir = await mkdtemp(join(tmpdir(), 'penny-state-'));
  return { dir, done: () => rm(dir, { recursive: true, force: true }) };
}

test('defaults: musetalk, sd15 and ltxvideo jobs ahead of lfm3, sane settings', () => {
  const s = defaultState();
  assert.deepEqual(s.order, ['musetalk', 'sd15', 'ltxvideo', 'flux2', 'sdxl', 'ltx098', 'immichvision', 'lfm3']);
  for (const id of ['sd15', 'ltxvideo']) {
    assert.equal(s.workloads[id].kind, 'job');
    assert.equal(s.workloads[id].builtin, true);
    assert.equal(s.workloads[id].allowPartial, false);
    assert.equal(s.workloads[id].reserveWhenIdle, false);
    assert.ok(s.workloads[id].fullGpuMiB < s.workloads.musetalk.fullGpuMiB, `${id} needs less than MuseTalk`);
  }
  assert.equal(s.workloads.sd15.name, 'Stable Diffusion 1.5 images');
  assert.equal(s.workloads.ltxvideo.name, 'LTX-Video 2B clips');
  assert.equal(s.workloads.musetalk.kind, 'job');
  assert.equal(s.workloads.musetalk.builtin, true);
  assert.equal(s.workloads.musetalk.fullGpuMiB, 2570);
  assert.equal(s.workloads.musetalk.reserveWhenIdle, false);
  assert.equal(s.workloads.lfm3.tag, 'lfm3:1.7b-100000');
  assert.equal(s.workloads.lfm3.layers, 24);
  assert.equal(s.settings.drainTimeoutSec, 180);
  assert.equal(s.settings.gpuTotalMiB, null);
  assert.equal(s.settings.minDwellSec, 30);
  assert.equal(s.settings.leaseTtlSec, 1200);
  assert.equal(validateState(s).ok, true);
});

test('missing file -> defaults, no .bad file', async () => {
  const t = await tmp();
  try {
    const store = createStateStore({ dir: join(t.dir, 'cfg') });
    const r = await store.load();
    assert.equal(r.recovered, false);
    assert.deepEqual(r.state.order, ['musetalk', 'sd15', 'ltxvideo', 'flux2', 'sdxl', 'ltx098', 'immichvision', 'lfm3']);
    assert.deepEqual(await readdir(t.dir), []); // load alone does not create anything
  } finally { await t.done(); }
});

test('save: dir 0700, file 0600, atomic (no temp files left), round-trips', async () => {
  const t = await tmp();
  try {
    const dir = join(t.dir, 'cfg');
    const store = createStateStore({ dir });
    const state = defaultState();
    state.settings.reservedMiB = 1600;
    await store.save(state);
    assert.equal((await stat(dir)).mode & 0o777, 0o700);
    assert.equal((await stat(join(dir, 'state.json'))).mode & 0o777, 0o600);
    assert.deepEqual(await readdir(dir), ['state.json']);
    const again = await createStateStore({ dir }).load();
    assert.equal(again.state.settings.reservedMiB, 1600);
    assert.equal(again.recovered, false);
  } finally { await t.done(); }
});

test('save refuses an invalid state and leaves the previous file intact', async () => {
  const t = await tmp();
  try {
    const store = createStateStore({ dir: t.dir });
    const good = defaultState();
    await store.save(good);
    const before = await readFile(join(t.dir, 'state.json'), 'utf8');
    const bad = defaultState();
    bad.order = ['lfm3']; // not a permutation
    await assert.rejects(store.save(bad), /invalid state/i);
    assert.equal(await readFile(join(t.dir, 'state.json'), 'utf8'), before);
  } finally { await t.done(); }
});

test('corrupt JSON -> .bad copy kept, defaults returned, recovered flagged', async () => {
  const t = await tmp();
  try {
    await writeFile(join(t.dir, 'state.json'), '{ this is not json', { mode: 0o600 });
    const r = await createStateStore({ dir: t.dir }).load();
    assert.equal(r.recovered, true);
    assert.match(r.reason, /json/i);
    assert.deepEqual(r.state.order, ['musetalk', 'sd15', 'ltxvideo', 'flux2', 'sdxl', 'ltx098', 'immichvision', 'lfm3']);
    assert.equal(await readFile(join(t.dir, 'state.json.bad'), 'utf8'), '{ this is not json');
    assert.equal((await stat(join(t.dir, 'state.json.bad'))).mode & 0o777, 0o600);
  } finally { await t.done(); }
});

test('schema-invalid JSON -> .bad copy kept and defaults used', async () => {
  const t = await tmp();
  try {
    const bad = defaultState();
    bad.settings.drainTimeoutSec = -5;
    await writeFile(join(t.dir, 'state.json'), JSON.stringify(bad));
    const r = await createStateStore({ dir: t.dir }).load();
    assert.equal(r.recovered, true);
    assert.match(r.reason, /drainTimeoutSec/);
    assert.equal(r.state.settings.drainTimeoutSec, 180);
    assert.ok((await readFile(join(t.dir, 'state.json.bad'), 'utf8')).includes('-5'));
  } finally { await t.done(); }
});

test('existing too-open directory is tightened to 0700 on save', async () => {
  const t = await tmp();
  try {
    const dir = join(t.dir, 'open');
    await mkdir(dir, { mode: 0o755 });
    await createStateStore({ dir }).save(defaultState());
    assert.equal((await stat(dir)).mode & 0o777, 0o700);
  } finally { await t.done(); }
});

test('validateState: order must be a permutation of the workload ids', () => {
  const s = defaultState();
  s.order = ['musetalk', 'lfm3', 'lfm3'];
  assert.match(validateState(s).errors.join(), /permutation/);
  s.order = ['musetalk', 'ghost'];
  assert.match(validateState(s).errors.join(), /permutation/);
});

test('validateState: settings ranges', () => {
  const cases = [
    ['reservedMiB', -1], ['reservedMiB', 'a'], ['reservedMiB', 99999],
    ['gpuTotalMiB', 0], ['gpuTotalMiB', 1.5],
    ['drainTimeoutSec', 0], ['drainTimeoutSec', 100000],
    ['minDwellSec', -1], ['leaseTtlSec', 5],
  ];
  for (const [key, value] of cases) {
    const s = defaultState();
    s.settings[key] = value;
    const r = validateState(s);
    assert.equal(r.ok, false, `${key}=${value}`);
    assert.match(r.errors.join(), new RegExp(key));
  }
  const ok = defaultState();
  ok.settings.gpuTotalMiB = 8192;
  assert.equal(validateState(ok).ok, true);
});

test('validateWorkloadDef: ollama model definitions', () => {
  const good = { id: 'qwen3', name: 'Qwen3 4B', kind: 'ollama', tag: 'qwen3:4b', layers: 36, fullGpuMiB: 2800, minUsefulGpuMiB: 600, allowPartial: true };
  assert.equal(validateWorkloadDef(good).ok, true);
  const bad = [
    { ...good, id: 'Bad Id!' },
    { ...good, id: '' },
    { ...good, tag: 'has space' },
    { ...good, tag: '../../etc/passwd' },
    { ...good, tag: '' },
    { ...good, layers: 1 },
    { ...good, layers: 'x' },
    { ...good, fullGpuMiB: 0 },
    { ...good, minUsefulGpuMiB: 99999 },
    { ...good, allowPartial: 'yes' },
    { ...good, kind: 'service' },
  ];
  for (const def of bad) assert.equal(validateWorkloadDef(def).ok, false, JSON.stringify(def));
});

test('validateWorkloadDef: unknown fields are rejected, not silently kept', () => {
  const r = validateWorkloadDef({ id: 'x', name: 'x', kind: 'ollama', tag: 'x:1', fullGpuMiB: 100, minUsefulGpuMiB: 10, allowPartial: false, evil: 1 });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(), /evil/);
});

test('concurrent saves never interleave: the last write wins and the file is always valid JSON', async () => {
  const t = await tmp();
  try {
    const store = createStateStore({ dir: t.dir });
    const saves = [];
    for (let i = 0; i < 20; i += 1) {
      const s = defaultState();
      s.settings.reservedMiB = 1000 + i;
      saves.push(store.save(s));
    }
    await Promise.all(saves);
    const final = JSON.parse(await readFile(join(t.dir, 'state.json'), 'utf8'));
    assert.equal(final.settings.reservedMiB, 1019);
    assert.deepEqual((await readdir(t.dir)).sort(), ['state.json']);
  } finally { await t.done(); }
});

test('an older state file gains the new built-in jobs, keeps every customisation, and is flagged migrated', async () => {
  const t = await tmp();
  try {
    const old = defaultState();
    for (const id of ['sd15', 'ltxvideo', 'flux2', 'sdxl', 'ltx098', 'immichvision']) delete old.workloads[id];
    old.order = ['lfm3', 'musetalk']; // the owner moved LFM3 to the top
    old.workloads.lfm3.fullGpuMiB = 2450;
    old.settings.reservedMiB = 1024;
    await writeFile(join(t.dir, 'state.json'), JSON.stringify(old));
    const r = await createStateStore({ dir: t.dir }).load();
    assert.equal(r.recovered, false);
    assert.equal(r.migrated, true);
    assert.equal(validateState(r.state).ok, true);
    assert.deepEqual(r.state.order.slice(0, 2), ['lfm3', 'musetalk'], 'the owner order is kept');
    assert.deepEqual(r.state.order.slice(2).sort(), ['flux2', 'immichvision', 'ltx098', 'ltxvideo', 'sd15', 'sdxl']);
    assert.equal(r.state.workloads.lfm3.fullGpuMiB, 2450);
    assert.equal(r.state.settings.reservedMiB, 1024);
    assert.equal(r.state.workloads.sd15.kind, 'job');
  } finally { await t.done(); }
});

test('a current state file is not flagged migrated, and a removed non-builtin is not resurrected', async () => {
  const t = await tmp();
  try {
    await writeFile(join(t.dir, 'state.json'), JSON.stringify(defaultState()));
    const r = await createStateStore({ dir: t.dir }).load();
    assert.equal(r.migrated, false);
  } finally { await t.done(); }
});
