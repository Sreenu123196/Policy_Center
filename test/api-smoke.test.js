'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { setup, account, autoSubmission } = require('./helpers');
const { createApi } = require('../src/api');
const { Auth } = require('../src/auth');
const { hashPassword } = require('../src/passwords');
const { Chatbot } = require('../src/chatbot');
const { Speech } = require('../src/speech');
const { Messaging } = require('../src/messaging');
const { EventBus } = require('../src/eventBus');
const { seed } = require('../src/seed');
const { todayISO: today } = require('../src/dates');
const { TEST_PASSWORD } = require('./signin');

// The happy path over HTTP, with real data.
//
// test/permissions-matrix.test.js already calls every route as every role — but with made-up ids, and it skips the reset
// button because that would erase the data. That gap is exactly where a shipped bug lived: POST /api/admin/reset wiped the
// staff, the seed then died with "Unknown user 'agent'", and nothing failed until a person clicked it. These tests read
// the same routes with real ids, and drive the main write flow end to end.

async function serve(today = '2026-03-01') {
  const env = setup(today);
  const auth = new Auth(env.pc);
  const manager = env.pc.staffById('uwm');
  manager.passwordHash = hashPassword(TEST_PASSWORD);
  manager.mustChangePassword = false;
  const cookie = `pc_session=${auth.login('uwm', TEST_PASSWORD).token}`;
  const api = createApi(env.pc, env.store, {
    backupDir: path.join(os.tmpdir(), 'pc-smoke-backups'),
    auth,
    bus: new EventBus(env.pc),
    chatbot: new Chatbot(env.pc),
    speech: new Speech({ config: { speechEngine: 'whisper', whisperUrl: 'http://127.0.0.1:1', speechRegion: 'us', speechLanguages: [], speechModel: 'chirp_3' }, fetchImpl: async () => new Response('no', { status: 500 }) }),
    messaging: new Messaging(env.pc, { transports: {} }),
    reseed: () => seed(env.pc),
  });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    api(req, res, url.pathname, url.searchParams);
  });
  await new Promise((ok) => server.listen(0, ok));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const request = async (method, url, body) => {
    const res = await fetch(base + url, {
      method,
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const bytes = Buffer.from(await res.arrayBuffer());
    const json = /application\/json/.test(res.headers.get('content-type') || '');
    return { status: res.status, body: json && bytes.length ? JSON.parse(bytes.toString()) : bytes };
  };
  return { env, server, api, get: (url) => request('GET', url), post: (url, body = {}) => request('POST', url, body), put: (url, body = {}) => request('PUT', url, body) };
}

// A book with everything a read route can be asked for.
function book(env) {
  const { pc, users, run } = env;
  const acct = run(() => account(pc, users.agent));
  const job = run(() => autoSubmission(pc, users.agent, acct, '2026-03-01'));
  run(() => pc.updateDraft(job.id, { paymentPlan: 'Monthly' }, users.agent));
  run(() => pc.quote(job.id, users.agent));
  run(() => pc.bind(job.id, users.agent));
  const policy = pc.db.policies[0];
  run(() => pc.createTicket({ accountId: acct.id, category: 'Billing', subject: 'Smoke', description: '', priority: 'Normal' }, users.agent));
  return { acct, job, policy, document: pc.db.documents[0], ticket: pc.db.tickets[0], activity: pc.db.activities[0], claim: pc.db.claims[0] };
}

const realIds = (state) => ({
  account: state.acct.id,
  policy: state.policy.id,
  job: state.job.id,
  document: state.document && state.document.id,
  ticket: state.ticket && state.ticket.id,
  activity: state.activity && state.activity.id,
  claim: state.claim && state.claim.id,
  producer: 'PC-100',
  agent: 'underwriting', // the only agent with a backtest
  consumer: 'collections',
  eventId: 'EVT-00000001',
});

// /policies/:id -> the real policy id, /documents/:id -> the real document id, and so on.
function realUrl(pattern, ids) {
  const bySegment = {
    accounts: ids.account, jobs: ids.job, policies: ids.policy, claims: ids.claim,
    documents: ids.document, tickets: ids.ticket, activities: ids.activity,
    producers: ids.producer, agents: ids.agent,
  };
  return pattern.replace(/([a-z]+)\/:([a-z]+)/gi, (match, segment, name) => `${segment}/${bySegment[segment.toLowerCase()] || ids[name] || 'missing'}`);
}

test('every read route answers 200 with real data (not just "no 500")', async () => {
  const { env, server, api, get } = await serve();
  try {
    const ids = realIds(book(env));
    // Routes whose subject genuinely does not exist in this small book.
    const NOTHING_YET = new Set(['GET /claims/:id', 'GET /claims/:id/exposures']);
    // The Twilio voice door is for a telephone, not a browser: an unknown call correctly answers 404.
    for (const route of api.routes.filter((r) => r.method === 'GET' && r.pattern !== '/health' && !r.pattern.startsWith('/webhooks/'))) {
      const url = realUrl(route.pattern, ids);
      const { status, body } = await get(url);
      if (NOTHING_YET.has(`GET ${route.pattern}`)) {
        assert.ok(status === 404 || status === 200, `${url} gave ${status}`);
        continue;
      }
      const text = Buffer.isBuffer(body) ? body.slice(0, 200).toString() : JSON.stringify(body).slice(0, 200);
      assert.equal(status, 200, `${url} gave ${status}: ${text}`);
    }
  } finally {
    server.close();
  }
});

test('the reset button works over HTTP, and the app is usable afterwards', async () => {
  // The seed lays the demo history out around the real today, so this one test uses the real clock, as the server does.
  const { env, server, post, get } = await serve(today());
  try {
    const reset = await post('/admin/reset');
    assert.equal(reset.status, 200, `reset gave ${reset.status}`);
    assert.ok(env.pc.db.staff.some((person) => person.role === 'UW Manager'), 'a manager can still sign in');
    assert.ok(env.pc.db.staff.length >= 7, 'the built-in team is back');
    assert.equal(env.pc.db.policies.length >= 1, true, 'the demo book came back');

    const accounts = await get('/accounts');
    assert.equal(accounts.status, 200);
    assert.ok(Array.isArray(accounts.body));
  } finally {
    server.close();
  }
});

test('a person can go from a new account to a bound policy, a payment and a ticket over HTTP', async () => {
  const { server, get, post, put } = await serve();
  try {
    const made = await post('/accounts', {
      firstName: 'Smoke', lastName: 'Test', dob: '1980-01-15', email: 'smoke@example.com',
      address: { line1: '1 Main St', city: 'Columbus', state: 'OH', zip: '43215' }, producerCode: 'PC-100',
    });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const accountId = made.body.id;

    const submission = await post('/jobs/submission', { accountId, product: 'PersonalAuto', effectiveDate: '2026-03-01' });
    assert.equal(submission.status, 201, JSON.stringify(submission.body));
    const jobId = submission.body.id;

    const draft = await get(`/jobs/${jobId}`);
    assert.equal(draft.status, 200);
    const updated = await put(`/jobs/${jobId}/period`, {
      paymentPlan: 'Monthly',
      line: {
        ...draft.body.period.line,
        drivers: [{ firstName: 'T', lastName: 'I', dob: '1980-01-15', licenseNumber: 'OH1', licenseState: 'OH', yearsLicensed: 20, accidents: 0, violations: 0 }],
        vehicles: [{ year: 2021, make: 'Ford', model: 'Escape', vin: '1FMCU9G60MUA12345', usage: 'Commute', annualMiles: 12000, marketValue: 22000, garagingZip: '43215' }],
      },
    });
    assert.ok(updated.status < 400, JSON.stringify(updated.body));

    const quoted = await post(`/jobs/${jobId}/quote`);
    assert.equal(quoted.status, 200, JSON.stringify(quoted.body));
    const bound = await post(`/jobs/${jobId}/bind`);
    assert.equal(bound.status, 200, JSON.stringify(bound.body));
    assert.ok(bound.body.policyId);

    const policy = await get(`/policies/${bound.body.policyId}`);
    assert.equal(policy.status, 200);
    assert.match(policy.body.policyNumber, /^PA-/, 'the policy is readable after binding');

    const payment = await post(`/policies/${bound.body.policyId}/payments`, { amount: 25, method: 'Cash', receivedOn: '2026-03-02', reference: 'SMOKE-1' });
    assert.ok(payment.status < 400, JSON.stringify(payment.body));

    const ticket = await post('/tickets', { accountId, category: 'Billing', subject: 'Smoke', description: 'from the test', priority: 'Normal' });
    assert.ok(ticket.status < 300, JSON.stringify(ticket.body));
    const ticketPage = await get(`/tickets/${ticket.body.id}`);
    assert.equal(ticketPage.status, 200);
  } finally {
    server.close();
  }
});
