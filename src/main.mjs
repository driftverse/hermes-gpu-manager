// Entry point for the systemd unit: configuration from the environment, clean shutdown on SIGTERM/SIGINT.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.mjs';
import { configIsUsable } from './jwt.mjs';
import { startApp } from './app.mjs';

const config = loadConfig();
const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const logger = {
  info: (m) => console.log(`[gpu-manager] ${m}`),
  error: (m) => console.error(`[gpu-manager] ${m}`),
};

if (!configIsUsable(config)) {
  logger.error(`GPU_ACCESS_ISSUER / GPU_ACCESS_AUD / GPU_OWNER_EMAIL are not all set: ${config.publicHost} will answer 503 until they are. Local access still works.`);
}

const app = await startApp({ config, publicDir, logger });

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  logger.info(`${signal}: shutting down (in-flight model requests are not cut by the manager)`);
  try { await app.stop(); } finally { process.exit(0); }
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
