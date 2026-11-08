// GPU priority page. All content goes in through textContent / attributes (no HTML strings), every
// decision about what to show lives in lib.js (unit-tested), this file only talks to the API and draws.
import {
  fmtMiB, vramSegments, placementBadge, rowNote, moveInOrder, eventView, ageText,
  parseSettingsForm, parseWorkloadForm, parseAddForm, summaryLine,
} from './lib.js';

const $ = (id) => document.getElementById(id);
const POLL_MS = 2000;
const MAX_EVENTS_SHOWN = 30;

let current = null; // last good /api/status
let lastOkAt = null;
let failures = 0;
let busy = false; // a change request is in flight
const rowEls = new Map(); // workload id -> { li, refs }
const openDrawers = new Set();

// ---- tiny DOM helper -----------------------------------------------------------------------------------------

function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  for (const kid of kids) if (kid !== null && kid !== undefined) el.append(kid);
  return el;
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* not JSON */ }
  if (!res.ok) {
    const err = new Error(json?.error || `Request failed (${res.status}).`);
    err.status = res.status;
    throw err;
  }
  return json;
}

function say(el, text, tone) {
  el.textContent = text;
  el.className = `msg${tone ? ` ${tone}` : ''}`;
}

// ---- rendering -----------------------------------------------------------------------------------------------

function renderLive() {
  const now = Date.now();
  if (failures > 0) {
    $('live').textContent = lastOkAt ? `Manager unreachable. Showing data from ${ageText(now, lastOkAt)}.` : 'Manager unreachable.';
    document.body.classList.add('stale');
  } else {
    $('live').textContent = `Live · updated ${ageText(now, lastOkAt)}`;
    document.body.classList.remove('stale');
  }
}

function renderBanners(s) {
  const box = $('banners');
  box.replaceChildren();
  const add = (tone, text) => box.append(h('p', { class: `banner ${tone}`, text }));
  if (s.lease) {
    const job = s.workloads.find((w) => w.id === s.lease.jobId);
    add('info', `${job?.name || 'A job'} has the GPU for ${s.lease.holder} (${s.lease.state}).`);
  }
  for (const p of s.pending || []) {
    const why = String(p.blockedReason || '').replace(/^blocked:\s*/i, '');
    add('warn', `${p.name}: ${why}`);
  }
  if (!s.vram.ok) add('warn', `GPU memory cannot be read (${s.vram.error}). Plans use the configured GPU size.`);
  if (!s.backends.gpu.up) add('bad', 'The GPU Ollama instance is not answering. Requests go to the CPU instance.');
  if (!s.backends.cpu.up) add('bad', 'The CPU Ollama instance is not answering. Models on the GPU keep serving, but there is no fallback.');
}

function renderVram(s) {
  const bar = $('vram-bar');
  const legend = $('vram-legend');
  bar.replaceChildren();
  legend.replaceChildren();
  const segs = vramSegments(s);
  if (!segs.length) {
    bar.className = 'bar unknown';
    bar.setAttribute('aria-label', 'GPU memory unknown');
    bar.textContent = 'GPU memory is not readable right now.';
    return;
  }
  bar.className = 'bar';
  let w = 0;
  const parts = [];
  for (const seg of segs) {
    const cls = seg.kind === 'workload' ? `w${w++ % 4}` : seg.kind;
    const el = h('div', { class: `seg ${cls}`, title: `${seg.label}: ${fmtMiB(seg.mib)}` });
    el.style.width = `${seg.pct}%`;
    if (seg.pct >= 14) el.textContent = `${seg.label} ${seg.mib.toLocaleString('en-US')}`;
    bar.append(el);
    legend.append(h('li', {}, h('i', { class: cls }), `${seg.label} ${fmtMiB(seg.mib)}`));
    parts.push(`${seg.label} ${seg.mib} MiB`);
  }
  bar.setAttribute('aria-label', `GPU memory, ${fmtMiB(s.vram.totalMiB)} total: ${parts.join(', ')}`);
}

function failoverText(f, now) {
  return `Last failover ${f.from} → ${f.to} (${f.reason}), ${ageText(now, f.t)}.`;
}

function buildRow(w) {
  const refs = {};
  refs.prio = h('span', { class: 'prio' });
  refs.name = h('span', { class: 'name' });
  refs.tag = h('span', { class: 'tag' });
  refs.badge = h('span', { class: 'badge' });
  refs.up = h('button', { type: 'button', onclick: () => move(w.id, -1) }, '↑');
  refs.down = h('button', { type: 'button', onclick: () => move(w.id, +1) }, '↓');
  refs.more = h('button', { type: 'button', 'aria-expanded': 'false', onclick: () => toggleDrawer(w.id) }, 'Details');
  refs.note = h('p', { class: 'note', hidden: true });
  refs.facts = h('p', { class: 'facts' });
  refs.drawer = buildDrawer(w, refs);
  const li = h('li', { class: 'row', 'data-id': w.id },
    h('div', { class: 'row-main' },
      refs.prio,
      h('div', {}, refs.name, refs.tag),
      refs.badge,
      h('div', { class: 'ctl' }, refs.up, refs.down, refs.more),
      refs.note, refs.facts, refs.drawer.el));
  return { li, refs };
}

