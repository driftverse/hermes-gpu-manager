// GPU priority manager: turns the planner's output into real placements and keeps them true.
//
// Placement apply procedure for an Ollama workload (per workload, serialised by a worker, re-entrant):
//   1. compute the plan (planner.mjs) from state + measured VRAM
//   2. make sure the CPU instance has the model loaded (required before anything leaves the GPU)
//   3. point the router at where NEW requests must go (cpu while anything is changing)
//   4. if something must leave the GPU: router.drain('gpu', drainTimeoutSec) then unload it with keep_alive 0.
//      A drain timeout never kills anything: the transition stays pending as "blocked: still serving N
//      request(s)" and is retried on a timer.
//   5. verify through /api/ps and report ACTUAL placement
// Moving onto the GPU happens only when the probe shows enough free VRAM; the router is flipped to the GPU
// only after the preload succeeded and /api/ps shows the model resident.
//
// Anti-thrash: a change of the router route needs `minDwellSec` since the previous change, unless it is forced
// (job leases, POST /api/apply). Failures back off exponentially (10 s .. 5 min).

import { randomUUID } from 'node:crypto';
import { planWorkloads } from './planner.mjs';
import { variantTag } from './ollama.mjs';
import { defaultState, validateSettings, validateWorkloadDef } from './state.mjs';

const MAX_EVENTS = 100;
const FULL_GPU_FRACTION = 0.95;
// A failed GPU/CPU split is retried only once this much more GPU memory is free than when it failed.
const SPLIT_RETRY_GAIN_MIB = 300;
const FALLBACK_GPU_TOTAL_MIB = 4096;
const BACKOFF_BASE_MS = 10_000;
const BACKOFF_MAX_MS = 300_000;
const EDITABLE_FIELDS = new Set(['name', 'layers', 'fullGpuMiB', 'minUsefulGpuMiB', 'allowPartial', 'reserveWhenIdle']);
const SUPERSEDED = Symbol('superseded');

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const norm = (name) => (name.includes(':') ? name : `${name}:latest`);
const settleCall = (p) => p.then((value) => ({ ok: true, value }), (error) => ({ ok: false, error: String(error?.message || error) }));

export function createRealClock() {
  return {
    now: () => Date.now(),
    setTimeout(fn, ms) { const h = setTimeout(fn, ms); h.unref?.(); return h; },
    clearTimeout: (h) => clearTimeout(h),
    sleep: (ms) => new Promise((resolve) => { const h = setTimeout(resolve, ms); h.unref?.(); }),
  };
}

