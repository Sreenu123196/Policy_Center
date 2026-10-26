'use strict';
// The request handler of the server: the security checks, then /api to the API and everything else to the files in public/.
const fs = require('node:fs');
const path = require('node:path');
const { RateLimiter, applySecurityHeaders, sameOrigin, isJsonType } = require('./security');

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json' };
const RAW_ROUTES = new Set(['/api/speech', '/api/webhooks/twilio/decision', '/api/webhooks/razorpay']); // a recording and Twilio's form, not JSON

function plain(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

function json(res, status, payload, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(payload));
}

function createHandler({ api, publicDir, loginLimit = { max: 30, windowSeconds: 60 }, trustProxy = false, allowedOrigins = [] }) {
  const root = path.resolve(publicDir);
  const limiter = new RateLimiter({ max: loginLimit.max, windowMs: loginLimit.windowSeconds * 1000 });

  // The caller's address. Behind a proxy that is the first address it forwarded; otherwise the connection's own.
  const addressOf = (req) => (trustProxy && req.headers['x-forwarded-for'] ? String(req.headers['x-forwarded-for']).split(',')[0].trim() : req.socket.remoteAddress) || 'unknown';

  function serveStatic(pathname, res) {
    let rel;
    try {
      rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^[/\\]+/, '');
    } catch {
      return plain(res, 400, 'Bad request');
    }
    if (rel.includes('\0')) return plain(res, 400, 'Bad request');
    const file = path.resolve(root, rel);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return plain(res, 404, 'Not found');
    res.writeHead(200, { 'Content-Type': `${TYPES[path.extname(file)] || 'application/octet-stream'}; charset=utf-8`, 'Cache-Control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  }

  return function handler(req, res) {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      return plain(res, 400, 'Bad request');
    }
    // A load balancer asks /health, not /api/health, so the root path counts as an API path. Verified against a running server before the fix:
  // /api/health answered 200 while /health answered 404, which is a deploy that never becomes healthy.
  const isApi = url.pathname === '/api' || url.pathname.startsWith('/api/') || url.pathname === '/health';
    applySecurityHeaders(req, res, { page: !isApi });

    if (isApi) {
      if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') {
        if (!sameOrigin(req, allowedOrigins)) return json(res, 403, { error: 'This request did not come from this site' });
        const hasBody = Number(req.headers['content-length'] || 0) > 0 || Boolean(req.headers['transfer-encoding']);
        if (hasBody && !RAW_ROUTES.has(url.pathname) && !isJsonType(req)) return json(res, 415, { error: 'Send the request as application/json' });
      }
      if (req.method === 'OPTIONS') return plain(res, 405, 'Not allowed'); // no cross-site access is ever granted
      if (req.method === 'POST' && (url.pathname === '/api/auth/login' || url.pathname === '/api/auth/setup')) {
        const { allowed, retryAfterSeconds } = limiter.take(addressOf(req));
        if (!allowed) return json(res, 429, { error: 'Too many sign-in attempts. Wait a little and try again.' }, { 'Retry-After': String(Math.max(1, retryAfterSeconds)) });
      }
      return api(req, res, url.pathname, url.searchParams);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return plain(res, 405, 'Method not allowed');
    serveStatic(url.pathname, res);
  };
}

module.exports = { createHandler };
