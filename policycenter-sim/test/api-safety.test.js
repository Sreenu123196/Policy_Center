'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { setup } = require('./helpers');
const { createApi } = require('../src/api');
const { Auth } = require('../src/auth');
const { hashPassword } = require('../src/passwords');
const { TEST_PASSWORD } = require('./signin');

// Two protections for callers that retry or work at the same time (ported from the Insurance Suite API):
//   Idempotency-Key  a POST sent twice with the same key does the work once and gets the same answer back.
//   ETag / If-Match  a change to an account or a job says which version it was based on; if someone changed the record
//                    since, the change is refused (412) instead of silently overwriting their work.
// Both are optional for a caller that sends neither header, so older callers keep working.

async function serve() {
  const env = setup('2026-03-01');
  const { pc } = env;
  const auth = new Auth(pc);
  for (const username of ['agent', 'agent2', 'uwm']) {
    const staff = pc.staffById(username);
    staff.passwordHash = hashPassword(TEST_PASSWORD);
    staff.mustChangePassword = false;
  }
  const cookie = (username) => `pc_session=${auth.login(username, TEST_PASSWORD).token}`;
  const api = createApi(pc, env.store, { auth });
  const server = http.createServer((req, res) => { const u = new URL(req.url, 'http://x'); api(req, res, u.pathname, u.searchParams); });
  await new Promise((ok) => server.listen(0, ok));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const as = (c) => (path, { method = 'GET', body, headers = {} } = {}) => fetch(base + path, { method, headers: { Cookie: c, ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { server, pc, agent: as(cookie('agent')), agent2: as(cookie('agent2')), manager: as(cookie('uwm')) };
}

const newAccount = (name = 'Jordan') => ({ firstName: name, lastName: 'Rivera', dob: '1985-05-05', email: 'j@example.com', address: { line1: '1 Main St', city: 'Columbus', state: 'OH', zip: '43215' }, producerCode: 'PC-100' });

test('a POST sent twice with the same key does the work once and returns the same answer', async () => {
  const s = await serve();
  try {
    const headers = { 'Idempotency-Key': 'key-1' };
    const first = await s.agent('/accounts', { method: 'POST', body: newAccount(), headers });
    const again = await s.agent('/accounts', { method: 'POST', body: newAccount(), headers });
    assert.equal(first.status, 201);
    assert.equal(again.status, 201);
    assert.equal(again.headers.get('idempotency-replayed'), 'true');
    assert.equal(first.headers.get('idempotency-replayed'), null);
    assert.deepEqual(await again.json(), await first.json());
    assert.equal(s.pc.db.accounts.length, 1);
  } finally {
    s.server.close();
  }
});

test('the same key for a different request is refused, and keys belong to the person who used them', async () => {
  const s = await serve();
  try {
    const headers = { 'Idempotency-Key': 'key-2' };
    assert.equal((await s.agent('/accounts', { method: 'POST', body: newAccount('Jordan'), headers })).status, 201);
    const other = await s.agent('/accounts', { method: 'POST', body: newAccount('Priya'), headers });
    assert.equal(other.status, 422);
    assert.match((await other.json()).error, /different request/i);
    assert.equal(s.pc.db.accounts.length, 1);

    // Another person may use the same key text for their own request.
    const theirs = await s.agent2('/accounts', { method: 'POST', body: { ...newAccount('Priya'), producerCode: 'PC-200' }, headers });
    assert.equal(theirs.status, 201);
    assert.equal(s.pc.db.accounts.length, 2);
  } finally {
    s.server.close();
  }
});

test('a request that failed is not remembered, so the same key can be used again once it is corrected', async () => {
  const s = await serve();
  try {
    const headers = { 'Idempotency-Key': 'key-3' };
    const bad = await s.agent('/accounts', { method: 'POST', body: { ...newAccount(), dob: 'not a date' }, headers });
    assert.ok(bad.status >= 400 && bad.status < 500);
    const fixed = await s.agent('/accounts', { method: 'POST', body: newAccount(), headers });
    assert.equal(fixed.status, 201);
    assert.equal(fixed.headers.get('idempotency-replayed'), null);
  } finally {
    s.server.close();
  }
});

test('without a key nothing changes: two identical POSTs do the work twice', async () => {
  const s = await serve();
  try {
    await s.agent('/accounts', { method: 'POST', body: newAccount() });
    await s.agent('/accounts', { method: 'POST', body: newAccount() });
    assert.equal(s.pc.db.accounts.length, 2);
  } finally {
    s.server.close();
  }
});

test('an account is read with an ETag, and a change based on an old one is refused', async () => {
  const s = await serve();
  try {
    const created = await (await s.agent('/accounts', { method: 'POST', body: newAccount() })).json();
    const read = await s.agent(`/accounts/${created.id}`);
    const etag = read.headers.get('etag');
    assert.match(etag, /^"[0-9a-f]{16,}"$/);

    const edit = (extra, headers) => s.agent(`/accounts/${created.id}`, { method: 'PUT', body: { ...newAccount(), ...extra }, headers });
    const ok = await edit({ email: 'new@example.com' }, { 'If-Match': etag });
    assert.equal(ok.status, 200);
    const next = ok.headers.get('etag');
    assert.notEqual(next, etag); // the record changed, so its ETag did

    // Someone else's edit (still holding the first ETag) is refused, and what was saved stays.
    const stale = await edit({ email: 'lost@example.com' }, { 'If-Match': etag });
    assert.equal(stale.status, 412);
    assert.equal(s.pc.db.accounts[0].email, 'new@example.com');
    // With the current ETag it works; with no header it still works (older callers).
    assert.equal((await edit({ email: 'again@example.com' }, { 'If-Match': next })).status, 200);
    assert.equal((await edit({ email: 'last@example.com' }, {})).status, 200);
  } finally {
    s.server.close();
  }
});

test('a job draft has an ETag too: a second editor with an old copy is refused', async () => {
  const s = await serve();
  try {
    const acct = await (await s.agent('/accounts', { method: 'POST', body: newAccount() })).json();
    const job = await (await s.agent('/jobs/submission', { method: 'POST', body: { accountId: acct.id, product: 'PersonalAuto', effectiveDate: '2026-03-01' } })).json();
    const etag = (await s.agent(`/jobs/${job.id}`)).headers.get('etag');
    assert.ok(etag);
    const save = (headers) => s.agent(`/jobs/${job.id}/period`, { method: 'PUT', body: { paymentPlan: 'Monthly' }, headers });
    const first = await save({ 'If-Match': etag });
    assert.equal(first.status, 200);
    assert.equal((await save({ 'If-Match': etag })).status, 412); // the copy is now old
    assert.equal((await save({ 'If-Match': first.headers.get('etag') })).status, 200);
  } finally {
    s.server.close();
  }
});
