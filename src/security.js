'use strict';
// Security of the web edge: headers every response carries, a limit on sign-in attempts, and checks on a request that writes.

// A fixed-window counter per key (for sign-in attempts, the key is the caller's address).
class RateLimiter {
  constructor({ max, windowMs, clock = Date.now }) {
    this.max = max;
    this.windowMs = windowMs;
    this.clock = clock;
    this.hits = new Map(); // key -> { count, resetAt }
  }

  take(key) {
    const now = this.clock();
    if (this.hits.size > 10000) for (const [k, v] of this.hits) if (v.resetAt <= now) this.hits.delete(k);
    let entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + this.windowMs };
      this.hits.set(key, entry);
    }
    entry.count++;
    return { allowed: entry.count <= this.max, retryAfterSeconds: Math.max(0, Math.ceil((entry.resetAt - now) / 1000)) };
  }
}

// Scripts and styles come only from this site: no inline script, no eval, no framing, no plug-ins.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'", // the pages set a few style attributes
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

function isHttps(req) {
  return String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https' || Boolean(req.socket && req.socket.encrypted);
}

// Headers for every response. Over https (seen by the proxy in front) the browser is also told to keep using https.
function applySecurityHeaders(req, res, { page = false } = {}) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), geolocation=(), payment=(), usb=(), microphone=(self)');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  if (page) res.setHeader('Content-Security-Policy', CSP);
  if (isHttps(req)) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    // The session cookie is only sent back over https.
    const set = res.setHeader.bind(res);
    res.setHeader = (name, value) => (String(name).toLowerCase() === 'set-cookie' && !/;\s*Secure/i.test(String(value)) ? set(name, `${value}; Secure`) : set(name, value));
  }
}

// A request that writes must come from this site. Browsers send Origin on such requests; a different host is refused.
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function isJsonType(req) {
  return /^application\/(.+\+)?json\b/i.test(String(req.headers['content-type'] || ''));
}

// A body parsed from JSON must not be able to carry keys that change what every object inherits.
function stripDangerousKeys(key, value) {
  return key === '__proto__' || key === 'constructor' || key === 'prototype' ? undefined : value;
}

module.exports = { RateLimiter, CSP, applySecurityHeaders, sameOrigin, isJsonType, isHttps, stripDangerousKeys };
