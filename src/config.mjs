// Configuration from the environment. Adapted from
// /home/example/Apps/open-higgsfield-ai/server/config.mjs (same shape, GPU_* variable names).
// Everything here is non-secret deployment config.

import { join } from 'node:path';

export const DEFAULTS = Object.freeze({
  routerPort: 11434,
  gpuBackend: 'http://127.0.0.1:11436',
  cpuBackend: 'http://127.0.0.1:11435',
  managerPort: 3017,
  publicHost: 'gpu.example.com',
});

function port(value, fallback) {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : fallback;
}

// Backends are always loopback; anything else in the environment is ignored.
function loopbackUrl(value, fallback) {
  try {
    const u = new URL(value || fallback);
    if (u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost')) return u.origin;
  } catch {
    // fall through
  }
  return fallback;
}

export function loadConfig(env = process.env) {
  const home = env.HOME || '';
  return {
    stateDir: env.GPU_STATE_DIR || join(home, '.config', 'penny-gpu'),
    localPort: port(env.GPU_MANAGER_PORT, DEFAULTS.managerPort),
    routerPort: port(env.GPU_ROUTER_PORT, DEFAULTS.routerPort),
    gpuBackend: loopbackUrl(env.GPU_BACKEND_URL, DEFAULTS.gpuBackend),
    cpuBackend: loopbackUrl(env.GPU_CPU_BACKEND_URL, DEFAULTS.cpuBackend),
    publicHost: (env.GPU_PUBLIC_HOST || DEFAULTS.publicHost).toLowerCase(),
    accessIssuer: (env.GPU_ACCESS_ISSUER || '').replace(/\/+$/, ''),
    accessAud: env.GPU_ACCESS_AUD || '',
    ownerEmail: env.GPU_OWNER_EMAIL || '',
    reconcileMs: port(env.GPU_RECONCILE_MS, 10_000),
    env,
  };
}
