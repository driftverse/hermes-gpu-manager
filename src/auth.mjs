// Access control for every /api request and the GUI.
//
// Trust model ported from /home/example/Apps/open-higgsfield-ai/server/auth.mjs, adapted from the
// Web `Request` to Node's `http` request (plain lower-case header object + socket peer address).
//
// Two ways in, nothing else:
//   * local:  Host is exactly 127.0.0.1:<port> or localhost:<port>, the TCP peer is genuinely
//             loopback, and the request carries no Cloudflare / forwarding headers (so a proxied
//             request cannot pose as local).
//   * remote: Host is exactly the public host and a valid Cloudflare Access JWT for the owner.
//
// Differences from the studio version (all stricter or specific to this app):
//   * the peer address must be loopback in local mode;
//   * ANY x-forwarded-* header makes a request "proxied" (there is no Next.js layer injecting them);
//   * on the public host a missing/unusable Access config is 503 before anything else is looked at;
//   * the public host can never reach /api/leases/* (403), even with a valid token;
//   * lease endpoints, when called locally, may omit Origin (the renderer is a non-browser client),
//     but a present Origin / Sec-Fetch-Site must still be same-origin, so a web page cannot use them.
//
// Error results carry fixed, generic messages: nothing from the request is echoed back.

import { verifyAccessJwt, configIsUsable } from './jwt.mjs';

const deny = (status, code, message) => ({ ok: false, status, code, message });

// Always-foreign headers: a direct local request never carries these.
const PROXY_HEADER_PATTERN = /^(cf-|x-forwarded-|x-real-ip$|forwarded$|true-client-ip$)/i;
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export const LEASE_PREFIX = '/api/leases/';

export function allowedHosts(config) {
  const port = config.localPort;
  return {
    [`127.0.0.1:${port}`]: { mode: 'local', origin: `http://127.0.0.1:${port}` },
    [`localhost:${port}`]: { mode: 'local', origin: `http://localhost:${port}` },
    [config.publicHost]: { mode: 'remote', origin: `https://${config.publicHost}` },
  };
}

function hasProxyHeaders(headers) {
  return Object.keys(headers).some((name) => PROXY_HEADER_PATTERN.test(name));
}

export async function authorizeRequest(request, config, deps = {}) {
  const headers = request.headers || {};
  const host = String(headers.host || '').toLowerCase();
  const hosts = allowedHosts(config);
  const entry = Object.hasOwn(hosts, host) ? hosts[host] : null;
  if (!entry) return deny(403, 'forbidden_host', 'This host is not allowed.');

  const isLease = typeof request.path === 'string' && request.path.startsWith(LEASE_PREFIX);

  if (entry.mode === 'remote') {
    if (!configIsUsable(config)) return deny(503, 'auth_unavailable', 'Authentication is temporarily unavailable.');
    if (isLease) return deny(403, 'forbidden_lease_remote', 'This endpoint is only available locally.');
  }

  const fetchSite = String(headers['sec-fetch-site'] || '').toLowerCase();
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') {
    return deny(403, 'forbidden_site', 'Cross-site requests are not allowed.');
  }

  if (request.method !== 'GET') {
    const origin = headers.origin;
    const leaseWithoutOrigin = entry.mode === 'local' && isLease && origin === undefined;
    if (!leaseWithoutOrigin && (!origin || origin !== entry.origin)) {
      return deny(403, 'forbidden_origin', 'A matching Origin header is required.');
    }
  }

  if (entry.mode === 'local') {
    if (!LOOPBACK.has(String(request.remoteAddress || '').toLowerCase())) {
      return deny(403, 'forbidden_peer', 'Only loopback connections are allowed on this host.');
    }
    if (hasProxyHeaders(headers)) {
      return deny(403, 'forbidden_proxy', 'Proxied requests must use the public host.');
    }
    return { ok: true, mode: 'local' };
  }

  const verdict = await verifyAccessJwt(headers['cf-access-jwt-assertion'], config, deps);
  if (!verdict.ok) return deny(verdict.status, verdict.code, verdict.message);
  return { ok: true, mode: 'remote', email: verdict.email };
}
