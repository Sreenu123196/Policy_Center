'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { setup } = require('./helpers');
const { createApi } = require('../src/api');
const { Auth } = require('../src/auth');
const { hashPassword } = require('../src/passwords');
const { TEST_PASSWORD } = require('./signin');

// The profitability endpoints, called over HTTP the way the browser calls them.
async function serve() {
  const env = setup();
  // One Auth for everyone, so all three sessions are known to the API.
  const auth = new Auth(env.pc);
  const sessionFor = (username) => `pc_session=${auth.login(username, TEST_PASSWORD).token}`;
  for (const username of ['uwm', 'agent', 'uw']) {
    const staff = env.pc.staffById(username);
    staff.passwordHash = hashPassword(TEST_PASSWORD);
    staff.mustChangePassword = false;
  }
  const managerCookie = sessionFor('uwm');
  const agentCookie = sessionFor('agent');
  const underwriterCookie = sessionFor('uw');
  const api = createApi(env.pc, env.store, { auth });
  const server = http.createServer((req, res) => { const u = new URL(req.url, 'http://x'); api(req, res, u.pathname, u.searchParams); });
  await new Promise((ok) => server.listen(0, ok));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const as = (cookie) => (path, opts = {}) => fetch(base + path, { ...opts, headers: { Cookie: cookie, ...(opts.body ? { 'Content-Type': 'application/json' } : {}) }, body: opts.body ? JSON.stringify(opts.body) : undefined });
  return { server, base, manager: as(managerCookie), agent: as(agentCookie), underwriter: as(underwriterCookie) };
}

test('finance API: manager reads, saves and downloads; others are refused', async () => {
  const s = await serve();
  try {
    assert.equal((await s.manager('/finance/commission', { method: 'POST', body: { percent: 12 } })).status, 200);
    assert.equal((await s.manager('/finance/expenses', { method: 'POST', body: { month: '2026-03', category: 'Office rent', amount: 800 } })).status, 200);
    const report = await (await s.manager('/finance/report?from=2026-03&to=2026-03')).json();
    assert.equal(report.commissionRatePercent, 12);
    assert.equal(report.totals.expenses['Office rent'], 800);

    const xlsx = await s.manager('/reports/profitability.xlsx?from=2026-03&to=2026-03');
    assert.equal(xlsx.status, 200);
    assert.match(xlsx.headers.get('content-disposition'), /attachment; filename="settlement-2026-03-to-2026-03\.xlsx"/);
    assert.equal(Buffer.from(await xlsx.arrayBuffer()).slice(0, 2).toString(), 'PK');

    const pdf = await s.manager('/reports/profitability.pdf?from=2026-03&to=2026-03');
    assert.equal(pdf.headers.get('content-type'), 'application/pdf');
    assert.equal(Buffer.from(await pdf.arrayBuffer()).slice(0, 4).toString(), '%PDF');

    for (const call of [s.agent, s.underwriter]) {
      assert.equal((await call('/finance/report?from=2026-03&to=2026-03')).status, 403);
      assert.equal((await call('/reports/profitability.pdf?from=2026-03&to=2026-03')).status, 403);
      assert.equal((await call('/finance/expenses', { method: 'POST', body: { month: '2026-03', category: 'Salaries', amount: 5 } })).status, 403);
    }
  } finally {
    s.server.close();
  }
});

test('insights API: manager gets the dashboard; others are refused', async () => {
  const s = await serve();
  try {
    const ok = await s.manager('/insights?from=2026-03&to=2026-03');
    assert.equal(ok.status, 200);
    const d = await ok.json();
    assert.equal(d.months.length, 1);
    assert.ok(Array.isArray(d.matrix.rows));
    assert.equal((await s.agent('/insights?from=2026-03&to=2026-03')).status, 403);
    assert.equal((await s.underwriter('/insights?from=2026-03&to=2026-03')).status, 403);
  } finally {
    s.server.close();
  }
});
