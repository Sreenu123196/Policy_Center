'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHandler } = require('../src/webServer');

// /health must reach the API, because a load balancer asks there. Verified against the running server first: /api/health was 200 and /health
// was 404, which would have been a deploy that never became healthy.

function call(pathname) {
  const seen = [];
  const handler = createHandler({
    api: (req, res, path, params) => { seen.push({ path, params: Boolean(params) }); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}'); },
    publicDir: require('node:path').join(__dirname, '..', 'public'),
  });
  const req = { url: pathname, method: 'GET', headers: {}, socket: { remoteAddress: '127.0.0.1' } };
  let status = null;
  const res = { writeHead(code) { status = code; }, end() {}, setHeader() {}, getHeader() { return null; } };
  handler(req, res);
  return { seen, status };
}

test('/health reaches the API at the root, not the static files', () => {
  const { seen, status } = call('/health');
  assert.equal(seen.length, 1, 'the API was called');
  assert.equal(seen[0].path, '/health');
  assert.equal(status, 200);
});

test('/api/health still reaches the API', () => {
  const { seen } = call('/api/health');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].path, '/api/health');
});