export function createManager({
  store, router, ollama, probe,
  clock = createRealClock(),
  reconcileMs = 10_000, obsTtlMs = 1500, retryMs = 2000, pollMs = 500,
}) {
  let state = defaultState();
  let obs = null;
  let obsPromise = null;
  let plan = null;
  let lease = null;
  let cachedExternalMiB = 0;
  let reconcileTimer = null;
  let stopped = false;
  const events = [];
  const rt = new Map();
  const retiring = new Map(); // id -> { w, promise }
  const flags = { probeDown: null, gpuUp: null, cpuUp: null };

  // ---- small helpers -------------------------------------------------------------------------

  const R = (id) => {
    if (!rt.has(id)) {
      rt.set(id, { worker: null, dirty: false, force: false, pending: null, lastChangeAt: -Infinity, targetSig: null, wake: null, retryHandle: null, lastMessage: null, failures: 0, nextAttemptAt: 0, splitFailed: null });
    }
    return rt.get(id);
  };
  const ordered = () => state.order.map((id) => state.workloads[id]);
  const wlName = (id) => state.workloads[id]?.name || id;

  function log(level, type, message, extra = {}) {
    events.push({ t: clock.now(), level, type, message, ...extra });
    if (events.length > MAX_EVENTS) events.shift();
  }

  const labelOf = (t) => (t.mode === 'gpu' ? 'the GPU' : t.mode === 'partial' ? `a GPU/CPU split (${t.gpuLayers} layers on the GPU)` : 'the CPU');
  const describe = (a) => (a.mode === 'gpu' ? 'the GPU' : a.mode === 'partial' ? `a split (${a.gpuLayers} layers on the GPU)` : a.mode === 'cpu' ? 'the CPU' : a.mode === 'unloaded' ? 'nowhere (not loaded)' : 'an unknown place');

  const isActive = (w) => w.kind === 'ollama' || Boolean(w.reserveWhenIdle) || (lease !== null && lease.jobId === w.id);

  const ownsName = (w, name) => {
    const n = norm(name);
    const base = norm(w.tag);
    return n === base || (n.startsWith(`${w.tag}-g`) && /-g\d+(:latest)?$/.test(n));
  };

  async function persist(next) {
    await store.save(next);
    state = next;
  }

  // ---- observation ---------------------------------------------------------------------------

  async function refresh() {
    if (obsPromise) return obsPromise;
    obsPromise = (async () => {
      const [snap, gpuPs, cpuPs] = await Promise.all([probe.snapshot(), settleCall(ollama.ps('gpu')), settleCall(ollama.ps('cpu'))]);
      obs = {
        at: clock.now(),
        probe: snap,
        ps: { gpu: gpuPs.ok ? gpuPs.value : null, cpu: cpuPs.ok ? cpuPs.value : null },
        errors: { gpu: gpuPs.ok ? null : gpuPs.error, cpu: cpuPs.ok ? null : cpuPs.error },
      };
      noteHealth(snap, gpuPs.ok, cpuPs.ok);
      return obs;
    })().finally(() => { obsPromise = null; });
    return obsPromise;
  }

  function noteHealth(snap, gpuUp, cpuUp) {
    const probeDown = !snap.ok;
    if (flags.probeDown !== probeDown) {
      if (probeDown) log('warn', 'probe', `Cannot read GPU memory (${snap.error}); using the configured GPU size and the last known usage.`);
      else if (flags.probeDown !== null) log('info', 'probe', 'GPU memory readings are back.');
      flags.probeDown = probeDown;
    }
    for (const [name, up] of [['gpu', gpuUp], ['cpu', cpuUp]]) {
      if (flags[`${name}Up`] !== up) {
        if (!up) log('warn', 'backend', `The ${name.toUpperCase()} Ollama instance is not answering.`);
        else if (flags[`${name}Up`] !== null) log('info', 'backend', `The ${name.toUpperCase()} Ollama instance is back.`);
        flags[`${name}Up`] = up;
      }
    }
  }

  async function observe(maxAgeMs = obsTtlMs) {
    if (obs && clock.now() - obs.at <= maxAgeMs) return obs;
    return refresh();
  }

  // Memory held by managed processes, from the compute-apps list (names containing "ollama"); falls back
  // to the sum of size_vram from /api/ps when the process list is unavailable.
  function managedGpuMiB() {
    const apps = obs?.probe?.ok ? obs.probe.apps : [];
    const ollamaApps = apps.filter((a) => /ollama/i.test(a.name));
    if (ollamaApps.length) return ollamaApps.reduce((s, a) => s + a.usedMiB, 0);
    return (obs?.ps?.gpu || []).filter((m) => ordered().some((w) => w.kind === 'ollama' && ownsName(w, m.name))).reduce((s, m) => s + m.sizeVramMiB, 0);
  }

  // Non-managed VRAM. While a job lease is held the job's own usage cannot be told apart from the desktop's,
  // so the value measured before the lease started is used.
  function externalMiB() {
    if (lease) return cachedExternalMiB;
    if (!obs?.probe?.ok) return cachedExternalMiB;
    cachedExternalMiB = Math.max(0, obs.probe.usedMiB - managedGpuMiB());
    return cachedExternalMiB;
  }

  function classify(w) {
    if (!obs) return { mode: 'unknown', gpuMiB: 0, gpuLayers: 0, note: 'not observed yet' };
    const { gpu, cpu } = obs.ps;
    if (gpu === null && cpu === null) return { mode: 'unknown', gpuMiB: 0, gpuLayers: 0, note: 'neither Ollama instance answered' };
    const held = (gpu || []).filter((m) => ownsName(w, m.name));
    const onGpu = held.find((m) => m.sizeVramBytes > 0);
    if (onGpu) {
      const variant = /-g(\d+)(:latest)?$/.exec(onGpu.name);
      if (variant || onGpu.vramFraction < FULL_GPU_FRACTION) {
        const gpuLayers = variant ? Number(variant[1]) : Math.max(1, Math.round((w.layers || 0) * onGpu.vramFraction));
        return { mode: 'partial', gpuMiB: onGpu.sizeVramMiB, gpuLayers, where: 'gpu', model: onGpu.name };
      }
      return { mode: 'gpu', gpuMiB: onGpu.sizeVramMiB, gpuLayers: null, where: 'gpu', model: onGpu.name };
    }
    const onCpu = (cpu || []).some((m) => norm(m.name) === norm(w.tag)) || held.length > 0;
    if (onCpu) return { mode: 'cpu', gpuMiB: 0, gpuLayers: 0, where: held.length ? 'gpu-instance' : 'cpu' };
    if (gpu === null || cpu === null) return { mode: 'unknown', gpuMiB: 0, gpuLayers: 0, note: `the ${gpu === null ? 'GPU' : 'CPU'} instance did not answer` };
    return { mode: 'unloaded', gpuMiB: 0, gpuLayers: 0 };
  }

  const cpuWarm = (w) => (obs?.ps?.cpu || []).some((m) => norm(m.name) === norm(w.tag));
  const routeOf = (w) => router.getPlan(w.tag)?.route ?? null;

  // What would have to change for `w` to match `target`, given the current observation?
  function evaluate(w, target) {
    const route = target.mode === 'idle' ? 'cpu' : target.mode;
    const needName = route === 'gpu' ? w.tag : route === 'partial' ? variantTag(w.tag, target.gpuLayers) : null;
    const gpuHeld = (obs.ps.gpu || []).filter((m) => ownsName(w, m.name));
    const holdsNeed = needName
      ? gpuHeld.find((m) => norm(m.name) === norm(needName) && m.sizeVramBytes > 0 && (route === 'partial' || m.vramFraction >= FULL_GPU_FRACTION))
      : null;
    const leave = gpuHeld.filter((m) => m !== holdsNeed);
    const routeVariant = route === 'partial' ? needName : undefined;
    const routed = router.getPlan(w.tag);
    const placed = route === 'cpu'
      ? leave.length === 0 && routed?.route === 'cpu'
      : Boolean(holdsNeed) && routed?.route === route && routed?.variantTag === routeVariant;
    return { route, needName, holdsNeed, leave, routeVariant, placed, settled: placed && cpuWarm(w) };
  }

  // ---- planning ------------------------------------------------------------------------------

  function computePlan() {
    const snap = obs?.probe;
    const gpuTotalMiB = state.settings.gpuTotalMiB ?? (snap?.ok ? snap.totalMiB : FALLBACK_GPU_TOTAL_MIB);
    const external = externalMiB();
    // A split that failed to load is not offered again until clearly more GPU memory is free.
    for (const w of ordered()) {
      const r = R(w.id);
      if (r.splitFailed && snap?.ok && snap.freeMiB > r.splitFailed.freeMiB + SPLIT_RETRY_GAIN_MIB) {
        r.splitFailed = null;
        log('info', 'split-retry', `More GPU memory is free now; ${w.name} may try a GPU/CPU split again.`, { workload: w.id });
      }
    }
    plan = {
      at: clock.now(),
      ...planWorkloads({
        workloads: ordered().map((w) => ({ ...w, active: isActive(w), allowPartial: w.allowPartial && !R(w.id).splitFailed })),
        gpuTotalMiB,
        reservedMiB: state.settings.reservedMiB,
        externalUsedMiB: external,
      }),
      gpuTotalMiB,
      externalMiB: external,
    };
    return plan;
  }

  const placementFor = (id) => plan?.placements.find((p) => p.id === id);

  function replan({ force = false } = {}) {
    computePlan();
    for (const w of ordered()) {
      if (w.kind !== 'ollama') continue;
      const p = placementFor(w.id);
      const r = R(w.id);
      const sig = `${p.mode}:${p.gpuLayers}`;
      const changed = sig !== r.targetSig;
      if (changed) log('info', 'plan', `${w.name} should run on ${labelOf(p)}: ${p.reason}`, { workload: w.id });
      r.targetSig = sig;
      if (force) r.nextAttemptAt = 0;
      if (changed || force) kick(w.id, { force });
    }
  }

  // ---- converge workers ----------------------------------------------------------------------

  function kick(id, { force = false } = {}) {
    const r = R(id);
    if (force) r.force = true;
    r.dirty = true;
    if (r.worker) {
      r.wake?.();
      return r.worker;
    }
    r.worker = (async () => {
      try {
        while (r.dirty && !stopped) {
          r.dirty = false;
          try {
            await convergeOnce(id);
          } catch (err) {
            if (err !== SUPERSEDED) failed(id, err);
          }
        }
      } finally {
        r.worker = null;
      }
    })();
    return r.worker;
  }

  const checkSuperseded = (r) => { if (r.dirty) throw SUPERSEDED; };

  async function raceSupersede(r, promise) {
    try {
      return await Promise.race([promise, new Promise((_, reject) => { r.wake = () => reject(SUPERSEDED); })]);
    } finally {
      r.wake = null;
    }
  }

  function scheduleRetry(id, ms) {
    const r = R(id);
    if (r.retryHandle || stopped) return;
    r.retryHandle = clock.setTimeout(() => { r.retryHandle = null; kick(id); }, ms);
  }

  function block(id, target, reason, humanMessage, retryInMs = retryMs) {
    const r = R(id);
    const prev = r.pending;
    r.pending = { id, since: prev?.since ?? clock.now(), target: { mode: target.mode, gpuMiB: target.gpuMiB, gpuLayers: target.gpuLayers }, blockedReason: reason, attempts: (prev?.attempts ?? 0) + 1, forced: r.force };
    if (r.lastMessage !== humanMessage) {
      log('warn', 'blocked', humanMessage, { workload: id });
      r.lastMessage = humanMessage;
    }
    scheduleRetry(id, retryInMs);
  }

  function failed(id, err) {
    const r = R(id);
    const target = placementFor(id) || { mode: 'cpu', gpuMiB: 0, gpuLayers: 0 };
    r.failures += 1;
    const wait = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (r.failures - 1));
    r.nextAttemptAt = clock.now() + wait;
    block(id, target, `error: ${err.message}`, `Could not finish moving ${wlName(id)}: ${err.message}`, wait);
  }

  function succeed(id, w, target) {
    const r = R(id);
    if (r.pending || r.lastMessage !== `ok:${target.mode}`) log('info', 'applied', `${w.name} is now on ${labelOf(target)}.`, { workload: id });
    r.pending = null;
    r.lastMessage = `ok:${target.mode}`;
    r.force = false;
    r.failures = 0;
    r.nextAttemptAt = 0;
  }

  function setRoute(w, route, tag) {
    const cur = router.getPlan(w.tag);
    if (cur && cur.route === route && cur.variantTag === tag) return;
    router.setPlan(w.tag, { route, variantTag: tag });
    R(w.id).lastChangeAt = clock.now();
  }

  async function ensureCpuWarm(w, required) {
    if (cpuWarm(w)) return true;
    try {
      await ollama.load('cpu', w.tag);
      await refresh();
      return true;
    } catch (err) {
      if (required) throw Object.assign(new Error(`the CPU instance could not load ${w.tag}: ${err.message}`), { cpuWarmFailure: true });
      const r = R(w.id);
      r.failures += 1;
      r.nextAttemptAt = clock.now() + Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (r.failures - 1));
      log('warn', 'cpu-warm', `Could not pre-load ${w.name} on the CPU instance: ${err.message}`, { workload: w.id });
      return false;
    }
  }

  async function convergeOnce(id) {
    const w = state.workloads[id];
    if (!w || w.kind !== 'ollama') return;
    const r = R(id);
    const target = placementFor(id);
    if (!target) return;
    await refresh();
    checkSuperseded(r);

    const ev = evaluate(w, target);
    const { route, needName, holdsNeed, leave, routeVariant } = ev;

    if (ev.placed) {
      succeed(id, w, target);
      if (!cpuWarm(w)) await ensureCpuWarm(w, false);
      return;
    }

    // Anti-thrash: changing the route needs the dwell time since the previous change, unless forced.
    const dwellMs = state.settings.minDwellSec * 1000;
    const sinceChange = clock.now() - r.lastChangeAt;
    if (!r.force && (routeOf(w) ?? 'cpu') !== route && sinceChange < dwellMs) {
      const remainingMs = dwellMs - sinceChange;
      return block(id, target, `holding for ${Math.ceil(remainingMs / 1000)} s to avoid thrashing before moving ${w.name} to ${labelOf(target)}`,
        `Holding ${w.name} in place for the minimum ${state.settings.minDwellSec} s between moves before sending it to ${labelOf(target)}`, remainingMs);
    }

    if (route === 'cpu' || leave.length) {
      try {
        await ensureCpuWarm(w, true);
      } catch (err) {
        if (!err.cpuWarmFailure) throw err;
        return block(id, target, `blocked: ${err.message}`, `Not moving ${w.name} off the GPU: ${err.message}`);
      }
      checkSuperseded(r);
      setRoute(w, 'cpu');
    }

    if (leave.length) {
      try {
        await raceSupersede(r, router.drain('gpu', state.settings.drainTimeoutSec * 1000));
      } catch (err) {
        if (err === SUPERSEDED) throw err;
        if (err.code === 'DRAIN_TIMEOUT') {
          const n = err.inflight;
          return block(id, target, `blocked: still serving ${n} request(s)`, `Waiting for ${n} request${n === 1 ? '' : 's'} to finish before moving ${w.name} to ${labelOf(target)}`);
        }
        throw err;
      }
      checkSuperseded(r);
      for (const m of leave) await ollama.unload('gpu', m.name);
      await refresh();
      const still = (obs.ps.gpu || []).filter((m) => leave.some((l) => norm(l.name) === norm(m.name)));
      if (still.length) return block(id, target, `blocked: the GPU instance still lists ${still[0].name}`, `${w.name} did not leave the GPU instance after being unloaded; will retry.`);
    }

    if (route === 'cpu') {
      setRoute(w, 'cpu');
      return succeed(id, w, target);
    }

    if (!holdsNeed) {
      const snap = obs.probe;
      if (!snap.ok) return block(id, target, `blocked: GPU probe unavailable (${snap.error})`, `Not moving ${w.name} onto the GPU: cannot read GPU memory.`);
      if (snap.freeMiB < target.gpuMiB) {
        return block(id, target, `blocked: waiting for GPU memory (need ${target.gpuMiB} MiB, ${snap.freeMiB} MiB free)`, `Waiting for ${target.gpuMiB - snap.freeMiB} MiB of GPU memory to be freed before moving ${w.name} to ${labelOf(target)}`);
      }
      try {
        if (route === 'partial') await ollama.ensureVariant({ base: w.tag, gpuLayers: target.gpuLayers });
        checkSuperseded(r);
        await ollama.load('gpu', needName);
      } catch (err) {
        if (err === SUPERSEDED || route !== 'partial') throw err;
        // A split can fail even when the weights fit: the compute buffers scale with the context window.
        // Remember it for the current amount of free memory, run on the CPU, and say why.
        r.splitFailed = { freeMiB: snap.freeMiB };
        try { await ollama.unload('gpu', needName); } catch { /* it never loaded */ }
        log('warn', 'split-failed', `${w.name} could not load as a GPU/CPU split (${err.message}). Running on the CPU until more GPU memory is free.`, { workload: id });
        r.pending = null;
        replan();
        return;
      }
      await refresh();
      const entry = (obs.ps.gpu || []).find((m) => norm(m.name) === norm(needName));
      if (!entry || entry.sizeVramBytes === 0) {
        return block(id, target, 'blocked: preload finished but the model is not resident on the GPU', `${w.name} loaded on the GPU instance but Ollama kept it on the CPU; not routing to the GPU.`);
      }
      if (route === 'gpu' && entry.vramFraction < FULL_GPU_FRACTION) {
        await ollama.unload('gpu', needName);
        return block(id, target, `blocked: Ollama placed only ${Math.round(entry.vramFraction * 100)}% on the GPU`, `Ollama could only put ${Math.round(entry.vramFraction * 100)}% of ${w.name} on the GPU, so it was unloaded again.`);
      }
    }

    setRoute(w, route, routeVariant);
    succeed(id, w, target);
    if (!cpuWarm(w)) await ensureCpuWarm(w, false);
  }

  // Removing a workload: send new requests to the CPU, drain, unload from both instances, forget its route.
  function retire(w) {
    const existing = retiring.get(w.id);
    if (existing?.running) return existing.promise;
    const entry = { w, running: true, promise: null };
    entry.promise = (async () => {
      try {
        router.setPlan(w.tag, { route: 'cpu' });
        await refresh();
        const onGpu = (obs.ps.gpu || []).filter((m) => ownsName(w, m.name));
        if (onGpu.length) {
          try {
            await router.drain('gpu', state.settings.drainTimeoutSec * 1000);
          } catch (err) {
            if (err.code !== 'DRAIN_TIMEOUT') throw err;
            log('warn', 'blocked', `Waiting for ${err.inflight} request${err.inflight === 1 ? '' : 's'} to finish before unloading the removed model ${w.name}`, { workload: w.id });
            return;
          }
          for (const m of onGpu) await ollama.unload('gpu', m.name);
        }
        for (const m of (obs.ps.cpu || []).filter((x) => ownsName(w, x.name))) await ollama.unload('cpu', m.name);
        router.clearPlan(w.tag);
        retiring.delete(w.id);
        log('info', 'removed', `${w.name} was removed and unloaded.`, { workload: w.id });
      } catch (err) {
        log('error', 'removed', `Could not fully unload the removed model ${w.name}: ${err.message}`, { workload: w.id });
      } finally {
        entry.running = false;
      }
    })();
    retiring.set(w.id, entry);
    return entry.promise;
  }

  async function idle() {
    for (;;) {
      const running = [...rt.values()].map((r) => r.worker).filter(Boolean);
      running.push(...[...retiring.values()].filter((e) => e.running).map((e) => e.promise));
      if (!running.length) return;
      await Promise.allSettled(running);
    }
  }

  // ---- job leases ----------------------------------------------------------------------------

  const jobWorkload = (jobId = 'musetalk') => {
    const w = state.workloads[jobId];
    return w && w.kind === 'job' ? w : null;
  };

  async function acquireLease({ holder = 'unknown', jobId = 'musetalk', wait = false, timeoutSec } = {}) {
    const job = jobWorkload(jobId);
    if (!job) return { ok: false, reason: `unknown job: ${jobId}` };
    const timeoutMs = (timeoutSec ?? state.settings.leaseAcquireTimeoutSec) * 1000;
    const deadline = clock.now() + timeoutMs;

    while (lease) {
      if (!wait) return { ok: false, reason: `busy: lease held by ${lease.holder}`, holder: lease.holder, since: lease.requestedAt };
      if (clock.now() >= deadline) return { ok: false, reason: `timed out waiting for the lease held by ${lease.holder}` };
      await clock.sleep(pollMs);
    }

    await refresh();
    const mine = { id: randomUUID(), jobId, holder, state: 'acquiring', requestedAt: clock.now(), lastHeartbeat: clock.now() };
    computePlan(); // measure external usage before the job takes over
    lease = mine;
    log('info', 'lease', `${job.name} asked for the GPU (${holder}).`, { workload: jobId });
    replan({ force: true });

    const rollback = (reason) => {
      if (lease === mine) lease = null;
      log('warn', 'lease', `${job.name} could not get the GPU: ${reason}`, { workload: jobId });
      replan({ force: true });
      return { ok: false, reason };
    };

    for (;;) {
      if (lease !== mine) return { ok: false, reason: 'lease was released while waiting' };
      await refresh();
      const p = placementFor(jobId);
      if (p.mode !== 'gpu') return rollback(`cannot fit: ${p.reason}`);
      const snap = obs.probe;
      if (snap.ok && snap.freeMiB >= job.fullGpuMiB) {
        mine.state = 'active';
        mine.activeAt = clock.now();
        mine.lastHeartbeat = clock.now();
        log('info', 'lease', `${job.name} has the GPU (${snap.freeMiB} MiB free).`, { workload: jobId });
        return { ok: true, leaseId: mine.id };
      }
      if (clock.now() >= deadline) {
        const blockers = [...rt.values()].filter((r) => r.pending).map((r) => r.pending.blockedReason);
        const have = snap.ok ? `${snap.freeMiB} MiB free` : `GPU probe unavailable: ${snap.error}`;
        return rollback(`timed out after ${Math.round(timeoutMs / 1000)} s waiting for ${job.fullGpuMiB} MiB of GPU memory (${have}${blockers.length ? `; ${blockers.join('; ')}` : ''})`);
      }
      await clock.sleep(pollMs);
    }
  }

  async function releaseLease({ leaseId } = {}) {
    if (!lease || lease.id !== leaseId) return { ok: false, reason: 'unknown or expired lease', code: 'unknown_lease' };
    const job = jobWorkload(lease.jobId);
    log('info', 'lease', `${job?.name || 'Job'} released the GPU; restoring the other placements.`, { workload: lease.jobId });
    lease = null;
    // The reading taken while the job ran still counts its memory as "external"; re-plan from a fresh one.
    await refresh();
    replan({ force: true });
    return { ok: true };
  }

  async function heartbeatLease({ leaseId } = {}) {
    if (!lease || lease.id !== leaseId) return { ok: false, reason: 'unknown or expired lease', code: 'unknown_lease' };
    lease.lastHeartbeat = clock.now();
    return { ok: true, expiresInSec: state.settings.leaseTtlSec };
  }

  function expireLease() {
    if (!lease) return;
    const ttlMs = state.settings.leaseTtlSec * 1000;
    if (clock.now() - lease.lastHeartbeat <= ttlMs) return;
    const job = jobWorkload(lease.jobId);
    log('warn', 'lease', `${job?.name || 'Job'} lease from ${lease.holder} expired after ${state.settings.leaseTtlSec} s without a heartbeat; giving the GPU back.`, { workload: lease.jobId });
    lease = null;
    replan({ force: true });
  }

  // ---- reconcile loop ------------------------------------------------------------------------

  async function reconcile() {
    await refresh();
    expireLease();
    replan();
    for (const entry of retiring.values()) if (!entry.running) retire(entry.w);
    for (const w of ordered()) {
      if (w.kind !== 'ollama') continue;
      const r = R(w.id);
      if (r.worker) continue;
      const target = placementFor(w.id);
      if (!target || evaluate(w, target).settled) continue;
      if (clock.now() < r.nextAttemptAt) continue;
      if (!r.pending && r.lastMessage?.startsWith('ok:')) {
        log('warn', 'drift', `${w.name} drifted: it should be on ${labelOf(target)} but is on ${describe(classify(w))}. Correcting.`, { workload: w.id });
        r.lastMessage = null;
      }
      kick(w.id);
    }
  }

  function scheduleReconcile() {
    if (stopped) return;
    reconcileTimer = clock.setTimeout(async () => {
      try { await reconcile(); } catch (err) { log('error', 'reconcile', `Reconcile failed: ${err.message}`); }
      scheduleReconcile();
    }, reconcileMs);
  }

  // ---- configuration changes -----------------------------------------------------------------

  async function setOrder(ids) {
    if (!Array.isArray(ids)) throw new ApiError(400, 'order must be an array of workload ids');
    const current = state.order;
    const ok = ids.length === current.length && new Set(ids).size === ids.length && ids.every((id) => current.includes(id));
    if (!ok) throw new ApiError(400, 'order must be a permutation of the workload ids');
    await persist({ ...structuredClone(state), order: [...ids] });
    log('info', 'order', `Priority order changed: ${ids.map(wlName).join(' > ')}.`);
    replan();
    return { ok: true, order: [...ids] };
  }

  async function setSettings(patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new ApiError(400, 'settings must be an object');
    const { reserveWhenIdle, ...rest } = patch;
    const next = structuredClone(state);
    next.settings = { ...next.settings, ...rest };
    const verdict = validateSettings(next.settings);
    if (!verdict.ok) throw new ApiError(400, verdict.errors.join('; '));
    if (reserveWhenIdle !== undefined) {
      if (!reserveWhenIdle || typeof reserveWhenIdle !== 'object' || Array.isArray(reserveWhenIdle)) throw new ApiError(400, 'reserveWhenIdle must be an object of job ids to booleans');
      for (const [id, value] of Object.entries(reserveWhenIdle)) {
        if (next.workloads[id]?.kind !== 'job') throw new ApiError(400, `reserveWhenIdle applies to jobs only (${id})`);
        if (typeof value !== 'boolean') throw new ApiError(400, `reserveWhenIdle.${id} must be a boolean`);
        next.workloads[id].reserveWhenIdle = value;
      }
    }
    await persist(next);
    log('info', 'settings', 'Settings changed.');
    replan();
    return { ok: true, settings: { ...state.settings } };
  }

  async function addWorkload(def) {
    if (!def || typeof def !== 'object' || Array.isArray(def)) throw new ApiError(400, 'workload must be an object');
    if (def.kind !== undefined && def.kind !== 'ollama') throw new ApiError(400, "only workloads of kind 'ollama' can be added");
    if (def.builtin !== undefined) throw new ApiError(400, 'builtin cannot be set');
    const candidate = { ...def, kind: 'ollama' };
    const verdict = validateWorkloadDef(candidate);
    if (!verdict.ok) throw new ApiError(400, verdict.errors.join('; '));
    if (state.workloads[candidate.id]) throw new ApiError(409, `a workload with id ${candidate.id} already exists`);
    if (ordered().some((w) => w.kind === 'ollama' && norm(w.tag) === norm(candidate.tag))) throw new ApiError(409, `a workload for ${candidate.tag} already exists`);
    if (candidate.allowPartial && !candidate.layers) throw new ApiError(400, 'layers are required for partial offload');
    let tags;
    try {
      tags = await ollama.tags('cpu');
    } catch (err) {
      throw new ApiError(503, `cannot list Ollama models: ${err.message}`);
    }
    if (!tags.some((t) => norm(t) === norm(candidate.tag))) throw new ApiError(400, `tag ${candidate.tag} not found in Ollama`);
    const next = structuredClone(state);
    next.workloads[candidate.id] = candidate;
    next.order.push(candidate.id);
    await persist(next);
    log('info', 'workload', `Added ${candidate.name} (${candidate.tag}) at priority ${next.order.length}.`, { workload: candidate.id });
    replan();
    return { ok: true, workload: candidate };
  }

  async function removeWorkload(id) {
    const w = state.workloads[id];
    if (!w) throw new ApiError(404, `unknown workload: ${id}`);
    if (w.builtin) throw new ApiError(403, 'built-in workloads cannot be removed');
    const next = structuredClone(state);
    delete next.workloads[id];
    next.order = next.order.filter((x) => x !== id);
    await persist(next);
    const r = rt.get(id);
    if (r?.retryHandle) clock.clearTimeout(r.retryHandle);
    rt.delete(id);
    log('info', 'workload', `Removed ${w.name}.`, { workload: id });
    replan();
    if (w.kind === 'ollama') retire(w);
    return { ok: true };
  }

  async function updateWorkload(id, patch) {
    const w = state.workloads[id];
    if (!w) throw new ApiError(404, `unknown workload: ${id}`);
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new ApiError(400, 'patch must be an object');
    for (const key of Object.keys(patch)) {
      if (['id', 'tag', 'kind', 'builtin'].includes(key)) throw new ApiError(400, `${key} cannot be changed`);
      if (!EDITABLE_FIELDS.has(key)) throw new ApiError(400, `unknown field: ${key}`);
    }
    const merged = { ...w, ...patch };
    const verdict = validateWorkloadDef(merged);
    if (!verdict.ok) throw new ApiError(400, verdict.errors.join('; '));
    if (merged.kind === 'ollama' && merged.allowPartial && !merged.layers) throw new ApiError(400, 'layers are required for partial offload');
    const next = structuredClone(state);
    next.workloads[id] = merged;
    await persist(next);
    log('info', 'workload', `Updated ${merged.name}.`, { workload: id });
    replan();
    return { ok: true, workload: merged };
  }

  // Installed model tags (for the add-model form): from the CPU instance, which is always on.
  async function listModels() {
    try {
      return await ollama.tags('cpu');
    } catch (err) {
      throw new ApiError(503, `cannot list Ollama models: ${err.message}`);
    }
  }

  async function apply({ force = true } = {}) {
    await refresh();
    expireLease();
    replan({ force });
    return { ok: true };
  }

  // ---- status --------------------------------------------------------------------------------

  async function status() {
    // A monitoring view must not show a backend as up for seconds after it died: always take a fresh
    // reading (concurrent callers share one in-flight refresh, so polling clients cost one probe).
    await refresh();
    if (!plan) computePlan();
    const routerState = router.getState();
    const probeSnap = obs?.probe;
    const workloads = ordered().map((w, index) => {
      const planned = placementFor(w.id) || { mode: 'idle', gpuMiB: 0, gpuLayers: 0, reason: '' };
      const r = R(w.id);
      let actual;
      if (w.kind === 'job') {
        const holding = lease && lease.jobId === w.id && lease.state === 'active';
        actual = holding ? { mode: 'gpu', gpuMiB: w.fullGpuMiB, gpuLayers: null } : { mode: 'idle', gpuMiB: 0, gpuLayers: 0 };
      } else {
        actual = classify(w);
      }
      const routed = w.kind === 'ollama' ? routeOf(w) : null;
      const lastFailover = [...routerState.failovers].reverse().find((f) => w.tag && norm(f.model) === norm(w.tag)) || null;
      const byModel = w.tag ? routerState.byModel[w.tag] || { gpu: 0, cpu: 0 } : { gpu: 0, cpu: 0 };
      return {
        ...w,
        priority: index + 1,
        planned: { mode: planned.mode, gpuMiB: planned.gpuMiB, gpuLayers: planned.gpuLayers, reason: planned.reason },
        actual,
        routed,
        inflight: byModel,
        pending: r.pending ? { ...r.pending } : null,
        lastFailover,
        matches: w.kind === 'ollama' ? actual.mode === planned.mode && (planned.mode !== 'partial' || actual.gpuLayers === planned.gpuLayers) : true,
      };
    });
    return {
      now: clock.now(),
      settings: { ...state.settings },
      vram: {
        ok: Boolean(probeSnap?.ok),
        error: probeSnap?.ok ? null : probeSnap?.error || 'not measured yet',
        totalMiB: plan.gpuTotalMiB,
        usedMiB: probeSnap?.ok ? probeSnap.usedMiB : null,
        freeMiB: probeSnap?.ok ? probeSnap.freeMiB : null,
        externalMiB: plan.externalMiB,
        managedMiB: managedGpuMiB(),
        reservedMiB: state.settings.reservedMiB,
        budgetMiB: plan.budgetMiB,
        plannedFreeMiB: plan.freeMiB,
      },
      workloads,
      pending: workloads.filter((w) => w.pending).map((w) => ({ id: w.id, name: w.name, ...w.pending })),
      router: { inflight: routerState.inflight, byModel: routerState.byModel, totals: routerState.totals, failovers: routerState.failovers },
      lease: lease ? { id: lease.id, jobId: lease.jobId, holder: lease.holder, state: lease.state, requestedAt: lease.requestedAt, lastHeartbeat: lease.lastHeartbeat } : null,
      backends: {
        gpu: { up: obs?.ps.gpu != null, error: obs?.errors.gpu || null },
        cpu: { up: obs?.ps.cpu != null, error: obs?.errors.cpu || null },
      },
      events: events.slice(-MAX_EVENTS),
    };
  }

  // ---- lifecycle -----------------------------------------------------------------------------

  async function start() {
    stopped = false;
    const loaded = await store.load();
    state = loaded.state;
    if (loaded.migrated) {
      await store.save(state);
      log('info', 'state', 'Added the new built-in workloads to the saved state.');
    }
    if (loaded.recovered) log('warn', 'state', `The saved state could not be read (${loaded.reason}); using defaults. A copy was kept as state.json.bad.`);
    await refresh();
    replan({ force: true });
    scheduleReconcile();
  }

  async function stop() {
    stopped = true;
    if (reconcileTimer) clock.clearTimeout(reconcileTimer);
    for (const r of rt.values()) if (r.retryHandle) clock.clearTimeout(r.retryHandle);
    await idle().catch(() => {});
  }

  return {
    start, stop, idle, status, reconcile, apply, listModels,
    acquireLease, releaseLease, heartbeatLease,
    setOrder, setSettings, addWorkload, removeWorkload, updateWorkload,
    getState: () => structuredClone(state),
  };
}
