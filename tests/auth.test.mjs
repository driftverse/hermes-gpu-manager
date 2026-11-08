import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authorizeRequest } from '../src/auth.mjs';
import { makeKey, signToken, goodConfig, jwksFetcher } from './helpers/jwt-fixture.mjs';

const LOCAL_ORIGIN = 'http://127.0.0.1:3017';
const PUBLIC_ORIGIN = 'https://gpu.example.com';

const req = (over = {}) => ({
  method: 'GET',
  path: '/api/status',
  remoteAddress: '127.0.0.1',
  headers: { host: '127.0.0.1:3017' },
  ...over,
});

async function remote(over = {}, tokenOver = {}) {
  const key = makeKey();
  const deps = { fetchJwks: jwksFetcher([key]) };
  const token = tokenOver.token ?? signToken({ key, ...tokenOver });
  const request = req({
    headers: { host: 'gpu.example.com', 'cf-access-jwt-assertion': token, ...(over.headers || {}) },
    ...Object.fromEntries(Object.entries(over).filter(([k]) => k !== 'headers')),
  });
  return authorizeRequest(request, goodConfig(), deps);
}

test('local: loopback GET on 127.0.0.1 and localhost is allowed', async () => {
  assert.deepEqual(await authorizeRequest(req(), goodConfig()), { ok: true, mode: 'local' });
  const r = await authorizeRequest(req({ headers: { host: 'localhost:3017' } }), goodConfig());
  assert.equal(r.ok, true);
});

test('unknown Host -> 403', async () => {
  for (const host of ['evil.example.com', '127.0.0.1:9999', '', '0.0.0.0:3017', '127.0.0.1']) {
    const r = await authorizeRequest(req({ headers: { host } }), goodConfig());
    assert.equal(r.ok, false, host);
    assert.equal(r.status, 403, host);
  }
});

test('local: a non-loopback peer address is refused even with a loopback Host', async () => {
  for (const remoteAddress of ['192.168.1.5', '10.0.0.2', undefined, '::2']) {
    const r = await authorizeRequest(req({ remoteAddress }), goodConfig());
    assert.equal(r.status, 403, String(remoteAddress));
  }
  for (const remoteAddress of ['::1', '::ffff:127.0.0.1']) {
    assert.equal((await authorizeRequest(req({ remoteAddress }), goodConfig())).ok, true);
  }
});

test('local: proxy / Cloudflare headers make a request non-local', async () => {
  const bad = [
    { 'cf-connecting-ip': '1.2.3.4' },
    { 'cf-ray': 'x' },
    { 'cf-access-jwt-assertion': 'x' },
    { forwarded: 'for=1.2.3.4' },
    { 'x-real-ip': '1.2.3.4' },
    { 'true-client-ip': '1.2.3.4' },
    { 'x-forwarded-for': '127.0.0.1' },
    { 'x-forwarded-host': 'gpu.example.com' },
  ];
  for (const extra of bad) {
    const r = await authorizeRequest(req({ headers: { host: '127.0.0.1:3017', ...extra } }), goodConfig());
    assert.equal(r.ok, false, JSON.stringify(extra));
    assert.equal(r.status, 403);
  }
});

test('non-GET needs a matching Origin (local)', async () => {
  const post = (origin) => req({ method: 'PUT', path: '/api/order', headers: { host: '127.0.0.1:3017', ...(origin ? { origin } : {}) } });
  assert.equal((await authorizeRequest(post(LOCAL_ORIGIN), goodConfig())).ok, true);
  assert.equal((await authorizeRequest(post(), goodConfig())).status, 403);
  assert.equal((await authorizeRequest(post('http://evil.example'), goodConfig())).status, 403);
  assert.equal((await authorizeRequest(post('http://localhost:3017'), goodConfig())).status, 403);
});

test('Sec-Fetch-Site cross-site / same-site is refused; same-origin and none are fine', async () => {
  for (const site of ['cross-site', 'same-site']) {
    const r = await authorizeRequest(req({ headers: { host: '127.0.0.1:3017', 'sec-fetch-site': site } }), goodConfig());
    assert.equal(r.status, 403, site);
  }
  for (const site of ['same-origin', 'none']) {
    const r = await authorizeRequest(req({ headers: { host: '127.0.0.1:3017', 'sec-fetch-site': site } }), goodConfig());
    assert.equal(r.ok, true, site);
  }
});

