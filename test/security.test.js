'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { setup } = require('./helpers');
const { createApi } = require('../src/api');
const { Auth } = require('../src/auth');
const { hashPassword } = require('../src/passwords');
const { createHandler } = require('../src/webServer');
const { RateLimiter } = require('../src/security');
const { TEST_PASSWORD } = require('./signin');

// Security of the web edge (Tier 4): what every response carries, what a request must look like, and what is refused. The rest
// of access control (who may call which route) is the permissions matrix in test/permissions-matrix.test.js.

async function serve(options = {}) {
  const env = setup('2026-03-01');
  const auth = new Auth(env.pc);
  for (const username of ['uwm', 'agent']) {
    const staff = env.pc.staffById(username);
    staff.passwordHash = hashPassword(TEST_PASSWORD);
    staff.mustChangePassword = false;
  }
  const api = createApi(env.pc, env.store, { auth });
  const handler = createHandler({ api, publicDir: path.join(__dirname, '..', 'public'), ...options });
  const server = http.createServer(handler);
  await new Promise((ok) => server.listen(0, ok));
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = async (username) => {
    const res = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: TEST_PASSWORD }) });
    return { res, cookie: String(res.headers.get('set-cookie')).split(';')[0] };
  };
  return { ...env, server, base, login, auth };
}

