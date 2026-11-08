import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createOllamaAdapter, variantTag } from '../src/ollama.mjs';
import { createWorld, LFM3, LFM3_SIZE } from './helpers/world.mjs';
import { deadUrl } from './helpers/net.mjs';

const cleanup = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()(); });

async function setup(opts) {
  const world = await createWorld(opts).start();
  cleanup.push(() => world.stop());
  return { world, ollama: createOllamaAdapter({ urls: world.urls() }) };
}

test('variantTag appends -g<layers> to the base tag', () => {
  assert.equal(variantTag('lfm3:1.7b-100000', 12), 'lfm3:1.7b-100000-g12');
  assert.equal(variantTag('qwen3', 7), 'qwen3-g7');
});

test('ps normalises entries and reports MiB placement', async () => {
  const { world, ollama } = await setup();
  await ollama.load('gpu', LFM3);
  const [m] = await ollama.ps('gpu');
  assert.equal(m.name, LFM3);
  assert.equal(m.sizeVramBytes, LFM3_SIZE);
  assert.equal(m.sizeVramMiB, Math.round(LFM3_SIZE / 1048576));
  assert.equal(m.vramFraction, 1);
  assert.deepEqual(await ollama.ps('cpu'), []);
  assert.equal(world.freeMiB(), 4096 - 1500 - Math.ceil(LFM3_SIZE / 1048576));
});

test('load sends an empty prompt with keep_alive -1 to the chosen instance only', async () => {
  const { world, ollama } = await setup();
  await ollama.load('cpu', LFM3);
  const call = world.log.find((l) => l.path === '/api/generate');
  assert.equal(call.role, 'cpu');
  assert.deepEqual(call.body, { model: LFM3, prompt: '', keep_alive: -1, stream: false });
  assert.equal(world.log.filter((l) => l.role === 'gpu').length, 0);
});

test('unload sends keep_alive 0 and the model disappears from /api/ps', async () => {
  const { world, ollama } = await setup();
  await ollama.load('gpu', LFM3);
  await ollama.unload('gpu', LFM3);
  assert.deepEqual(await ollama.ps('gpu'), []);
  const call = world.log.filter((l) => l.path === '/api/generate').at(-1);
  assert.equal(call.body.keep_alive, 0);
});

test('ensureVariant creates the partial tag with num_ctx copied from the base and num_gpu set', async () => {
  const { world, ollama } = await setup();
  const r = await ollama.ensureVariant({ base: LFM3, gpuLayers: 12 });
  assert.deepEqual(r, { tag: 'lfm3:1.7b-100000-g12', created: true });
  const create = world.log.find((l) => l.path === '/api/create');
  assert.equal(create.body.from, LFM3);
  assert.equal(create.body.model, 'lfm3:1.7b-100000-g12');
  assert.equal(create.body.name, 'lfm3:1.7b-100000-g12');
  assert.deepEqual(create.body.parameters, { num_ctx: 70000, num_gpu: 12 });
  assert.equal(create.body.stream, false);
  assert.equal(world.catalog.get('lfm3:1.7b-100000-g12').numCtx, 70000);
});

test('ensureVariant is idempotent: an existing tag is not recreated', async () => {
  const { world, ollama } = await setup();
  await ollama.ensureVariant({ base: LFM3, gpuLayers: 12 });
  const again = await ollama.ensureVariant({ base: LFM3, gpuLayers: 12 });
  assert.deepEqual(again, { tag: 'lfm3:1.7b-100000-g12', created: false });
  assert.equal(world.log.filter((l) => l.path === '/api/create').length, 1);
});

test('ensureVariant fails clearly when the base model is unknown', async () => {
  const { ollama } = await setup();
  await assert.rejects(ollama.ensureVariant({ base: 'nope:1b', gpuLayers: 3 }), /not found/i);
});

test('a partial variant loaded on the GPU reports a fractional placement', async () => {
  const { ollama } = await setup();
  const { tag } = await ollama.ensureVariant({ base: LFM3, gpuLayers: 12 });
  await ollama.load('gpu', tag);
  const [m] = await ollama.ps('gpu');
  assert.equal(m.name, tag);
  assert.ok(Math.abs(m.vramFraction - 0.5) < 0.01, `fraction ${m.vramFraction}`);
});

test('tags lists the shared store (from the CPU instance by default)', async () => {
  const { ollama } = await setup();
  assert.deepEqual(await ollama.tags(), [LFM3]);
});

test('HTTP errors surface the server message; a dead instance rejects', async () => {
  const { world, ollama } = await setup();
  world.servers.gpu.fail['/api/ps'] = 500;
  await assert.rejects(ollama.ps('gpu'), /500.*injected failure/);
  const dead = createOllamaAdapter({ urls: { gpu: await deadUrl(), cpu: world.servers.cpu.url } });
  await assert.rejects(dead.ps('gpu'), /ECONNREFUSED/);
  assert.equal(await dead.healthy('gpu'), false);
  assert.equal(await dead.healthy('cpu'), true);
});

test('only loopback http URLs are accepted', () => {
  assert.throws(() => createOllamaAdapter({ urls: { gpu: 'http://10.0.0.1:11434', cpu: 'http://127.0.0.1:1' } }), /loopback/i);
});

test('an injected http client is used instead of the network', async () => {
  const calls = [];
  const http = async (req) => { calls.push(req); return { status: 200, json: { models: [] } }; };
  const ollama = createOllamaAdapter({ urls: { gpu: 'http://127.0.0.1:1', cpu: 'http://127.0.0.1:2' }, http });
  assert.deepEqual(await ollama.ps('cpu'), []);
  assert.equal(calls[0].url, 'http://127.0.0.1:2/api/ps');
  assert.equal(calls[0].method, 'GET');
});