test('lease endpoints: local caller may omit Origin, but a wrong Origin is still refused', async () => {
  const lease = (headers) => req({ method: 'POST', path: '/api/leases/musetalk/acquire', headers: { host: '127.0.0.1:3017', ...headers } });
  assert.equal((await authorizeRequest(lease({}), goodConfig())).ok, true);
  assert.equal((await authorizeRequest(lease({ origin: LOCAL_ORIGIN }), goodConfig())).ok, true);
  assert.equal((await authorizeRequest(lease({ origin: 'http://evil.example' }), goodConfig())).status, 403);
  assert.equal((await authorizeRequest(lease({ 'sec-fetch-site': 'cross-site' }), goodConfig())).status, 403);
  // Only the lease prefix gets the relaxation.
  const other = req({ method: 'POST', path: '/api/apply', headers: { host: '127.0.0.1:3017' } });
  assert.equal((await authorizeRequest(other, goodConfig())).status, 403);
});

test('public host: valid Access JWT for the owner is allowed', async () => {
  const r = await remote();
  assert.equal(r.ok, true);
  assert.equal(r.mode, 'remote');
  assert.equal(r.email, 'owner@example.com');
});

test('public host: missing or invalid token -> 401', async () => {
  const none = await authorizeRequest(req({ headers: { host: 'gpu.example.com' } }), goodConfig(), { fetchJwks: jwksFetcher([makeKey()]) });
  assert.equal(none.status, 401);
  const junk = await remote({}, { token: 'a.b.c' });
  assert.equal(junk.status, 401);
});

test('public host: wrong owner -> 403, wrong audience / issuer / expired -> 401', async () => {
  assert.equal((await remote({}, { payload: { email: 'intruder@example.com' } })).status, 403);
  assert.equal((await remote({}, { payload: { aud: ['other'] } })).status, 401);
  assert.equal((await remote({}, { payload: { iss: 'https://evil.cloudflareaccess.com' } })).status, 401);
  assert.equal((await remote({}, { payload: { exp: 1 } })).status, 401);
});

test('public host: POST needs matching public Origin plus JWT', async () => {
  const noOrigin = await remote({ method: 'PUT', path: '/api/order' });
  assert.equal(noOrigin.status, 403);
  const good = await remote({ method: 'PUT', path: '/api/order', headers: { origin: PUBLIC_ORIGIN } });
  assert.equal(good.ok, true);
  const wrong = await remote({ method: 'PUT', path: '/api/order', headers: { origin: LOCAL_ORIGIN } });
  assert.equal(wrong.status, 403);
});

test('public host never reaches lease endpoints, even with a valid token', async () => {
  for (const method of ['GET', 'POST']) {
    const r = await remote({ method, path: '/api/leases/musetalk/acquire', headers: { origin: PUBLIC_ORIGIN } });
    assert.equal(r.ok, false);
    assert.equal(r.status, 403);
    assert.equal(r.code, 'forbidden_lease_remote');
  }
});

test('public host with missing env -> 503 for everything, before any other check', async () => {
  const key = makeKey();
  const token = signToken({ key });
  for (const missing of ['accessIssuer', 'accessAud', 'ownerEmail']) {
    const config = { ...goodConfig(), [missing]: '' };
    const get = await authorizeRequest(req({ headers: { host: 'gpu.example.com', 'cf-access-jwt-assertion': token } }), config, { fetchJwks: jwksFetcher([key]) });
    assert.equal(get.status, 503, missing);
    const post = await authorizeRequest(req({ method: 'POST', headers: { host: 'gpu.example.com' } }), config);
    assert.equal(post.status, 503, `${missing} (POST without origin)`);
  }
});

test('missing env on the public host does not break genuine loopback access', async () => {
  const config = { ...goodConfig(), accessIssuer: '', accessAud: '', ownerEmail: '' };
  assert.equal((await authorizeRequest(req(), config)).ok, true);
});

test('error messages are fixed strings and never echo request data', async () => {
  const r = await authorizeRequest(req({ headers: { host: 'evil<script>.example' } }), goodConfig());
  assert.ok(!r.message.includes('evil'));
});