function numberField(name, label, value) {
  const input = h('input', { name, inputmode: 'numeric', autocomplete: 'off' });
  input.value = value ?? '';
  return { input, label: h('label', {}, label, input) };
}

function buildDrawer(w, refs) {
  const el = h('form', { class: 'drawer form', hidden: true, novalidate: true });
  const f = {};
  f.full = numberField('fullGpuMiB', 'Full GPU need (MiB)');
  f.min = numberField('minUsefulGpuMiB', 'Smallest useful GPU share (MiB)');
  el.append(f.full.label, f.min.label);
  if (w.kind === 'ollama') {
    f.layers = numberField('layers', 'Layers');
    f.partial = h('input', { type: 'checkbox', name: 'allowPartial' });
    el.append(f.layers.label, h('label', { class: 'check' }, f.partial, 'Allow splitting between GPU and CPU'));
  } else {
    f.idle = h('input', { type: 'checkbox', name: 'reserveWhenIdle' });
    el.append(h('label', { class: 'check' }, f.idle, 'Keep its GPU memory reserved while idle'));
  }
  const msg = h('p', { class: 'msg', role: 'status' });
  const save = h('button', { type: 'submit' }, 'Save');
  const actions = h('div', { class: 'actions' }, save);
  if (!w.builtin) actions.append(h('button', { type: 'button', class: 'danger', onclick: () => removeWorkload(w.id) }, 'Remove'));
  actions.append(msg);
  el.append(actions);
  el.addEventListener('input', () => { el.dataset.dirty = '1'; });
  el.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const values = {
      fullGpuMiB: f.full.input.value, minUsefulGpuMiB: f.min.input.value,
      layers: f.layers?.input.value, allowPartial: f.partial?.checked, reserveWhenIdle: f.idle?.checked,
    };
    const { patch, errors } = parseWorkloadForm(w.kind, values);
    if (errors.length) return say(msg, errors.join(' '), 'bad');
    await act(msg, () => api('PUT', `/api/workloads/${encodeURIComponent(w.id)}`, patch), 'Saved.', () => { delete el.dataset.dirty; });
    return undefined;
  });
  return { el, f, msg };
}

function fillDrawer(w, drawer) {
  if (drawer.el.dataset.dirty) return; // never overwrite something being edited
  drawer.f.full.input.value = w.fullGpuMiB ?? '';
  drawer.f.min.input.value = w.minUsefulGpuMiB ?? '';
  if (drawer.f.layers) drawer.f.layers.input.value = w.layers ?? '';
  if (drawer.f.partial) drawer.f.partial.checked = Boolean(w.allowPartial);
  if (drawer.f.idle) drawer.f.idle.checked = Boolean(w.reserveWhenIdle);
}

function renderRows(s) {
  const list = $('rows');
  const ids = new Set(s.workloads.map((w) => w.id));
  for (const [id, entry] of rowEls) if (!ids.has(id)) { entry.li.remove(); rowEls.delete(id); openDrawers.delete(id); }
  const now = s.now;
  s.workloads.forEach((w, index) => {
    if (!rowEls.has(w.id)) rowEls.set(w.id, buildRow(w));
    const { li, refs } = rowEls.get(w.id);
    refs.prio.textContent = String(w.priority);
    refs.name.textContent = w.name;
    refs.tag.textContent = w.tag || 'job';
    const badge = placementBadge(w);
    refs.badge.textContent = badge.text;
    refs.badge.className = `badge ${badge.tone}`;
    refs.up.disabled = busy || index === 0;
    refs.down.disabled = busy || index === s.workloads.length - 1;
    refs.up.setAttribute('aria-label', `Raise priority of ${w.name}`);
    refs.down.setAttribute('aria-label', `Lower priority of ${w.name}`);
    const note = rowNote(w);
    refs.note.hidden = !note;
    refs.note.textContent = note || '';
    const facts = [];
    if (w.kind === 'ollama') facts.push(`In flight: GPU ${w.inflight.gpu}, CPU ${w.inflight.cpu}.`, `Needs ${fmtMiB(w.fullGpuMiB)} for the GPU.`);
    else facts.push(`Needs ${fmtMiB(w.fullGpuMiB)} while rendering.`);
    if (w.lastFailover) facts.push(failoverText(w.lastFailover, now));
    refs.facts.textContent = facts.join(' ');
    fillDrawer(w, refs.drawer);
    list.append(li); // append moves an existing node, which also puts the rows in priority order
  });
}

function toggleDrawer(id) {
  const entry = rowEls.get(id);
  if (!entry) return;
  const open = entry.refs.drawer.el.hidden;
  entry.refs.drawer.el.hidden = !open;
  entry.refs.more.setAttribute('aria-expanded', String(open));
  if (open) openDrawers.add(id); else openDrawers.delete(id);
}

