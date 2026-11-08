// Development aid: the real app on loopback port 3099 over the SIMULATED machine from the tests (fake
// Ollama instances, fake nvidia-smi). Never touches the real GPU, Ollama or any service.
//   node scripts/demo.mjs
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorld } from '../tests/helpers/world.mjs';
import { startApp } from '../src/app.mjs';
import { goodConfig } from '../tests/helpers/jwt-fixture.mjs';

const world = await createWorld().start();
world.catalog.set('qwen3:1.7b', { name: 'qwen3:1.7b', size: 1_400_000_000, layers: 28, numCtx: 8192, base: null });
const stateDir = await mkdtemp(join(tmpdir(), 'penny-demo-'));
const config = { ...goodConfig(), stateDir, routerPort: 0, localPort: 3099, gpuBackend: world.servers.gpu.url, cpuBackend: world.servers.cpu.url, reconcileMs: 4000 };
const app = await startApp({ config, runner: world.runner, publicDir: join(import.meta.dirname, '..', 'public') });
console.log(`demo on http://127.0.0.1:${app.managerPort}/  (router ${app.routerPort})  state ${stateDir}`);
process.on('SIGTERM', async () => { await app.stop(); await world.stop(); process.exit(0); });
process.on('SIGINT', async () => { await app.stop(); await world.stop(); process.exit(0); });
// Expose job control for visual checks: SIGUSR1 = renderer starts using 2570 MiB, SIGUSR2 = it stops.
process.on('SIGUSR1', () => world.startJob(2570));
process.on('SIGUSR2', () => world.stopJob());
