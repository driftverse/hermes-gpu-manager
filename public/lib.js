// Pure helpers for the GPU page: what to show and how to read the forms. No DOM, no network, so every
// decision is unit-tested in tests/gui-lib.test.mjs. app.js only draws what these return.

const finite = (n) => typeof n === 'number' && Number.isFinite(n);

export function fmtMiB(n) {
  return finite(n) ? `${n.toLocaleString('en-US')} MiB` : '—';
}

// The VRAM bar: system (everything not managed here), then every workload that really holds GPU memory,
// then free. The parts are clamped so they can never add up to more than the card, even when readings disagree.
export function vramSegments(status) {
  const v = status?.vram;
  if (!v || !v.ok || !finite(v.totalMiB) || v.totalMiB <= 0) return [];
  const total = v.totalMiB;
  let remaining = total;
  const segments = [];
  const push = (kind, label, mib, id) => {
    segments.push({ kind, label, mib, id, pct: (mib / total) * 100 });
  };
  const system = Math.min(Math.max(0, v.externalMiB || 0), remaining);
  remaining -= system;
  if (system > 0) push('system', 'System', system);
  for (const w of status.workloads || []) {
    const held = Math.min(Math.max(0, w.actual?.gpuMiB || 0), remaining);
    if (held <= 0) continue;
    remaining -= held;
    push('workload', w.name, held, w.id);
  }
  push('free', 'Free', remaining);
  return segments;
}

export function placementBadge(w) {
  const a = w.actual || {};
  if (w.kind === 'job') {
    return a.mode === 'gpu' ? { text: 'GPU · RUNNING', tone: 'gpu' } : { text: 'IDLE', tone: 'idle' };
  }
  switch (a.mode) {
    case 'gpu': return { text: 'GPU', tone: 'gpu' };
    case 'cpu': return { text: 'CPU', tone: 'cpu' };
    case 'partial': return { text: `SPLIT ${a.gpuLayers}/${w.layers} layers on GPU`, tone: 'split' };
    case 'unloaded': return { text: 'NOT LOADED', tone: 'idle' };
    case 'idle': return { text: 'IDLE', tone: 'idle' };
    default: return { text: 'UNKNOWN', tone: 'warn' };
  }
}

function plannedLabel(p) {
  if (p?.mode === 'gpu') return 'GPU';
  if (p?.mode === 'cpu') return 'CPU';
  if (p?.mode === 'partial') return `SPLIT ${p.gpuLayers} layers on GPU`;
  return 'IDLE';
}

// Why the row differs from the plan, in plain words; null when actual matches planned.
export function rowNote(w) {
  // A running job cannot be preempted: when it has been outranked it finishes, then loses the GPU.
  if (w.kind === 'job' && w.actual?.mode === 'gpu' && w.planned?.mode !== 'gpu') {
    return `Finishing the current run. By priority it will not get the GPU again while higher-priority models need it. ${w.planned?.reason || ''}`.trim();
  }
  if (w.matches !== false) return null;
  let text = `Moving to ${plannedLabel(w.planned)}. ${w.planned?.reason || ''}`.trim();
  if (w.pending?.blockedReason) text += ` Waiting: ${String(w.pending.blockedReason).replace(/^blocked:\s*/i, '')}`;
  return text;
}

// New order after moving `id` one step (dir -1 = higher priority), or null when it cannot move.
export function moveInOrder(order, id, dir) {
  const i = order.indexOf(id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= order.length) return null;
  const next = [...order];
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}

export function eventView(e) {
  const d = new Date(e.t);
  const p = (n) => String(n).padStart(2, '0');
  return {
    time: `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`,
    text: String(e.message ?? ''),
    level: ['info', 'warn', 'error'].includes(e.level) ? e.level : 'info',
  };
}

export function ageText(now, at) {
  if (!finite(at)) return 'never';
  const d = now - at;
  if (d < 2000) return 'just now';
  if (d < 60_000) return `${Math.round(d / 1000)} s ago`;
  return `${Math.round(d / 60_000)} min ago`;
}

