'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { setup, account, autoSubmission } = require('./helpers');
const { createApi } = require('../src/api');
const { Auth } = require('../src/auth');
const { hashPassword } = require('../src/passwords');
const { TEST_PASSWORD } = require('./signin');
const { EventBus } = require('../src/eventBus');
const { collectionsConsumer } = require('../src/consumers');

// The event consumers over HTTP: a write is followed by a run of the consumers, and the admin routes are for managers.
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
  const bus = new EventBus(pc);
  bus.register('collections', collectionsConsumer(pc));
  const api = createApi(pc, env.store, { auth, bus });
  const server = http.createServer((req, res) => { const u = new URL(req.url, 'http://x'); api(req, res, u.pathname, u.searchParams); });
  await new Promise((ok) => server.listen(0, ok));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const as = (c) => (path, opts = {}) => fetch(base + path, { ...opts, headers: { Cookie: c, ...(opts.body ? { 'Content-Type': 'application/json' } : {}) }, body: opts.body ? JSON.stringify(opts.body) : undefined });
  return { server, policyId: job.policyId, manager: as(cookie('uwm')), agent: as(cookie('agent')), underwriter: as(cookie('uw')) };
}

test('event consumers: a missed payment becomes an activity by itself, and the admin routes are for managers', async () => {
  const s = await serve();
  try {
    // The check publishes PaymentMissed; the server runs the consumers right after the write.
    await s.manager('/billing/delinquency', { method: 'POST', body: { asOf: '2026-03-10' } });
    const activities = await (await s.manager('/activities')).json();
    assert.ok(activities.some((a) => a.type === 'Collections' && /missed payment/i.test(a.subject)));
    const events = await (await s.manager('/events')).json();
    assert.equal(events.find((e) => e.type === 'PaymentMissed').status, 'Delivered');

    assert.deepEqual(await (await s.manager('/admin/events/dead')).json(), []);
    assert.equal((await s.agent('/admin/events/dead')).status, 403);
    assert.equal((await s.underwriter('/admin/events/run', { method: 'POST', body: {} })).status, 403);
    assert.equal((await s.manager('/admin/events/dead/collections/EVT-00000001/redrive', { method: 'POST', body: {} })).status, 404);
  } finally {
    s.server.close();
  }
});
