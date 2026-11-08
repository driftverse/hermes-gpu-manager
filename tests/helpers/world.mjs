// A simulated machine for tests: VRAM accounting, two fake Ollama HTTP instances (gpu/cpu) sharing one
// model store, an optional "job" (MuseTalk) holding VRAM, and an nvidia-smi emulator that goes through the
// real probe parser. Nothing here touches the real GPU, Ollama or network (loopback ephemeral ports only).
import http from 'node:http';
import { listen, close, readBody } from './net.mjs';

const MiB = 1024 * 1024;
export const LFM3 = 'lfm3:1.7b-100000';
export const LFM3_SIZE = 1236533247; // measured size_vram for the full-GPU load (bytes)

export function createWorld({ totalMiB = 4096, desktopMiB = 1500 } = {}) {
  const world = {
    totalMiB,
    desktopMiB,
    jobMiB: 0,
    nvidiaDown: false,
    catalog: new Map([[LFM3, { name: LFM3, size: LFM3_SIZE, layers: 24, numCtx: 70000, base: null }]]),
    servers: {},
    log: [], // every request any fake instance received: { role, method, path, body }
    usedMiB() {
      return world.desktopMiB + world.jobMiB + Math.ceil(world.servers.gpu.vramBytes() / MiB);
    },
    freeMiB() { return world.totalMiB - world.usedMiB(); },
    async runner(file, args) {
      if (file !== 'nvidia-smi') throw new Error(`unexpected command ${file}`);
      if (world.nvidiaDown) throw new Error('nvidia-smi failed: NVML unavailable');
      if (args[0].startsWith('--query-gpu')) return { stdout: `${world.totalMiB}, ${world.usedMiB()}, ${world.freeMiB()}\n` };
      if (args[0].startsWith('--query-compute-apps')) {
        const apps = [...world.servers.gpu.loaded.values()].map((m) => `4242, /usr/local/bin/ollama, ${Math.ceil(m.sizeVram / MiB)}`);
        if (world.jobMiB) apps.push(`5151, python3, ${world.jobMiB}`);
        return { stdout: `${apps.join('\n')}\n` };
      }
      throw new Error('unexpected nvidia-smi args');
    },
    async start() {
      for (const role of ['gpu', 'cpu']) world.servers[role] = await fakeOllama(world, role);
      return world;
    },
    urls() { return { gpu: world.servers.gpu.url, cpu: world.servers.cpu.url }; },
    async stop() { for (const s of Object.values(world.servers)) await s.stop(); },
    startJob(mib) { world.jobMiB = mib; },
    stopJob() { world.jobMiB = 0; },
  };
  return world;
}

async function fakeOllama(world, role) {
  const loaded = new Map(); // name -> { name, size, sizeVram, expiresAt }
  const srv = {
    role,
    loaded,
    delayMs: 0, // delay applied to /api/generate loads
    fail: {}, // path -> status code to answer with
    failLoad: new Set(), // model names whose load answers HTTP 500
    gate: null, // optional promise that /api/generate waits on
    vramBytes: () => (role === 'gpu' ? [...loaded.values()].reduce((s, m) => s + m.sizeVram, 0) : 0),
  };

  const server = http.createServer(async (req, res) => {
    const raw = await readBody(req);
    let body = {};
    try { body = raw.length ? JSON.parse(raw.toString('utf8')) : {}; } catch { /* leave empty */ }
    const path = req.url.split('?')[0];
    world.log.push({ role, method: req.method, path, body });
    const send = (status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (srv.fail[path]) return send(srv.fail[path], { error: 'injected failure' });

    if (req.method === 'GET' && path === '/api/version') return send(200, { version: '0.0.0-fake' });
    if (req.method === 'GET' && path === '/api/ps') {
      return send(200, { models: [...loaded.values()].map((m) => ({ name: m.name, model: m.name, size: m.size, size_vram: m.sizeVram, digest: 'x', expires_at: m.expiresAt })) });
    }
    if (req.method === 'GET' && path === '/api/tags') {
      return send(200, { models: [...world.catalog.values()].map((m) => ({ name: m.name, model: m.name, size: m.size })) });
    }
    if (req.method === 'POST' && path === '/api/show') {
      const entry = world.catalog.get(body.model || body.name);
      if (!entry) return send(404, { error: `model '${body.model || body.name}' not found` });
      return send(200, { parameters: `num_ctx                        ${entry.numCtx}\nstop                           "<|im_end|>"`, details: { family: 'lfm' } });
    }
    if (req.method === 'POST' && path === '/api/create') {
      const name = body.model || body.name;
      const base = world.catalog.get(body.from);
      if (!base) return send(404, { error: `model '${body.from}' not found` });
      world.catalog.set(name, { name, size: base.size, layers: base.layers, numCtx: body.parameters?.num_ctx ?? base.numCtx, numGpu: body.parameters?.num_gpu, base: body.from });
      return send(200, { status: 'success' });
    }
    if (req.method === 'POST' && path === '/api/generate') {
      // Like real Ollama failing to allocate compute buffers: the load itself errors out.
      if (srv.failLoad.has(body.model) && body.keep_alive !== 0) return send(500, { error: 'llama-server process has terminated: failed to allocate Vulkan0 buffer' });
      if (srv.gate) await srv.gate;
      if (srv.delayMs) await new Promise((r) => setTimeout(r, srv.delayMs));
      const entry = world.catalog.get(body.model);
      if (!entry) return send(404, { error: `model '${body.model}' not found` });
      if (body.keep_alive === 0) {
        loaded.delete(body.model);
        return send(200, { model: body.model, done: true, done_reason: 'unload' });
      }
      if (!loaded.has(body.model)) {
        let sizeVram = 0;
        if (role === 'gpu') {
          const want = entry.numGpu !== undefined ? Math.min(entry.numGpu, entry.layers) / entry.layers : 1;
          const wantBytes = Math.floor(entry.size * want);
          const freeBytes = Math.max(0, world.freeMiB() * MiB);
          // Real Ollama silently places fewer layers when memory is short instead of failing.
          sizeVram = Math.min(wantBytes, freeBytes);
        }
        loaded.set(body.model, { name: body.model, size: entry.size, sizeVram, expiresAt: '2999-01-01T00:00:00Z' });
      }
      return send(200, { model: body.model, response: '', done: true });
    }
    return send(404, { error: 'not found' });
  });

  srv.port = await listen(server);
  srv.url = `http://127.0.0.1:${srv.port}`;
  srv.stop = () => close(server);
  return srv;
}
