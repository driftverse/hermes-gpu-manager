// Persistent manager state: ordered workload list + settings.
//
// `STATE_DIR/state.json`, dir 0700, file 0600, atomic replace (temp file + fsync + rename), serialised
// saves. Schema-validated on load AND before every save; a corrupt/invalid file is copied to
// `state.json.bad` and defaults are used (the bad copy is never overwritten by a later save of the
// defaults because load itself never writes state.json).

import { mkdir, chmod, open, rename, readFile, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';

export const STATE_VERSION = 1;

const WORKLOAD_FIELDS = new Set(['id', 'name', 'kind', 'builtin', 'tag', 'layers', 'fullGpuMiB', 'minUsefulGpuMiB', 'allowPartial', 'reserveWhenIdle']);
const SETTING_FIELDS = new Set(['reservedMiB', 'gpuTotalMiB', 'drainTimeoutSec', 'minDwellSec', 'leaseTtlSec', 'leaseAcquireTimeoutSec']);
const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const TAG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._\-/]*(:[A-Za-z0-9._-]+)?$/;

export function defaultState() {
  return {
    version: STATE_VERSION,
    order: ['musetalk', 'sd15', 'ltxvideo', 'flux2', 'sdxl', 'ltx098', 'immichvision', 'lfm3'],
    settings: {
      reservedMiB: 1500,
      gpuTotalMiB: null,
      drainTimeoutSec: 180,
      minDwellSec: 30,
      leaseTtlSec: 1200,
      leaseAcquireTimeoutSec: 300,
    },
    workloads: {
      musetalk: {
        id: 'musetalk', name: 'MuseTalk lip-sync', kind: 'job', builtin: true,
        fullGpuMiB: 2570, minUsefulGpuMiB: 2570, allowPartial: false, reserveWhenIdle: false,
      },
      // Sequential image offload and complete tiny-video encoder+diffusion peaks, plus process/context margin.
      // The prior800MiB LTX figure excluded the streamed T5 encoder; full-pipeline trials invalidate it.
      sd15: {
        id: 'sd15', name: 'Stable Diffusion 1.5 images', kind: 'job', builtin: true,
        fullGpuMiB: 1800, minUsefulGpuMiB: 1800, allowPartial: false, reserveWhenIdle: false,
      },
      ltxvideo: {
        id: 'ltxvideo', name: 'LTX-Video 2B clips', kind: 'job', builtin: true,
        fullGpuMiB: 1800, minUsefulGpuMiB: 1800, allowPartial: false, reserveWhenIdle: false,
      },
      // Quality trials 2026-11-02: whole GPU ~3656MiB (FLUX) /3817MiB (LTX98), including ~880MiB desktop.
      // These reserve conservative per-process budgets, not the on-disk weight sizes. Never reserve while idle.
      flux2: {
        id: 'flux2', name: 'FLUX.2 Klein 4B Q4 images (512)', kind: 'job', builtin: true,
        fullGpuMiB: 2900, minUsefulGpuMiB: 2900, allowPartial: false, reserveWhenIdle: false,
      },
      sdxl: {
        id: 'sdxl', name: 'SDXL-Lightning 4-step images (1024)', kind: 'job', builtin: true,
        fullGpuMiB: 1600, minUsefulGpuMiB: 1600, allowPartial: false, reserveWhenIdle: false,
      },
      ltx098: {
        id: 'ltx098', name: 'LTX-Video 0.9.8 experimental motion', kind: 'job', builtin: true,
        fullGpuMiB: 3072, minUsefulGpuMiB: 3072, allowPartial: false, reserveWhenIdle: false,
      },
      immichvision: {
        id: 'immichvision', name: 'Immich vision — Qwen3-VL 2B', kind: 'job', builtin: true,
        fullGpuMiB: 2900, minUsefulGpuMiB: 2900, allowPartial: false, reserveWhenIdle: false,
      },
      lfm3: {
        id: 'lfm3', name: 'LFM3 1.7B (Ollama)', kind: 'ollama', builtin: true,
        // fullGpuMiB is what Ollama itself reports; the real process holds more (measured ~2062 MiB at a 70k
        // window, see Setup/gpu-manager.md). A live install should set the measured figure in the GUI.
        tag: 'lfm3:1.7b-100000', layers: 24, fullGpuMiB: 1200, minUsefulGpuMiB: 400, allowPartial: true,
      },
    },
  };
}

// Older state files predate some built-in workloads. Add the missing ones without touching anything the owner
// changed; new entries go right after the last existing job (so they sit with the other jobs and never outrank
// anything the owner arranged above them).
export function addMissingBuiltins(state) {
  const defaults = defaultState();
  let migrated = false;
  for (const id of defaults.order) {
    const def = defaults.workloads[id];
    if (!def.builtin || state.workloads[id]) continue;
    state.workloads[id] = def;
    let last = -1;
    state.order.forEach((o, i) => { if (state.workloads[o]?.kind === 'job') last = i; });
    state.order.splice(last + 1, 0, id);
    migrated = true;
  }
  return migrated;
}

const isInt = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;

