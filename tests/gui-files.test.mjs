// Static guarantees about the shipped GUI files: nothing inline, nothing external, no unsafe DOM writes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const dir = join(import.meta.dirname, '..', 'public');
const read = (f) => readFile(join(dir, f), 'utf8');

test('index.html: no inline script/style/handlers, no external resources, one module script and one stylesheet', async () => {
  const html = await read('index.html');
  assert.ok(!/<script(?![^>]*\ssrc=)[^>]*>/i.test(html), 'inline <script> found');
  assert.ok(!/<style[\s>]/i.test(html), 'inline <style> found');
  assert.ok(!/\son[a-z]+\s*=/i.test(html), 'inline event handler found');
  assert.ok(!/style\s*=/i.test(html), 'inline style attribute found');
  for (const m of html.matchAll(/(?:src|href|action)\s*=\s*"([^"]+)"/gi)) {
    assert.ok(m[1].startsWith('/') && !m[1].startsWith('//'), `external or protocol-relative reference: ${m[1]}`);
  }
  assert.equal([...html.matchAll(/<script[^>]*src="\/app\.js"[^>]*type="module"/gi)].length + [...html.matchAll(/<script[^>]*type="module"[^>]*src="\/app\.js"/gi)].length, 1);
  assert.match(html, /<meta name="viewport"/);
  assert.match(html, /<html lang="en">/);
});

test('app.js and lib.js: no innerHTML/outerHTML/insertAdjacentHTML/eval/document.write, no external URLs', async () => {
  for (const f of ['app.js', 'lib.js']) {
    const src = await read(f);
    for (const bad of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function', 'setTimeout("', "setTimeout('"]) {
      assert.ok(!src.includes(bad), `${f} contains ${bad}`);
    }
    assert.ok(!/https?:\/\//.test(src), `${f} references an absolute URL`);
  }
});

test('style.css: no remote fonts, imports or url() fetches', async () => {
  const css = await read('style.css');
  assert.ok(!/@import/i.test(css));
  assert.ok(!/url\(/i.test(css));
  assert.ok(!/https?:\/\//.test(css));
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /prefers-color-scheme/);
  assert.match(css, /min-height:\s*44px/);
  assert.match(css, /:focus-visible/);
});

test('app.js and lib.js pass a syntax check', () => {
  const node = process.execPath;
  for (const f of ['app.js', 'lib.js']) {
    execFileSync(node, ['--check', join(dir, f)], { stdio: 'pipe' });
  }
});

test('every element id that app.js looks up exists in index.html', async () => {
  const html = await read('index.html');
  const js = await read('app.js');
  const ids = new Set([...js.matchAll(/\$\('([a-z0-9-]+)'\)/g)].map((m) => m[1]));
  assert.ok(ids.size > 8);
  for (const id of ids) assert.ok(html.includes(`id="${id}"`), `index.html lacks id="${id}"`);
  for (const name of ['reservedMiB', 'gpuTotalMiB', 'drainTimeoutSec', 'minDwellSec', 'tag', 'name', 'layers', 'fullGpuMiB', 'minUsefulGpuMiB', 'allowPartial']) {
    assert.ok(html.includes(`name="${name}"`), `index.html lacks a field named ${name}`);
  }
});
