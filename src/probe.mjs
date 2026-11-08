// GPU memory probe. The command runner is injected (see system.mjs for the production, allowlisted one);
// nothing here ever spawns a process itself. Parsing is defensive: every failure becomes `ok: false`.

export const MEMORY_ARGS = Object.freeze(['--query-gpu=memory.total,memory.used,memory.free', '--format=csv,noheader,nounits']);
export const APPS_ARGS = Object.freeze(['--query-compute-apps=pid,process_name,used_memory', '--format=csv,noheader,nounits']);

const MIB_FIELD = /^(\d{1,9})(?:\s*MiB)?$/i;

const lines = (text) => (typeof text === 'string' ? text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean) : []);

// First GPU only (this machine has one). Returns null when the output is not three integers.
export function parseMemory(text) {
  const [first] = lines(text);
  if (!first) return null;
  const parts = first.split(',').map((p) => p.trim());
  if (parts.length !== 3) return null;
  const nums = parts.map((p) => {
    const m = MIB_FIELD.exec(p);
    return m ? Number(m[1]) : null;
  });
  if (nums.some((n) => n === null)) return null;
  const [totalMiB, usedMiB, freeMiB] = nums;
  if (totalMiB <= 0) return null;
  return { totalMiB, usedMiB, freeMiB };
}

export function parseComputeApps(text) {
  const apps = [];
  for (const line of lines(text)) {
    const parts = line.split(',').map((p) => p.trim());
    if (parts.length < 3) continue;
    const used = MIB_FIELD.exec(parts[parts.length - 1]);
    const pid = /^\d+$/.test(parts[0]) ? Number(parts[0]) : null;
    const name = parts.slice(1, -1).join(',');
    if (pid === null || !used || !name) continue;
    apps.push({ pid, name, usedMiB: Number(used[1]) });
  }
  return apps;
}

export function createGpuProbe({ run, now = Date.now }) {
  return {
    async snapshot() {
      const at = now();
      let memory;
      try {
        const { stdout } = await run('nvidia-smi', MEMORY_ARGS);
        memory = parseMemory(stdout);
      } catch (err) {
        return { ok: false, at, error: String(err?.message || err) };
      }
      if (!memory) return { ok: false, at, error: 'could not parse nvidia-smi memory output' };
      let apps = [];
      let appsError;
      try {
        const { stdout } = await run('nvidia-smi', APPS_ARGS);
        apps = parseComputeApps(stdout);
      } catch (err) {
        appsError = String(err?.message || err);
      }
      return { ok: true, at, ...memory, apps, ...(appsError ? { appsError } : {}) };
    },
  };
}
