'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { setup } = require('./helpers');
const { createApi } = require('../src/api');
const { Auth } = require('../src/auth');
const { hashPassword } = require('../src/passwords');
const { Chatbot } = require('../src/chatbot');
const { Speech } = require('../src/speech');
const { Messaging } = require('../src/messaging');
const { EventBus } = require('../src/eventBus');
const { TEST_PASSWORD } = require('./signin');

// The permissions matrix (ported from the Insurance Suite): EVERY route of the API against EVERY role.
//
// MATRIX says, for each route, which roles are refused (403). The test builds the list of routes from the API itself, so
//   - a new route that is not in the table fails the test until someone decides who may call it, and
//   - a route removed from the API fails it until the table is cleaned up, and
//   - a role that gains or loses a permission changes a row on purpose, in a reviewed diff.
// Requests use made-up ids, so a role that IS allowed gets a 404 or 422 from the route (anything but 401, 403 or 500).
// Rules that depend on the data (an agent sees only their producer code) are tested with real data in the other tests.

const ROLES = { agent: 'agent', uw: 'uw', exec: 'venkatesh', uwm: 'uwm', sudhakar: 'sudhakar' };

const MATRIX = {
  'GET /staff': ['agent', 'uw', 'exec'],
  'POST /staff': ['agent', 'uw', 'exec'],
  'POST /staff/:id/reset': ['agent', 'uw', 'exec'],
  'POST /staff/:id/active': ['agent', 'uw', 'exec'],
  'GET /meta': [],
  'GET /desktop': [],
  'GET /search': [],
  'GET /accounts': [],
  'POST /accounts': [],
  'GET /accounts/:id': [],
  'PUT /accounts/:id': [],
  'GET /jobs': [],
  'POST /jobs/submission': [],
  'GET /jobs/:id': [],
  'PUT /jobs/:id/period': [],
  'POST /jobs/:id/quote': [],
  'POST /jobs/:id/bind': [],
  'POST /jobs/:id/withdraw': [],
  'POST /jobs/:id/decline': [],
  'POST /jobs/:id/uw-issues/:key/approve': [],
  'GET /policies': [],
  'GET /claims': [],
  'GET /claims/:id': [],
  'GET /policies/:id': [],
  'POST /policies/:id/claims': [],
  'POST /policies/:id/change': [],
  'POST /policies/:id/cancel': [],
  'POST /policies/:id/reinstate': [],
  'POST /policies/:id/renew': [],
  'GET /policies/:id/billing': ['agent', 'uw', 'exec'],
  'GET /policies/:id/ledger': ['agent', 'uw', 'exec'],
  'POST /policies/:id/refunds/:refundId/issue': ['agent', 'uw', 'exec'],
  'POST /policies/:id/payments': ['agent', 'uw', 'exec'],
  'POST /billing/delinquency': ['agent', 'uw', 'exec'],
  'GET /admin/events/dead': ['agent', 'uw', 'exec'],
  'POST /admin/events/run': ['agent', 'uw', 'exec'],
  'POST /admin/events/dead/:consumer/:eventId/redrive': ['agent', 'uw', 'exec'],
  'POST /claims/:id/exposures': ['agent', 'exec'],
  'POST /claims/:id/exposures/:number/reserve': ['agent', 'exec'],
  'POST /claims/:id/exposures/:number/payments': ['agent', 'exec'],
  'POST /claims/:id/payments/:paymentId/approve': ['agent', 'exec'],
  'GET /activities': [],
  'POST /activities/:id/complete': [],
  'GET /ratebooks': [],
  'GET /events': [],
  'POST /batch/renewals': ['agent'],
  'GET /chat/status': [],
  'POST /chat': [],
  'POST /chat/stream': [],
  'GET /speech/status': [],
  'POST /speech': [],
  'GET /sales/analytics': ['uw'],
  'GET /sales/lapsing': ['uw'],
  'GET /sales/followups': ['uw'],
  'GET /sales/policies/:id/followups': ['uw'],
  'POST /sales/policies/:id/followups': ['uw', 'exec'],
  'GET /reports/claims': ['agent', 'exec'],
  'GET /reports/billing': ['agent', 'uw', 'exec'],
  'GET /insights': ['agent', 'uw', 'exec'],
  'GET /finance/report': ['agent', 'uw', 'exec'],
  'GET /finance/expenses': ['agent', 'uw', 'exec'],
  'POST /finance/expenses': ['agent', 'uw', 'exec'],
  'POST /finance/commission': ['agent', 'uw', 'exec'],
  'GET /reports/profitability.xlsx': ['agent', 'uw', 'exec'],
  'GET /reports/profitability.pdf': ['agent', 'uw', 'exec'],
  'GET /tickets': [],
  'GET /tickets/queue': [],
  'POST /tickets': [],
  'GET /tickets/:id': [],
  'POST /tickets/:id/assign': ['agent'],
  'POST /tickets/:id/status': ['agent'],
  'POST /tickets/:id/notes': [],
  'POST /claims/:id/stage': ['agent'],
  'GET /messages/status': [],
  'POST /messages/preview': [],
  'POST /messages/send': [],
  'GET /accounts/:id/messages': [],
  'POST /admin/reset': ['agent', 'uw', 'exec'], // not called for the allowed roles: it would erase the data
};

