'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setup, account, autoSubmission } = require('./helpers');
const { Finance } = require('../src/finance');
const { Insights, groupSales } = require('../src/insights');

function bindAuto(env, eff = '2026-03-01') {
  const { pc, users, run } = env;
  pc.clockMs = Date.parse('2026-03-05T12:00:00Z'); // sales count the bind date, so bind inside March
  const acct = run(() => account(pc, users.agent));
  const job = run(() => autoSubmission(pc, users.agent, acct, eff));
  run(() => pc.quote(job.id, users.agent));
  run(() => pc.bind(job.id, users.agent));
}

test('insights: policies sold and profit by month, product, salesperson and producer', () => {
  const env = setup();
  bindAuto(env);
  bindAuto(env);
  const fin = new Finance(env.pc);
  const ins = new Insights(env.pc, fin);
  const mgr = env.users.uwm;
  env.run(() => fin.addExpense(mgr, { month: '2026-03', category: 'Salaries', amount: 100 }));

  const d = ins.dashboard(mgr, { from: '2026-03', to: '2026-04' });
  assert.equal(d.months.length, 2);
  const march = d.months[0];
  assert.equal(march.month, '2026-03');
  assert.equal(march.policiesSold, 2);
  assert.ok(march.premiumSold > 0);
  assert.equal(march.expenses, 100);
  assert.equal(march.profit, Math.round((march.income - 100) * 100) / 100);
  assert.equal(d.months[1].policiesSold, 0);
  assert.equal(d.totals.policiesSold, 2);
  assert.equal(d.byProduct[0].product, 'PersonalAuto');
  assert.equal(d.bySalesperson[0].policies, 2);
  assert.equal(d.byProducer[0].policies, 2);
  assert.deepEqual(d.matrix.rows[0].counts, [2, 0]);
  assert.equal(d.matrix.rows[0].total, 2);
});

test('insights: dashboard is for UW managers only', () => {
  const env = setup();
  const ins = new Insights(env.pc, new Finance(env.pc));
  assert.throws(() => ins.dashboard(env.users.agent, { from: '2026-03', to: '2026-03' }), (e) => e.status === 403);
  assert.throws(() => ins.dashboard(env.users.uw, { from: '2026-03', to: '2026-03' }), (e) => e.status === 403);
});

test('insights: groupSales sorts by premium and counts policies', () => {
  const rows = [{ product: 'A', premium: 10 }, { product: 'B', premium: 50 }, { product: 'B', premium: 5 }];
  assert.deepEqual(groupSales(rows, (r) => r.product, 'product'), [
    { product: 'B', policies: 2, premium: 55 },
    { product: 'A', policies: 1, premium: 10 },
  ]);
});