// ---- forms ---------------------------------------------------------------------------------------------------

const INT = /^-?\d+$/;
const toInt = (raw) => (typeof raw === 'string' || typeof raw === 'number') && INT.test(String(raw).trim()) ? Number(String(raw).trim()) : NaN;
const inRange = (n, lo, hi) => Number.isInteger(n) && n >= lo && n <= hi;

export function parseSettingsForm(v) {
  const patch = {};
  const errors = [];
  const num = (key, label, lo, hi) => {
    if (v[key] === undefined) return;
    const n = toInt(v[key]);
    if (!inRange(n, lo, hi)) errors.push(`${label} must be a whole number from ${lo} to ${hi}.`);
    else patch[key] = n;
  };
  num('reservedMiB', 'Reserved memory', 0, 65536);
  if (v.gpuTotalMiB !== undefined) {
    if (String(v.gpuTotalMiB).trim() === '') patch.gpuTotalMiB = null;
    else {
      const n = toInt(v.gpuTotalMiB);
      if (!inRange(n, 1, 262144)) errors.push('GPU total must be blank (automatic) or a whole number from 1 to 262144.');
      else patch.gpuTotalMiB = n;
    }
  }
  num('drainTimeoutSec', 'Wait for running requests', 1, 86400);
  num('minDwellSec', 'Minimum time between moves', 0, 3600);
  return { patch: errors.length ? {} : patch, errors };
}

export function parseWorkloadForm(kind, v) {
  const patch = {};
  const errors = [];
  const full = toInt(v.fullGpuMiB);
  if (!inRange(full, 1, 65536)) errors.push('Full GPU need must be a whole number from 1 to 65536 MiB.');
  else patch.fullGpuMiB = full;
  const min = toInt(v.minUsefulGpuMiB);
  if (!inRange(min, 0, 65536) || (inRange(full, 1, 65536) && min > full)) errors.push('Smallest useful GPU share must be from 0 up to the full need.');
  else patch.minUsefulGpuMiB = min;
  if (kind === 'ollama') {
    patch.allowPartial = v.allowPartial === true;
    const raw = String(v.layers ?? '').trim();
    if (raw !== '') {
      const layers = toInt(raw);
      if (!inRange(layers, 2, 1024)) errors.push('Layers must be a whole number from 2 to 1024.');
      else patch.layers = layers;
    } else if (patch.allowPartial) errors.push('Layers are needed to split a model between GPU and CPU.');
  } else {
    patch.reserveWhenIdle = v.reserveWhenIdle === true;
  }
  return { patch: errors.length ? {} : patch, errors };
}

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

export function parseAddForm(v) {
  const errors = [];
  const tag = String(v.tag ?? '').trim();
  if (!tag) errors.push('Choose a model to add.');
  const id = String(v.id ?? '').trim() || slug(tag);
  if (tag && !/^[a-z0-9][a-z0-9_-]{0,39}$/.test(id)) errors.push('ID may use lowercase letters, digits, - and _ (up to 40).');
  const name = String(v.name ?? '').trim() || tag;
  const parsed = parseWorkloadForm('ollama', v);
  errors.push(...parsed.errors);
  if (errors.length) return { def: null, errors };
  return { def: { id, name, kind: 'ollama', tag, ...parsed.patch }, errors: [] };
}

export function summaryLine(status) {
  const parts = [];
  for (const w of status.workloads || []) {
    const a = w.actual || {};
    if (w.kind === 'job') {
      if (a.mode === 'gpu') parts.push(`${w.name} on GPU (running).`);
      continue;
    }
    if (a.mode === 'gpu') parts.push(`${w.name} on GPU.`);
    else if (a.mode === 'cpu') parts.push(`${w.name} on CPU.`);
    else if (a.mode === 'partial') parts.push(`${w.name} split: ${a.gpuLayers}/${w.layers} layers on GPU.`);
    else if (a.mode === 'unloaded') parts.push(`${w.name} not loaded.`);
    else parts.push(`${w.name} state unknown.`);
  }
  return parts.join(' ');
}
