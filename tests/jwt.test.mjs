// Characterisation tests for the code ported from the studio (src/jwt.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyAccessJwt, configIsUsable } from '../src/jwt.mjs';
import { makeKey, signToken, goodConfig, jwksFetcher, ISSUER } from './helpers/jwt-fixture.mjs';

const setup = () => {
  const key = makeKey();
  return { key, deps: { fetchJwks: jwksFetcher([key]) } };
};

test('accepts a valid token and returns the email', async () => {
  const { key, deps } = setup();
  assert.deepEqual(await verifyAccessJwt(signToken({ key }), goodConfig(), deps), { ok: true, email: 'owner@example.com' });
});

test('JWKS is fetched only from <issuer>/cdn-cgi/access/certs and cached', async () => {
  const { key, deps } = setup();
  await verifyAccessJwt(signToken({ key }), goodConfig(), deps);
  await verifyAccessJwt(signToken({ key }), goodConfig(), deps);
  assert.deepEqual(deps.fetchJwks.calls, [`${ISSUER}/cdn-cgi/access/certs`]);
});

test('rejects alg none, HS256, missing kid and malformed tokens', async () => {
  const { key, deps } = setup();
  const cases = [
    signToken({ key, header: { alg: 'none' } }),
    signToken({ key, header: { alg: 'HS256' } }),
    signToken({ key, header: { kid: '' } }),
    signToken({ key, header: { kid: 7 } }),
    '',
    'only.two',
    'a.b.c.d',
    `${signToken({ key })}x`.replace(/\.[^.]*$/, '.'),
  ];
  for (const token of cases) {
    const r = await verifyAccessJwt(token, goodConfig(), deps);
    assert.equal(r.ok, false, token.slice(0, 30));
    assert.equal(r.status, 401);
  }
});

test('rejects a token over 8 KiB', async () => {
  const { deps } = setup();
  assert.equal((await verifyAccessJwt('a'.repeat(9000), goodConfig(), deps)).status, 401);
});

test('rejects a bad signature and an unknown kid', async () => {
  const { key, deps } = setup();
  const other = makeKey('kid-1');
  assert.equal((await verifyAccessJwt(signToken({ key: other }), goodConfig(), deps)).status, 401);
  const unknown = { ...key, kid: 'nope' };
  assert.equal((await verifyAccessJwt(signToken({ key: unknown }), goodConfig(), deps)).status, 401);
});

test('exp, nbf (with 30 s leeway), iss, aud', async () => {
  const { key, deps } = setup();
  const now = Date.now();
  const nowS = Math.floor(now / 1000);
  const check = async (payload) => verifyAccessJwt(signToken({ key, payload, now }), goodConfig(), { ...deps, now: () => now });
  assert.equal((await check({ exp: nowS - 1 })).status, 401);
  assert.equal((await check({ exp: undefined })).status, 401);
  assert.equal((await check({ nbf: nowS + 10 })).ok, true);
  assert.equal((await check({ nbf: nowS + 120 })).status, 401);
  assert.equal((await check({ iss: 'https://x.cloudflareaccess.com' })).status, 401);
  assert.equal((await check({ aud: ['nope'] })).status, 401);
  assert.equal((await check({ aud: 'aud-tag-123' })).ok, true);
});

test('email must equal owner (case-insensitive); other identities are 403', async () => {
  const { key, deps } = setup();
  assert.equal((await verifyAccessJwt(signToken({ key, payload: { email: 'OWNER@Example.com' } }), goodConfig(), deps)).ok, true);
  const r = await verifyAccessJwt(signToken({ key, payload: { email: 'other@example.com' } }), goodConfig(), deps);
  assert.equal(r.status, 403);
  assert.equal((await verifyAccessJwt(signToken({ key, payload: { email: '' } }), goodConfig(), deps)).status, 403);
});

test('unusable config (missing fields, non-https issuer) is 503', async () => {
  const { key, deps } = setup();
  const token = signToken({ key });
  for (const patch of [{ accessIssuer: '' }, { accessAud: '' }, { ownerEmail: '' }, { accessIssuer: 'http://team.cloudflareaccess.com' }, { accessIssuer: `${ISSUER}/path` }]) {
    const r = await verifyAccessJwt(token, { ...goodConfig(), ...patch }, deps);
    assert.equal(r.status, 503, JSON.stringify(patch));
  }
  assert.equal(configIsUsable(goodConfig()), true);
});

test('JWKS fetch failure fails closed with 503', async () => {
  const key = makeKey();
  const deps = { fetchJwks: async () => { throw new Error('down'); } };
  assert.equal((await verifyAccessJwt(signToken({ key }), goodConfig(), deps)).status, 503);
});

test('unknown kid triggers at most one refetch per 30 s and picks up rotated keys', async () => {
  const k1 = makeKey('k1');
  const k2 = makeKey('k2');
  let keys = [k1];
  let calls = 0;
  const fetchJwks = async () => { calls += 1; return { keys: keys.map((k) => k.jwk) }; };
  let now = Date.now();
  const deps = { fetchJwks, now: () => now };
  assert.equal((await verifyAccessJwt(signToken({ key: k1, now }), goodConfig(), deps)).ok, true);
  keys = [k1, k2];
  assert.equal((await verifyAccessJwt(signToken({ key: k2, now }), goodConfig(), deps)).status, 401); // too soon
  assert.equal(calls, 1);
  now += 31_000;
  assert.equal((await verifyAccessJwt(signToken({ key: k2, now }), goodConfig(), deps)).ok, true);
  assert.equal(calls, 2);
});
