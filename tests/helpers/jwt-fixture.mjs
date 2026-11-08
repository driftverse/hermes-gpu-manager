// Test-only helpers: generate an RSA key pair and sign RS256 tokens like Cloudflare Access does.
import { generateKeyPairSync, sign } from 'node:crypto';

export const ISSUER = 'https://team.cloudflareaccess.com';
export const AUD = 'aud-tag-123';
export const OWNER = 'owner@example.com';

export function makeKey(kid = 'kid-1') {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' };
  return { kid, privateKey, jwk };
}

const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');

export function signToken({ key, header = {}, payload = {}, now = Date.now() }) {
  const nowS = Math.floor(now / 1000);
  const h = { alg: 'RS256', typ: 'JWT', kid: key.kid, ...header };
  const p = { iss: ISSUER, aud: [AUD], email: OWNER, iat: nowS, nbf: nowS, exp: nowS + 600, ...payload };
  const body = `${b64(h)}.${b64(p)}`;
  const sig = sign('RSA-SHA256', Buffer.from(body), key.privateKey).toString('base64url');
  return `${body}.${sig}`;
}

export const goodConfig = () => ({
  localPort: 3017,
  publicHost: 'gpu.example.com',
  accessIssuer: ISSUER,
  accessAud: AUD,
  ownerEmail: OWNER,
});

// A fresh fetch function per test keeps the module-level JWKS cache isolated.
export function jwksFetcher(keys) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    return { keys: keys.map((k) => k.jwk) };
  };
  fn.calls = calls;
  return fn;
}
