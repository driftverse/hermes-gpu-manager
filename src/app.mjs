// Assembles router + manager + HTTP server. One process, two loopback listeners:
//   router  (config.routerPort, default 11434): the Ollama API that Hindsight and Hermes already use
//   manager (config.localPort,  default 3017):  GUI + JSON API (published as gpu.<domain> through Cloudflare Access)
//
// Start order matters: the router comes up FIRST (with no plan every request goes to the always-on CPU
// instance, so callers are never refused), then the manager observes the machine and moves models to
// where the priority list says, then the GUI/API opens.

import { createRouter } from './router.mjs';
import { createManager } from './manager.mjs';
import { createOllamaAdapter } from './ollama.mjs';
import { createGpuProbe } from './probe.mjs';
import { createSafeRunner } from './system.mjs';
import { createStateStore } from './state.mjs';
import { createAppServer } from './server.mjs';

export const OLLAMA_UNITS = Object.freeze(['hermes-ollama-gpu.service', 'hermes-ollama-cpu.service']);

export async function startApp({ config, runner, publicDir, authDeps, logger = console }) {
  const cfg = { ...config };
  const store = createStateStore({ dir: cfg.stateDir });
  const router = createRouter({ backends: { gpu: cfg.gpuBackend, cpu: cfg.cpuBackend } });
  const ollama = createOllamaAdapter({ urls: { gpu: cfg.gpuBackend, cpu: cfg.cpuBackend } });
  const probe = createGpuProbe({ run: runner ?? createSafeRunner({ allowedUnits: [...OLLAMA_UNITS] }) });
  const manager = createManager({ store, router, ollama, probe, reconcileMs: cfg.reconcileMs });

  const routerPort = await router.listen(cfg.routerPort);
  let server = null;
  try {
    await manager.start();
    server = createAppServer({ manager, config: cfg, publicDir, authDeps, logger });
    const managerPort = await server.listen(cfg.localPort);
    cfg.localPort = managerPort; // the auth layer matches the Host header against this
    logger.info?.(`router listening on 127.0.0.1:${routerPort}, manager on 127.0.0.1:${managerPort}`);
    return {
      routerPort,
      managerPort,
      manager,
      router,
      async stop() {
        await server.close();
        await manager.stop();
        await router.close();
      },
    };
  } catch (err) {
    await server?.close();
    await manager.stop().catch(() => {});
    await router.close();
    throw err;
  }
}
