// Test harness for the manager: simulated machine + fake clock + fake router + journal of operations.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorld } from './world.mjs';
import { createOllamaAdapter } from '../../src/ollama.mjs';
import { createGpuProbe } from '../../src/probe.mjs';
import { createStateStore, defaultState } from '../../src/state.mjs';
import { createManager } from '../../src/manager.mjs';
import { until } from './net.mjs';

const flush = async () => { for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r)); };

export function createFakeClock(start = 1_700_000_000_000) {
  let t = start;
  let seq = 0;
  const timers = [];
  const clock = {
    now: () => t,
    setTimeout(fn, ms) { const h = { id: (seq += 1), at: t + ms, fn }; timers.push(h); return h; },
    clearTimeout(h) { const i = timers.indexOf(h); if (i >= 0) timers.splice(i, 1); },
    sleep(ms) { return new Promise((resolve) => clock.setTimeout(resolve, ms)); },
    async advance(ms) {
      const target = t + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at || a.id - b.id);
        const next = timers[0];
        if (!next || next.at > target) break;
        timers.shift();
        t = Math.max(t, next.at);
        next.fn();
        await flush();
      }
      t = target;
      await flush();
    },
    get timerCount() { return timers.length; },
  };
  return clock;
}

export function createFakeRouter(journal) {
  const key = (m) => (m.includes(':') ? m : `${m}:latest`);
  const plans = new Map();
  const router = {
    plans,
    inflight: { gpu: 0, cpu: 0 },
    drainImpl: async () => {},
    setPlan(model, p) { plans.set(key(model), { route: p.route, variantTag: p.variantTag }); journal.push({ op: 'route', model, route: p.route, variantTag: p.variantTag }); },
    clearPlan(model) { plans.delete(key(model)); journal.push({ op: 'clearPlan', model }); },
    getPlan(model) { return plans.get(key(model)) || null; },
    drain(backend, ms) { journal.push({ op: 'drain', backend, ms }); return router.drainImpl(backend, ms); },
    getState() {
      return { backends: {}, plan: Object.fromEntries(plans), inflight: { ...router.inflight }, byModel: {}, totals: { requests: 0, failovers: 0, aborts: 0, errors: 0, tooLarge: 0 }, failovers: [], events: [] };
    },
  };
  return router;
}

export function drainTimeout(n, backend = 'gpu') {
  const err = new Error(`drain timed out: still serving ${n} request(s) on ${backend}`);
  err.code = 'DRAIN_TIMEOUT';
  err.inflight = n;
  err.backend = backend;
  return err;
}

function journaled(adapter, journal) {
  return new Proxy(adapter, {
    get(target, prop) {
      const fn = target[prop];
      if (typeof fn !== 'function') return fn;
      return (...args) => {
        if (['load', 'unload', 'ensureVariant'].includes(prop)) journal.push({ op: prop, instance: prop === 'ensureVariant' ? undefined : args[0], model: prop === 'ensureVariant' ? args[0].base : args[1], gpuLayers: args[0]?.gpuLayers });
        return fn.apply(target, args);
      };
    },
  });
}

export async function harness({ world: worldOpts, mutate, start = false } = {}) {
  const world = await createWorld(worldOpts).start();
  const dir = await mkdtemp(join(tmpdir(), 'hermes-mgr-'));
  const clock = createFakeClock();
  const journal = [];
  const router = createFakeRouter(journal);
  const ollama = journaled(createOllamaAdapter({ urls: world.urls() }), journal);
  const probe = createGpuProbe({ run: world.runner });
  const store = createStateStore({ dir });
  if (mutate) {
    const s = defaultState();
    mutate(s);
    await store.save(s);
  }
  const manager = createManager({ store, router, ollama, probe, clock });
  const h = {
    world, clock, journal, router, ollama, probe, store, manager, dir,
    ops: (...names) => journal.filter((j) => names.includes(j.op)),
    async settle() { await manager.idle(); },
    async stop() { await manager.stop(); await world.stop(); await rm(dir, { recursive: true, force: true }); },
  };
  if (start) await manager.start();
  return h;
}

export { until, defaultState };
