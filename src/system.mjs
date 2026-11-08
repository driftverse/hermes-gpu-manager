// The only place that can spawn processes. An allowlist of exact invocations:
//   nvidia-smi <the two fixed query argument lists from probe.mjs>
//   systemctl --user is-active <one of the configured unit names>      (read-only health hint)
// Anything else is rejected before a process is created.

import { execFile as realExecFile } from 'node:child_process';
import { MEMORY_ARGS, APPS_ARGS } from './probe.mjs';

const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

export function createSafeRunner({ execFile = realExecFile, allowedUnits = [], timeoutMs = 10_000 } = {}) {
  const units = new Set(allowedUnits);

  function allowed(file, args) {
    if (file === 'nvidia-smi') return same(args, MEMORY_ARGS) || same(args, APPS_ARGS);
    if (file === 'systemctl') {
      return args.length === 3 && args[0] === '--user' && args[1] === 'is-active' && units.has(args[2]);
    }
    return false;
  }

  return function run(file, args) {
    if (!Array.isArray(args) || !allowed(file, args)) {
      return Promise.reject(new Error(`command not allowed: ${file}`));
    }
    return new Promise((resolve, reject) => {
      execFile(file, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
        if (!err) return resolve({ stdout: String(stdout), stderr: String(stderr) });
        // `systemctl is-active` exits non-zero for inactive units but still prints the state.
        if (file === 'systemctl' && stdout) return resolve({ stdout: String(stdout), stderr: String(stderr), code: err.code });
        const detail = String(stderr || '').trim() || err.message;
        reject(new Error(`${file} failed: ${detail}`));
      });
    });
  };
}