function renderEvents(s) {
  const list = $('events');
  list.replaceChildren();
  const recent = [...s.events].slice(-MAX_EVENTS_SHOWN).reverse();
  if (!recent.length) list.append(h('li', {}, h('time'), h('span', { text: 'Nothing yet.' })));
  for (const e of recent) {
    const v = eventView(e);
    list.append(h('li', { class: v.level }, h('time', { text: v.time }), h('span', { text: v.text })));
  }
}

function renderForms(s) {
  const form = $('settings');
  if (!form.dataset.dirty) {
    form.elements.reservedMiB.value = s.settings.reservedMiB;
    form.elements.gpuTotalMiB.value = s.settings.gpuTotalMiB ?? '';
    form.elements.drainTimeoutSec.value = s.settings.drainTimeoutSec;
    form.elements.minDwellSec.value = s.settings.minDwellSec;
  }
}

function render(s) {
  current = s;
  $('summary').textContent = summaryLine(s) || 'No models managed.';
  renderBanners(s);
  renderVram(s);
  renderRows(s);
  renderEvents(s);
  renderForms(s);
}

// ---- actions -------------------------------------------------------------------------------------------------

async function act(msgEl, fn, okText, afterOk) {
  if (busy) return;
  busy = true;
  say(msgEl, 'Working…');
  try {
    await fn();
    say(msgEl, okText, 'ok');
    afterOk?.();
    await refresh();
  } catch (err) {
    say(msgEl, err.message, 'bad');
  } finally {
    busy = false;
    if (current) render(current);
  }
}

async function move(id, dir) {
  if (!current || busy) return;
  const next = moveInOrder(current.workloads.map((w) => w.id), id, dir);
  if (!next) return;
  busy = true;
  render(current);
  try {
    await api('PUT', '/api/order', { order: next });
    await refresh();
  } catch (err) {
    $('banners').prepend(h('p', { class: 'banner bad', text: `Could not change the order: ${err.message}` }));
  } finally {
    busy = false;
    if (current) render(current);
    const entry = rowEls.get(id);
    (dir < 0 ? entry?.refs.up : entry?.refs.down)?.focus();
  }
}

async function removeWorkload(id) {
  const w = current?.workloads.find((x) => x.id === id);
  if (!w || !window.confirm(`Remove ${w.name}? It will be unloaded from both Ollama instances.`)) return;
  const msg = rowEls.get(id).refs.drawer.msg;
  await act(msg, () => api('DELETE', `/api/workloads/${encodeURIComponent(id)}`), 'Removed.');
}

$('settings').addEventListener('input', () => { $('settings').dataset.dirty = '1'; });
$('settings').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const form = $('settings');
  const values = Object.fromEntries(['reservedMiB', 'gpuTotalMiB', 'drainTimeoutSec', 'minDwellSec'].map((k) => [k, form.elements[k].value]));
  const { patch, errors } = parseSettingsForm(values);
  if (errors.length) return say($('settings-msg'), errors.join(' '), 'bad');
  await act($('settings-msg'), () => api('PUT', '/api/settings', patch), 'Saved.', () => { delete form.dataset.dirty; });
  return undefined;
});

$('add').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const form = $('add');
  const values = {
    tag: form.elements.tag.value, name: form.elements.name.value, layers: form.elements.layers.value,
    fullGpuMiB: form.elements.fullGpuMiB.value, minUsefulGpuMiB: form.elements.minUsefulGpuMiB.value,
    allowPartial: form.elements.allowPartial.checked,
  };
  const { def, errors } = parseAddForm(values);
  if (errors.length) return say($('add-msg'), errors.join(' '), 'bad');
  await act($('add-msg'), () => api('POST', '/api/workloads', def), 'Added.', () => form.reset());
  return undefined;
});

async function loadModels() {
  const select = $('add-tag');
  try {
    const { models } = await api('GET', '/api/models');
    const taken = new Set((current?.workloads || []).map((w) => w.tag).filter(Boolean));
    select.replaceChildren(h('option', { value: '', text: models.length ? 'Choose a model…' : 'No models installed' }));
    for (const tag of models.filter((m) => !taken.has(m))) select.append(h('option', { value: tag, text: tag }));
  } catch (err) {
    select.replaceChildren(h('option', { value: '', text: `Cannot list models: ${err.message}` }));
  }
}

// ---- polling -------------------------------------------------------------------------------------------------

async function refresh() {
  try {
    render(await api('GET', '/api/status'));
    lastOkAt = Date.now();
    failures = 0;
  } catch (err) {
    failures += 1;
    if (err.status === 401 || err.status === 403) {
      $('summary').textContent = 'Not signed in. Reload the page to sign in again.';
    }
  }
  renderLive();
}

async function loop() {
  await refresh();
  setTimeout(loop, failures ? Math.min(15_000, POLL_MS * 2 ** Math.min(failures, 3)) : POLL_MS);
}

setInterval(renderLive, 1000);
await refresh();
await loadModels();
setTimeout(loop, POLL_MS);
