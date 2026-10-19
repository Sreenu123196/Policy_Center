'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { setup, account, autoSubmission } = require('./helpers');
const { createApi } = require('../src/api');
const { Auth } = require('../src/auth');
const { hashPassword } = require('../src/passwords');
const { TEST_PASSWORD } = require('./signin');

// Claim exposures, reserves and payments over HTTP, the way the browser calls them.
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

test('claims API: an agent reports a loss; staff add an exposure, reserve and pay; a big payment waits for the manager', async () => {
  const s = await serve();
  try {
    const opened = await s.agent(`/policies/${s.policyId}/claims`, { method: 'POST', body: { lossDate: '2026-03-01', lossType: 'Collision', description: 'Rear-ended' } });
    assert.equal(opened.status, 200);
    const claim = await opened.json();
    assert.equal(claim.status, 'Submitted');
    assert.deepEqual(claim.nextStages, ['Under Review', 'Rejected']);

    const stage = (as, to) => as(`/claims/${claim.id}/stage`, { method: 'POST', body: { to } });
    assert.equal((await stage(s.agent, 'Under Review')).status, 403);
    assert.equal((await stage(s.underwriter, 'Under Review')).status, 200);

    const exposures = `/claims/${claim.id}/exposures`;
    assert.equal((await s.agent(exposures, { method: 'POST', body: { coverage: 'Collision', claimantName: 'Asha', claimantKind: 'insured' } })).status, 403);
    assert.equal((await s.underwriter(exposures, { method: 'POST', body: { coverage: 'Collision', claimantName: 'Asha', claimantKind: 'insured' } })).status, 200);
    assert.equal((await s.manager(`${exposures}/1/reserve`, { method: 'POST', body: { amount: 30000 } })).status, 200);
    await stage(s.underwriter, 'Approved');

    const big = await (await s.underwriter(`${exposures}/1/payments`, { method: 'POST', body: { amount: 8000, costType: 'claim_cost' } })).json();
    assert.equal(big.result.status, 'pending_approval');
    assert.equal(big.claim.pendingPayments.length, 1);
    assert.equal((await s.underwriter(`/claims/${claim.id}/payments/${big.result.id}/approve`, { method: 'POST', body: {} })).status, 409); // not by the requester

    const done = await (await s.manager(`/claims/${claim.id}/payments/${big.result.id}/approve`, { method: 'POST', body: {} })).json();
    assert.equal(done.claim.paid, 8000);
    assert.equal(done.claim.exposures[0].paid, 8000);

    // An agent sees the money paid but not the reserve.
    const seen = await (await s.agent(`/claims/${claim.id}`)).json();
    assert.equal(seen.exposures[0].paid, 8000);
    assert.equal('reserve' in seen.exposures[0], false);
  } finally {
    s.server.close();
  }
});
