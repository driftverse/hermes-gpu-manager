// Ported verbatim (logic unchanged) from /home/example/Apps/open-higgsfield-ai/server/jwt.mjs.
// Do not import across projects; keep in sync by hand if the studio version changes.
//
// Cloudflare Access JWT verification with native crypto only.
//
// Verifies: RS256 alg, kid, RSA signature against the pinned issuer's JWKS, exp, nbf, iss, aud and
// a non-empty email equal to the configured owner. JWKS is fetched only from
// `<issuer>/cdn-cgi/access/certs`, never from anything in the token. Every failure is closed.

import { createPublicKey, verify } from 'node:crypto';

const MAX_TOKEN_BYTES = 8192;
const NBF_LEEWAY_S = 30;
const JWKS_TTL_MS = 5 * 60 * 1000;
const JWKS_REFETCH_MIN_MS = 30 * 1000;
const JWKS_TIMEOUT_MS = 5000;
const JWKS_MAX_BYTES = 256 * 1024;

const fail = (status, code, message) => ({ ok: false, status, code, message });
const unauthenticated = () => fail(401, 'unauthenticated', 'A valid Access token is required.');
const unavailable = () => fail(503, 'auth_unavailable', 'Authentication is temporarily unavailable.');

export async function defaultFetchJwks(url) {
  const res = await fetch(url, {
    redirect: 'error',
    signal: AbortSignal.timeout(JWKS_TIMEOUT_MS),
    headers: { accept: 'application/json' },
  });
  if (!res.ok) throw new Error('jwks http status');
  const text = await res.text();
  if (text.length > JWKS_MAX_BYTES) throw new Error('jwks too large');
  return JSON.parse(text);
}

function parseKeys(doc) {
  const keys = new Map();
  if (!doc || !Array.isArray(doc.keys)) return keys;
  for (const jwk of doc.keys) {
    if (!jwk || typeof jwk !== 'object' || jwk.kty !== 'RSA' || typeof jwk.kid !== 'string') continue;
    try {
      keys.set(jwk.kid, createPublicKey({ key: jwk, format: 'jwk' }));
    } catch {
      // Ignore malformed keys; a token that needs one simply fails.
    }
  }
  return keys;
}

// One provider (cache) per fetch function, so production keeps a single cache and tests stay isolated.
const providers = new WeakMap();

function getProvider(fetchJwks, issuer) {
  let byIssuer = providers.get(fetchJwks);
  if (!byIssuer) providers.set(fetchJwks, (byIssuer = new Map()));
  let state = byIssuer.get(issuer);
  if (!state) byIssuer.set(issuer, (state = { keys: new Map(), fetchedAt: 0, inflight: null }));
  return state;
}

async function loadKey(kid, config, deps) {
  const fetchJwks = deps.fetchJwks || defaultFetchJwks;
  const now = (deps.now || Date.now)();
  const state = getProvider(fetchJwks, config.accessIssuer);
  const age = now - state.fetchedAt;
  const stale = state.fetchedAt === 0 || age > JWKS_TTL_MS;
  const unknownKidRefresh = !state.keys.has(kid) && age > JWKS_REFETCH_MIN_MS;
  if (stale || unknownKidRefresh) {
    state.inflight ||= (async () => {
      try {
        const doc = await fetchJwks(`${config.accessIssuer}/cdn-cgi/access/certs`);
        state.keys = parseKeys(doc);
        state.fetchedAt = now;
      } finally {
        state.inflight = null;
      }
    })();
    await state.inflight;
  }
  return state.keys.get(kid) || null;
}

function decodeSegment(segment) {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) return null;
  try {
    const value = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

export function configIsUsable(config) {
  if (!config.accessAud || !config.ownerEmail || !config.accessIssuer) return false;
  try {
    const url = new URL(config.accessIssuer);
    return url.protocol === 'https:' && url.origin === config.accessIssuer;
  } catch {
    return false;
  }
}

export async function verifyAccessJwt(token, config, deps = {}) {
  if (!configIsUsable(config)) return unavailable();
  if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_BYTES) return unauthenticated();

  const parts = token.split('.');
  if (parts.length !== 3 || !parts[2]) return unauthenticated();
  const header = decodeSegment(parts[0]);
  const payload = decodeSegment(parts[1]);
  if (!header || !payload) return unauthenticated();
  if (header.alg !== 'RS256' || typeof header.kid !== 'string' || !header.kid) return unauthenticated();
  if (!/^[A-Za-z0-9_-]+$/.test(parts[2])) return unauthenticated();

  let publicKey;
  try {
    publicKey = await loadKey(header.kid, config, deps);
  } catch {
    return unavailable();
  }
  if (!publicKey) return unauthenticated();

  const valid = verify(
    'RSA-SHA256',
    Buffer.from(`${parts[0]}.${parts[1]}`),
    publicKey,
    Buffer.from(parts[2], 'base64url'),
  );
  if (!valid) return unauthenticated();

  const nowS = Math.floor((deps.now || Date.now)() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp <= nowS) return unauthenticated();
  if (payload.nbf !== undefined && (typeof payload.nbf !== 'number' || payload.nbf > nowS + NBF_LEEWAY_S)) {
    return unauthenticated();
  }
  if (payload.iss !== config.accessIssuer) return unauthenticated();
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audiences.includes(config.accessAud)) return unauthenticated();

  const email = typeof payload.email === 'string' ? payload.email.trim() : '';
  if (!email || email.toLowerCase() !== config.ownerEmail.trim().toLowerCase()) {
    return fail(403, 'forbidden_identity', 'This identity is not allowed.');
  }
  return { ok: true, email };
}
