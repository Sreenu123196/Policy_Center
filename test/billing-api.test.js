'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { setup, account, autoSubmission } = require('./helpers');
const { createApi } = require('../src/api');
const { Auth } = require('../src/auth');
const { hashPassword } = require('../src/passwords');
const { TEST_PASSWORD } = require('./signin');

// Payments over HTTP, the way the browser calls them: the manager takes a payment, the policy view shows it, and the
// other roles are refused.
async function serve() {
  const env = setup('2026-03-01');
  const { pc, users, run } = env;
  const acct = run(() => account(pc, users.agent));
  const job = run(() => autoSubmission(pc, users.agent, acct, '2026-03-01'));
  run(() => pc.updateDraft(job.id, { paymentPlan: 'Monthly' }, users.agent));
  run(() => pc.quote(job.id, users.agent));
  run(() => pc.bind(job.id, users.agent));

  const auth = new Auth(pc);
  for (const username of ['uwm', 'agent', 'uw']) {
    const staff = pc.staffById(username);
    staff.passwordHash = hashPassword(TEST_PASSWORD);
    staff.mustChangePassword = false;
  }
  const cookie = (username) => `pc_session=${auth.login(username, TEST_PASSWORD).token}`;
  const api = createApi(pc, env.store, { auth });
  const server = http.createServer((req, res) => { const u = new URL(req.url, 'http://x'); api(req, res, u.pathname, u.searchParams); });
  await new Promise((ok) => server.listen(0, ok));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const as = (c) => (path, opts = {}) => fetch(base + path, { ...opts, headers: { Cookie: c, ...(opts.body ? { 'Content-Type': 'application/json' } : {}) }, body: opts.body ? JSON.stringify(opts.body) : undefined });
  return { server, policyId: job.policyId, manager: as(cookie('uwm')), agent: as(cookie('agent')), underwriter: as(cookie('uw')) };
}

test('billing API: the manager takes a payment and sees it on the policy; the others are refused', async () => {
  const s = await serve();
  try {
    const payment = { amount: 50, method: 'Cheque', reference: 'CHQ-100', receivedOn: '2026-03-01' };
    assert.equal((await s.agent(`/policies/${s.policyId}/payments`, { method: 'POST', body: payment })).status, 403);
    assert.equal((await s.underwriter(`/policies/${s.policyId}/payments`, { method: 'POST', body: payment })).status, 403);

    const made = await s.manager(`/policies/${s.policyId}/payments`, { method: 'POST', body: payment });
    assert.equal(made.status, 200);
    assert.equal((await made.json()).allocations.length, 1);

    const again = await s.manager(`/policies/${s.policyId}/payments`, { method: 'POST', body: payment });
    assert.equal(again.status, 422); // the same reference twice

    const view = await (await s.manager(`/policies/${s.policyId}`)).json();
    assert.equal(view.payments.length, 1);
    assert.equal(view.invoices[0].paid, 50);
    assert.equal(view.invoices[0].paymentStatus, 'Part paid');

    const hidden = await (await s.agent(`/policies/${s.policyId}`)).json();
    assert.deepEqual(hidden.payments, []); // billing stays hidden from an agent
    assert.equal((await s.agent(`/policies/${s.policyId}/billing`)).status, 403);
  } finally {
    s.server.close();
  }
});

test('billing API: the missed-payment check is for the manager and reports what it did', async () => {
  const s = await serve();
  try {
    assert.equal((await s.agent('/billing/delinquency', { method: 'POST', body: { asOf: '2026-03-10' } })).status, 403);
    const result = await (await s.manager('/billing/delinquency', { method: 'POST', body: { asOf: '2026-03-10' } })).json();
    assert.deepEqual(result.map((r) => r.step), ['notice']);
  } finally {
    s.server.close();
  }
});
