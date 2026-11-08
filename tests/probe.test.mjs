import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMemory, parseComputeApps, createGpuProbe, MEMORY_ARGS, APPS_ARGS } from '../src/probe.mjs';
import { createSafeRunner } from '../src/system.mjs';

test('parseMemory: normal csv line', () => {
  assert.deepEqual(parseMemory('4096, 1850, 2246\n'), { totalMiB: 4096, usedMiB: 1850, freeMiB: 2246 });
});

test('parseMemory: tolerates units, whitespace, CRLF and extra GPUs (uses the first)', () => {
  assert.deepEqual(parseMemory('  4096 MiB,1850 MiB , 2246 MiB\r\n8192, 1, 8191\n'), { totalMiB: 4096, usedMiB: 1850, freeMiB: 2246 });
});

test('parseMemory: garbage, [N/A], empty and no-device messages return null instead of throwing', () => {
  for (const text of ['', '\n', 'No devices were found', 'Failed to initialize NVML: Driver/library version mismatch', '[N/A], [N/A], [N/A]', '4096, abc, 2246', '1, 2', 'NaN, 1, 2', '-5, 1, 2', null, undefined, 42]) {
    assert.equal(parseMemory(text), null, String(text));
  }
});

test('parseMemory: derives free when used+free disagree with total by rounding only', () => {
  const r = parseMemory('4096, 4000, 90');
  assert.equal(r.freeMiB, 90);
  assert.equal(parseMemory('4096, 5000, 0').usedMiB, 5000); // reported as-is; callers clamp
});

test('parseComputeApps: pid, name, memory; skips bad lines', () => {
  const text = '1234, /usr/local/bin/ollama, 1236\n 5678, python3 , 2570 \nnot a line\n99, x, [N/A]\n, , \n';
  assert.deepEqual(parseComputeApps(text), [
    { pid: 1234, name: '/usr/local/bin/ollama', usedMiB: 1236 },
    { pid: 5678, name: 'python3', usedMiB: 2570 },
  ]);
});

test('parseComputeApps: empty / no processes', () => {
  assert.deepEqual(parseComputeApps(''), []);
  assert.deepEqual(parseComputeApps('No running processes found'), []);
  assert.deepEqual(parseComputeApps(undefined), []);
});

test('probe uses exactly the documented nvidia-smi invocations', async () => {
  const calls = [];
  const probe = createGpuProbe({ run: async (cmd, args) => { calls.push([cmd, args]); return { stdout: args === MEMORY_ARGS ? '4096, 1800, 2296\n' : '7, ollama, 100\n' }; } });
  const s = await probe.snapshot();
  assert.deepEqual(calls[0], ['nvidia-smi', ['--query-gpu=memory.total,memory.used,memory.free', '--format=csv,noheader,nounits']]);
  assert.deepEqual(calls[1], ['nvidia-smi', ['--query-compute-apps=pid,process_name,used_memory', '--format=csv,noheader,nounits']]);
  assert.deepEqual(MEMORY_ARGS, calls[0][1]);
  assert.deepEqual(APPS_ARGS, calls[1][1]);
  assert.equal(s.ok, true);
  assert.equal(s.freeMiB, 2296);
  assert.equal(s.apps.length, 1);
});

test('probe never throws: runner failure and unparseable output become ok:false with an error', async () => {
  const failing = createGpuProbe({ run: async () => { throw new Error('spawn nvidia-smi ENOENT'); } });
  const a = await failing.snapshot();
  assert.equal(a.ok, false);
  assert.match(a.error, /ENOENT/);
  const garbage = createGpuProbe({ run: async () => ({ stdout: 'No devices were found' }) });
  const b = await garbage.snapshot();
  assert.equal(b.ok, false);
  assert.match(b.error, /parse/i);
});

test('probe: a failing apps query still returns memory', async () => {
  const probe = createGpuProbe({ run: async (cmd, args) => { if (args === APPS_ARGS) throw new Error('boom'); return { stdout: '4096, 1000, 3096' }; } });
  const s = await probe.snapshot();
  assert.equal(s.ok, true);
  assert.deepEqual(s.apps, []);
  assert.equal(s.appsError, 'boom');
});

test('safe runner: only the fixed nvidia-smi invocations and systemctl --user is-active <known unit>', async () => {
  const executed = [];
  const execFile = (file, args, opts, cb) => { executed.push([file, args]); cb(null, 'ok\n', ''); };
  const run = createSafeRunner({ execFile, allowedUnits: ['hermes-ollama-gpu.service'] });
  assert.equal((await run('nvidia-smi', MEMORY_ARGS)).stdout, 'ok\n');
  await run('nvidia-smi', APPS_ARGS);
  await run('systemctl', ['--user', 'is-active', 'hermes-ollama-gpu.service']);
  assert.equal(executed.length, 3);
  const denied = [
    ['nvidia-smi', ['-q']],
    ['nvidia-smi', [...MEMORY_ARGS, '--id=0']],
    ['systemctl', ['--user', 'restart', 'hermes-ollama-gpu.service']],
    ['systemctl', ['--user', 'is-active', 'sshd.service']],
    ['systemctl', ['is-active', 'hermes-ollama-gpu.service']],
    ['systemctl', ['--user', 'is-active', 'hermes-ollama-gpu.service', '--now']],
    ['rm', ['-rf', '/']],
    ['ollama', ['ps']],
    ['bash', ['-c', 'true']],
  ];
  for (const [cmd, args] of denied) {
    await assert.rejects(run(cmd, args), /not allowed/i, `${cmd} ${args.join(' ')}`);
  }
  assert.equal(executed.length, 3); // nothing denied was ever executed
});

test('safe runner: failures surface stderr and exit; is-active non-zero is reported, not thrown', async () => {
  const execFile = (file, args, opts, cb) => {
    if (file === 'systemctl') return cb(Object.assign(new Error('exit 3'), { code: 3 }), 'inactive\n', '');
    return cb(Object.assign(new Error('boom'), { code: 9 }), '', 'driver error');
  };
  const run = createSafeRunner({ execFile, allowedUnits: ['u.service'] });
  const r = await run('systemctl', ['--user', 'is-active', 'u.service']);
  assert.equal(r.stdout.trim(), 'inactive');
  await assert.rejects(run('nvidia-smi', MEMORY_ARGS), /driver error/);
});