// Sign-in routes need no session; /auth/password and /auth/me are checked in test/auth.test.js.
const PUBLIC = ['GET /auth/status', 'POST /auth/setup', 'POST /auth/login', 'POST /auth/logout', 'GET /auth/me', 'POST /auth/password'];
// The speech route calls an outside service; with none set up it answers 502 to everybody who is allowed.
const OUTSIDE = ['POST /speech'];

async function serve() {
  const env = setup('2026-03-01');
  const auth = new Auth(env.pc);
  for (const id of Object.values(ROLES)) {
    const staff = env.pc.staffById(id);
    staff.passwordHash = hashPassword(TEST_PASSWORD);
    staff.mustChangePassword = false;
  }
  const cookies = Object.fromEntries(Object.entries(ROLES).map(([name, id]) => [name, `pc_session=${auth.login(id, TEST_PASSWORD).token}`]));
  const api = createApi(env.pc, env.store, { auth, bus: new EventBus(env.pc), chatbot: new Chatbot(env.pc), speech: new Speech(), messaging: new Messaging(env.pc, { transports: {} }) });
  const server = http.createServer((req, res) => { const u = new URL(req.url, 'http://x'); api(req, res, u.pathname, u.searchParams); });
  await new Promise((ok) => server.listen(0, ok));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (route, cookie) => {
    const res = await fetch(base + route.pattern.replace(/:\w+/g, 'zz'), { method: route.method, headers: { ...(cookie ? { Cookie: cookie } : {}), 'Content-Type': 'application/json' }, body: route.method === 'GET' ? undefined : '{}' });
    await res.arrayBuffer().catch(() => 0);
    return res.status;
  };
  return { server, api, cookies, call };
}

const keyOf = (r) => `${r.method} ${r.pattern}`;

test('every route is in the matrix, and the matrix has no route that does not exist', async () => {
  const { server, api } = await serve();
  try {
    const actual = api.routes.map(keyOf).filter((k) => !PUBLIC.includes(k)).sort();
    assert.deepEqual(actual, Object.keys(MATRIX).sort());
  } finally {
    server.close();
  }
});

test('nobody who is not signed in gets into any route except the sign-in routes', async () => {
  const { server, api, call } = await serve();
  try {
    for (const route of api.routes.filter((r) => !PUBLIC.includes(keyOf(r)))) {
      assert.equal(await call(route, null), 401, keyOf(route));
    }
  } finally {
    server.close();
  }
});

test('each role is let in, or refused, exactly as the matrix says', async () => {
  const { server, api, call, cookies } = await serve();
  try {
    for (const route of api.routes.filter((r) => !PUBLIC.includes(keyOf(r)))) {
      const denied = MATRIX[keyOf(route)];
      for (const role of Object.keys(ROLES)) {
        if (keyOf(route) === 'POST /admin/reset' && !denied.includes(role)) continue;
        const status = await call(route, cookies[role]);
        const label = `${role} on ${keyOf(route)} gave ${status}`;
        if (denied.includes(role)) assert.equal(status, 403, label);
        else if (OUTSIDE.includes(keyOf(route))) assert.equal(status, 502, label);
        else assert.ok(status !== 401 && status !== 403 && status < 500, label);
      }
    }
  } finally {
    server.close();
  }
});

test('the dangerous doors are narrow: payments, staff, finance, event redrive and demo reset are for the UW manager only', () => {
  const managerOnly = (key) => assert.deepEqual(MATRIX[key], ['agent', 'uw', 'exec'], key);
  for (const key of ['POST /policies/:id/payments', 'GET /policies/:id/billing', 'GET /policies/:id/ledger', 'POST /policies/:id/refunds/:refundId/issue', 'POST /billing/delinquency', 'GET /staff', 'POST /staff', 'POST /finance/commission', 'GET /finance/report', 'POST /admin/events/dead/:consumer/:eventId/redrive', 'POST /admin/reset']) managerOnly(key);
  // An agent can never move money, change a reserve or a claim stage.
  for (const key of ['POST /claims/:id/exposures/:number/payments', 'POST /claims/:id/exposures/:number/reserve', 'POST /claims/:id/payments/:paymentId/approve', 'POST /claims/:id/stage']) assert.ok(MATRIX[key].includes('agent'), key);
});
