'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setup, account, autoSubmission } = require('./helpers');
const { Finance, monthsBetween } = require('../src/finance');

function boundPolicy(env) {
  const { pc, users, run } = env;
  const acct = run(() => account(pc, users.agent));
  const job = run(() => autoSubmission(pc, users.agent, acct, '2026-03-01'));
  run(() => pc.quote(job.id, users.agent));
  run(() => pc.bind(job.id, users.agent));
  return acct;
}

test('finance: premium by month plus commission, less expenses, gives net profit', () => {
  const env = setup();
  boundPolicy(env);
  const fin = new Finance(env.pc);
  const mgr = env.users.uwm;
  env.run(() => fin.setCommissionRate(mgr, 10));
  const march = fin.report(mgr, { from: '2026-03', to: '2026-03' }).months[0];
  assert.ok(march.premium > 0, 'billed premium in March');
  assert.equal(march.commission, Math.round(march.premium * 0.1 * 100) / 100);
  assert.equal(march.income, Math.round((march.premium + march.commission) * 100) / 100);

  env.run(() => fin.addExpense(mgr, { month: '2026-03', category: 'Salaries', amount: 1000, note: 'March payroll' }));
  env.run(() => fin.addExpense(mgr, { month: '2026-03', category: 'Office rent', amount: 500 }));
  const after = fin.report(mgr, { from: '2026-03', to: '2026-03' });
  assert.equal(after.months[0].totalExpenses, 1500);
  assert.equal(after.months[0].net, Math.round((march.income - 1500) * 100) / 100);
  assert.equal(after.totals.expenses['Salaries'], 1000);
});

test('finance: default range is the last 12 months, and the trend has one row per month', () => {
  const env = setup('2026-10-17');
  const fin = new Finance(env.pc);
  const r = fin.report(env.users.uwm);
  assert.equal(r.from, '2025-11');
  assert.equal(r.to, '2026-10');
  assert.equal(r.months.length, 12);
});

test('finance: only UW managers see or change finance; agents and underwriters are refused', () => {
  const env = setup();
  const fin = new Finance(env.pc);
  for (const u of [env.users.agent, env.users.uw]) {
    assert.throws(() => fin.report(u, { from: '2026-03', to: '2026-03' }), (e) => e.status === 403);
    assert.throws(() => fin.addExpense(u, { month: '2026-03', category: 'Salaries', amount: 10 }), (e) => e.status === 403);
    assert.throws(() => fin.setCommissionRate(u, 10), (e) => e.status === 403);
  }
});

test('finance: bad input is refused with a clear message', () => {
  const env = setup();
  const fin = new Finance(env.pc);
  const m = env.users.uwm;
  assert.throws(() => fin.addExpense(m, { month: '2026-13', category: 'Salaries', amount: 10 }), /Month must/);
  assert.throws(() => fin.addExpense(m, { month: '2026-03', category: 'Bonus', amount: 10 }), /Category must/);
  assert.throws(() => fin.addExpense(m, { month: '2026-03', category: 'Salaries', amount: 0 }), /more than zero/);
  assert.throws(() => fin.setCommissionRate(m, 150), /between 0 and 100/);
  assert.throws(() => fin.report(m, { from: '2026-05', to: '2026-03' }), /after the last month/);
  assert.throws(() => fin.report(m, { from: '2020-01', to: '2026-03' }), /at most 36 months/);
  assert.equal(monthsBetween('2026-11', '2027-02').join(','), '2026-11,2026-12,2027-01,2027-02');
});

test('finance: Excel and PDF downloads are real files', async () => {
  const env = setup();
  boundPolicy(env);
  const fin = new Finance(env.pc);
  const range = { from: '2026-03', to: '2026-04' };
  const xlsx = await fin.excel(env.users.uwm, range);
  assert.equal(xlsx.slice(0, 2).toString(), 'PK');
  const pdf = await fin.pdf(env.users.uwm, range);
  assert.equal(pdf.slice(0, 4).toString(), '%PDF');
});