export function validateWorkloadDef(def) {
  const errors = [];
  if (!def || typeof def !== 'object' || Array.isArray(def)) return { ok: false, errors: ['workload must be an object'] };
  for (const key of Object.keys(def)) if (!WORKLOAD_FIELDS.has(key)) errors.push(`unknown field: ${key}`);
  if (typeof def.id !== 'string' || !ID_PATTERN.test(def.id)) errors.push('id must match [a-z0-9][a-z0-9_-]{0,39}');
  if (typeof def.name !== 'string' || !def.name.trim() || def.name.length > 80) errors.push('name must be 1-80 characters');
  if (def.kind !== 'ollama' && def.kind !== 'job') errors.push("kind must be 'ollama' or 'job'");
  if (!isInt(def.fullGpuMiB, 1, 65536)) errors.push('fullGpuMiB must be an integer 1-65536');
  if (!isInt(def.minUsefulGpuMiB, 0, 65536) || (isInt(def.fullGpuMiB, 1, 65536) && def.minUsefulGpuMiB > def.fullGpuMiB)) {
    errors.push('minUsefulGpuMiB must be an integer 0..fullGpuMiB');
  }
  if (typeof def.allowPartial !== 'boolean') errors.push('allowPartial must be a boolean');
  if (def.builtin !== undefined && typeof def.builtin !== 'boolean') errors.push('builtin must be a boolean');
  if (def.kind === 'ollama') {
    if (typeof def.tag !== 'string' || def.tag.length > 128 || !TAG_PATTERN.test(def.tag) || def.tag.includes('..')) {
      errors.push('tag must be a valid Ollama model tag');
    }
    if (def.layers !== undefined && !isInt(def.layers, 2, 1024)) errors.push('layers must be an integer 2-1024');
    if (def.reserveWhenIdle !== undefined) errors.push('reserveWhenIdle only applies to jobs');
  } else if (def.kind === 'job') {
    if (def.tag !== undefined) errors.push('jobs have no Ollama tag');
    if (def.reserveWhenIdle !== undefined && typeof def.reserveWhenIdle !== 'boolean') errors.push('reserveWhenIdle must be a boolean');
  }
  return { ok: errors.length === 0, errors };
}

export function validateSettings(settings) {
  const errors = [];
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return { ok: false, errors: ['settings must be an object'] };
  for (const key of Object.keys(settings)) if (!SETTING_FIELDS.has(key)) errors.push(`unknown setting: ${key}`);
  if (!isInt(settings.reservedMiB, 0, 65536)) errors.push('reservedMiB must be an integer 0-65536');
  if (settings.gpuTotalMiB !== null && !isInt(settings.gpuTotalMiB, 1, 262144)) errors.push('gpuTotalMiB must be null or an integer 1-262144');
  if (!isInt(settings.drainTimeoutSec, 1, 86400)) errors.push('drainTimeoutSec must be an integer 1-86400');
  if (!isInt(settings.minDwellSec, 0, 3600)) errors.push('minDwellSec must be an integer 0-3600');
  if (!isInt(settings.leaseTtlSec, 30, 86400)) errors.push('leaseTtlSec must be an integer 30-86400');
  if (!isInt(settings.leaseAcquireTimeoutSec, 5, 3600)) errors.push('leaseAcquireTimeoutSec must be an integer 5-3600');
  return { ok: errors.length === 0, errors };
}

export function validateState(state) {
  const errors = [];
  if (!state || typeof state !== 'object' || Array.isArray(state)) return { ok: false, errors: ['state must be an object'] };
  if (state.version !== STATE_VERSION) errors.push(`version must be ${STATE_VERSION}`);
  errors.push(...validateSettings(state.settings).errors);
  const workloads = state.workloads;
  if (!workloads || typeof workloads !== 'object' || Array.isArray(workloads)) {
    errors.push('workloads must be an object');
  } else {
    for (const [key, def] of Object.entries(workloads)) {
      const r = validateWorkloadDef(def);
      for (const e of r.errors) errors.push(`workloads.${key}: ${e}`);
      if (def && def.id !== key) errors.push(`workloads.${key}: id must equal its key`);
    }
  }
  const ids = workloads && typeof workloads === 'object' ? Object.keys(workloads) : [];
  const order = state.order;
  const isPerm = Array.isArray(order)
    && order.length === ids.length
    && new Set(order).size === order.length
    && order.every((id) => ids.includes(id));
  if (!isPerm) errors.push('order must be a permutation of the workload ids');
  return { ok: errors.length === 0, errors };
}

export function createStateStore({ dir }) {
  const file = join(dir, 'state.json');
  let queue = Promise.resolve();
  let counter = 0;

  async function ensureDir() {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
  }

  async function load() {
    let text;
    try {
      text = await readFile(file, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return { state: defaultState(), recovered: false, migrated: false };
      throw err;
    }
    let reason;
    try {
      const parsed = JSON.parse(text);
      const verdict = validateState(parsed);
      if (verdict.ok) {
        const migrated = addMissingBuiltins(parsed);
        return { state: parsed, recovered: false, migrated };
      }
      reason = `schema: ${verdict.errors.join('; ')}`;
    } catch (err) {
      reason = `invalid JSON: ${err.message}`;
    }
    await ensureDir();
    await writeFile(`${file}.bad`, text, { mode: 0o600 });
    await chmod(`${file}.bad`, 0o600);
    return { state: defaultState(), recovered: true, reason };
  }

  async function writeAtomic(state) {
    await ensureDir();
    counter += 1;
    const tmp = join(dir, `state.json.${process.pid}.${counter}.tmp`);
    const handle = await open(tmp, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(tmp, file);
    } catch (err) {
      await unlink(tmp).catch(() => {});
      throw err;
    }
    await chmod(file, 0o600);
  }

  function save(state) {
    const verdict = validateState(state);
    if (!verdict.ok) return Promise.reject(new Error(`invalid state: ${verdict.errors.join('; ')}`));
    const snapshot = structuredClone(state);
    const run = queue.then(() => writeAtomic(snapshot));
    queue = run.catch(() => {});
    return run;
  }

  return { load, save, file };
}