test('every response carries the security headers; pages also carry a content security policy', async () => {
  const s = await serve();
  try {
    for (const url of ['/', '/app.js', '/api/health', '/api/nothing-here']) {
      const res = await fetch(s.base + url);
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff', url);
      assert.equal(res.headers.get('x-frame-options'), 'DENY', url);
      assert.equal(res.headers.get('referrer-policy'), 'no-referrer', url);
      assert.ok(res.headers.get('permissions-policy').includes('camera=()'), url);
      assert.equal(res.headers.get('access-control-allow-origin'), null, `${url} allows no other site to read it`);
    }
    const csp = (await fetch(`${s.base}/`)).headers.get('content-security-policy');
    for (const part of ["default-src 'self'", "script-src 'self'", "object-src 'none'", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'self'"]) assert.ok(csp.includes(part), part);
    assert.ok(!/script-src[^;]*unsafe/.test(csp), 'scripts cannot be inline or evaluated');
  } finally {
    s.server.close();
  }
});

test('the session cookie cannot be read by a script, is not sent from other sites, and is Secure over https', async () => {
  const s = await serve();
  try {
    const plain = (await s.login('uwm')).res.headers.get('set-cookie');
    assert.match(plain, /HttpOnly/);
    assert.match(plain, /SameSite=Strict/);
    assert.ok(!/Secure/.test(plain), 'not Secure over plain http (a local run)');
    const res = await fetch(`${s.base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-Proto': 'https' }, body: JSON.stringify({ username: 'uwm', password: TEST_PASSWORD }) });
    assert.match(res.headers.get('set-cookie'), /; Secure/);
    assert.match(res.headers.get('strict-transport-security'), /max-age=\d+/);
  } finally {
    s.server.close();
  }
});

test('files outside the public folder cannot be read, however the path is written', async () => {
  const s = await serve();
  try {
    for (const url of ['/../package.json', '/%2e%2e/package.json', '/..%2fpackage.json', '/..%5cpackage.json', '/public/../server.js', '/%00', '/....//package.json']) {
      const res = await fetch(s.base + url);
      assert.ok([400, 404].includes(res.status), `${url} gave ${res.status}`);
      const text = await res.text();
      assert.ok(!text.includes('"policycenter-sim"'), `${url} did not give out package.json`);
    }
    assert.equal((await fetch(`${s.base}/index.html`)).status, 200);
  } finally {
    s.server.close();
  }
});

test('a request that writes must be JSON, from this site, of a sensible size and well formed', async () => {
  const s = await serve();
  try {
    const { cookie } = await s.login('uwm');
    const post = (body, headers = {}) => fetch(`${s.base}/api/tickets`, { method: 'POST', headers: { Cookie: cookie, ...headers }, body });
    // Not JSON: a form posted from another site would look like this.
    assert.equal((await post('subject=x', { 'Content-Type': 'application/x-www-form-urlencoded' })).status, 415);
    assert.equal((await post('{"subject":"x"}', { 'Content-Type': 'text/plain' })).status, 415);
    // From another site.
    assert.equal((await post('{}', { 'Content-Type': 'application/json', Origin: 'https://evil.example' })).status, 403);
    // Its own site is fine (the request fails later for a missing field, not for where it came from).
    const own = await post('{}', { 'Content-Type': 'application/json', Origin: s.base });
    assert.notEqual(own.status, 403);
    assert.notEqual(own.status, 415);
    // Malformed JSON and far too much of it.
    assert.equal((await post('{not json', { 'Content-Type': 'application/json' })).status, 400);
    assert.equal((await post(JSON.stringify({ subject: 'x'.repeat(2_000_000) }), { 'Content-Type': 'application/json' })).status, 413);
  } finally {
    s.server.close();
  }
});

test('a body cannot change what every object in the server inherits (prototype pollution)', async () => {
  const s = await serve();
  try {
    const { cookie } = await s.login('uwm');
    const body = '{"firstName":"A","lastName":"B","__proto__":{"polluted":"yes"},"constructor":{"prototype":{"polluted":"yes"}},"address":{"__proto__":{"polluted":"yes"}}}';
    await fetch(`${s.base}/api/accounts`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body });
    assert.equal({}.polluted, undefined);
    assert.equal(Object.prototype.polluted, undefined);
  } finally {
    s.server.close();
  }
});

test('an error never gives out the inside of the server', async () => {
  const s = await serve();
  try {
    const { cookie } = await s.login('uwm');
    s.pc.listPolicies = () => { throw new Error('secret path C:\\data\\policycenter.json and a stack'); };
    const res = await fetch(`${s.base}/api/policies`, { headers: { Cookie: cookie } });
    assert.equal(res.status, 500);
    const text = await res.text();
    assert.ok(!/secret path|policycenter\.json|\bat .*\.js/.test(text), text);
    assert.match(JSON.parse(text).error, /went wrong/i);
  } finally {
    s.server.close();
  }
});

test('too many sign-in attempts from one address are slowed down, whatever name they try', async () => {
  const s = await serve({ loginLimit: { max: 5, windowSeconds: 60 } });
  try {
    const attempt = (n) => fetch(`${s.base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: `nobody${n}`, password: 'wrong-password' }) });
    const statuses = [];
    for (let n = 0; n < 8; n++) statuses.push((await attempt(n)).status);
    assert.deepEqual(statuses.slice(0, 5), [401, 401, 401, 401, 401]);
    assert.deepEqual(statuses.slice(5), [429, 429, 429]);
    const limited = await attempt(9);
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
  } finally {
    s.server.close();
  }
});

test('the rate limiter counts per key and forgets after its window', () => {
  let now = 1000;
  const limiter = new RateLimiter({ max: 3, windowMs: 1000, clock: () => now });
  assert.deepEqual([1, 2, 3, 4].map(() => limiter.take('a').allowed), [true, true, true, false]);
  assert.equal(limiter.take('b').allowed, true, 'another key has its own count');
  now += 1001;
  assert.equal(limiter.take('a').allowed, true, 'the window has passed');
  assert.ok(limiter.take('a').retryAfterSeconds >= 0);
});

test('sign-in is still needed for everything but the health check and the sign-in routes', async () => {
  const s = await serve();
  try {
    assert.equal((await fetch(`${s.base}/api/health`)).status, 200);
    for (const url of ['/api/policies', '/api/accounts', '/api/claims', '/api/accounting/trial-balance', '/api/admin/metrics']) {
      assert.equal((await fetch(s.base + url)).status, 401, url);
    }
  } finally {
    s.server.close();
  }
});
