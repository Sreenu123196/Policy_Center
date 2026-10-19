'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setup, account, autoSubmission, homeSubmission } = require('./helpers');
const { AuditLog } = require('../src/audit');
const { AgentService, AGENTS } = require('../src/agents');
const { Auth } = require('../src/auth');

// The agent layer (docs/AGENTS.md): agents read the books and write suggestions with reasons; a person accepts or dismisses.
// Nothing here lets an agent change a policy, send a message or cancel anything.

function world(today = '2026-03-01') {
  const env = setup(today);
  const audit = new AuditLog(env.pc);
  const agents = new AgentService(env.pc, { audit });
  return { ...env, audit, agents };
}

// A customer with a quoted submission made on its effective date; bound unless an underwriting issue (or { bind: false }) stops it.
// The clock goes back to 'today' afterwards.
const bound = (env, { eff = '2026-03-01', home = false, dwelling = {}, bind = true, today = '2026-03-01' } = {}) => {
  const { pc, users, run } = env;
  env.setToday(eff);
  const acct = run(() => account(pc, users.agent));
  const sub = run(() => (home ? homeSubmission(pc, users.agent, acct, eff, { dwelling }) : autoSubmission(pc, users.agent, acct, eff)));
  run(() => pc.quote(sub.id, users.agent));
  if (bind) run(() => pc.bind(sub.id, users.agent));
  env.setToday(today);
  return { acct, sub };
};
const turnOn = (env, id, mode = 'suggest') => env.run(() => env.agents.setMode(id, mode, env.users.uwm));

// ------------------------------------------------------------------ audit log

test('the audit log is permanent and chained: every entry holds the hash of the one before, so a change is found', () => {
  const { audit, run, pc, users } = world();
  run(() => audit.record({ actor: users.uwm, action: 'test.one', subject: 'POL1', reasons: ['because'] }));
  run(() => audit.record({ actor: users.uw, action: 'test.two', subject: 'POL2', reasons: [] }));
  const entries = pc.db.auditLog;
  assert.equal(entries.length, 2);
  assert.equal(entries[1].prevHash, entries[0].hash);
  assert.deepEqual(audit.verify(), { ok: true, entries: 2 });
  entries[0].reasons = ['something else'];
  const broken = audit.verify();
  assert.equal(broken.ok, false);
  assert.equal(broken.brokenAt, 1);
});

test('only a UW manager can read the audit log', () => {
  const { audit, users, run } = world();
  run(() => audit.record({ actor: users.uwm, action: 'x', subject: 's' }));
  assert.equal(audit.list(users.uwm).length, 1);
  for (const who of [users.agent, users.uw]) assert.throws(() => audit.list(who), (e) => e.status === 403);
});

// ------------------------------------------------------------------ the framework

test('every agent has its own staff account that cannot sign in, and starts switched off', () => {
  const env = world();
  const list = env.agents.list(env.users.uwm);
  const built = list.filter((a) => a.status === 'built');
  assert.deepEqual(built.map((a) => a.id).sort(), ['billing', 'compliance', 'keep-customers', 'renewal', 'underwriting']);
  for (const a of built) {
    assert.equal(a.mode, 'off', `${a.id} starts off`);
    const staff = env.pc.staffById(`ai-${a.id}`);
    assert.ok(staff, `${a.id} has an account`);
    assert.equal(staff.role, 'AI Agent');
    assert.equal(staff.passwordHash, undefined);
  }
  const planned = list.filter((a) => a.status === 'planned');
  assert.ok(planned.length >= 4);
  for (const a of planned) assert.ok(a.needs, `${a.id} says what it is waiting for`);
  const auth = new Auth(env.pc);
  assert.throws(() => auth.login('ai-renewal', ''), (e) => e.status === 401);
  assert.equal(env.pc.setupNeeded(), true, 'agent accounts do not count as a first manager');
});

test('the mode and the limits are data a UW manager changes, and every change is audited; there is no "act" mode yet', () => {
  const env = world();
  const { agents, users, run, pc } = env;
  assert.throws(() => run(() => agents.setMode('renewal', 'suggest', users.uw)), (e) => e.status === 403);
  assert.throws(() => run(() => agents.setMode('renewal', 'act', users.uwm)), (e) => e.status === 422 && /not available/i.test(e.message));
  assert.throws(() => run(() => agents.setMode('renewal', 'fast', users.uwm)), (e) => e.status === 422);
  assert.throws(() => run(() => agents.setMode('intake', 'suggest', users.uwm)), (e) => e.status === 422 && /planned/i.test(e.message));
  run(() => agents.setMode('renewal', 'suggest', users.uwm));
  assert.equal(agents.config('renewal').mode, 'suggest');
  run(() => agents.setLimits('underwriting', { maxPremium: 900 }, users.uwm));
  assert.equal(agents.config('underwriting').limits.maxPremium, 900);
  assert.throws(() => run(() => agents.setLimits('underwriting', { colour: 'red' }, users.uwm)), (e) => e.status === 422 && /colour/.test(e.message));
  assert.throws(() => run(() => agents.setLimits('underwriting', { maxPremium: -1 }, users.uwm)), (e) => e.status === 422);
  assert.throws(() => run(() => agents.setLimits('underwriting', { maxApprovalLevel: 2 }, users.uwm)), (e) => e.status === 422 && /level 1/i.test(e.message), 'an agent can never be allowed to approve what needs a manager');
  const actions = pc.db.auditLog.map((e) => e.action);
  assert.ok(actions.includes('agent.mode') && actions.includes('agent.limits'));
});

test('a switched-off agent does nothing (the kill switch)', () => {
  const env = world('2026-03-01');
  const { agents, users, run } = env;
  bound(env, { eff: '2025-11-01' });
  assert.equal(run(() => agents.run(users.uwm, { agentIds: ['renewal'] }))[0].skipped, 'off');
  assert.equal(agents.suggestions(users.uwm).length, 0);
  turnOn(env, 'renewal');
  assert.ok(run(() => agents.run(users.uwm, { agentIds: ['renewal'] }))[0].created >= 1);
  run(() => agents.setMode('renewal', 'off', users.uwm));
  assert.equal(run(() => agents.run(users.uwm, { agentIds: ['renewal'] }))[0].skipped, 'off');
});

// ------------------------------------------------------------------ renewal agent

test('the renewal agent suggests starting a renewal when the term ends within its window, once, with its reasons', () => {
  const env = world('2026-03-01');
  const { agents, users, run, pc } = env;
  const near = bound(env, { eff: '2025-11-01' }); // ends 2026-05-01: 61 days away
  bound(env, { eff: '2026-02-01' }); // ends 2027-02-01
  turnOn(env, 'renewal');
  const first = run(() => agents.run(users.uwm, { agentIds: ['renewal'] }));
  assert.equal(first[0].created, 1);
  const [s] = agents.suggestions(users.uwm);
  assert.equal(s.agentId, 'renewal');
  assert.equal(s.proposed.action, 'start_renewal');
  assert.equal(s.subject.policyId, near.sub.policyId);
  assert.ok(s.reasons.some((r) => /61 days/.test(r)), s.reasons.join('|'));
  assert.match(s.number, /^SUG-\d{7}$/);
  assert.equal(run(() => agents.run(users.uwm, { agentIds: ['renewal'] }))[0].created, 0, 'the same case is not suggested twice');
  assert.equal(pc.db.jobs.filter((j) => j.type === 'Renewal').length, 0, 'suggesting changes nothing');
});

test('a person accepts a suggestion and the action runs as that person; a dismissal is remembered', () => {
  const env = world('2026-03-01');
  const { agents, users, run, pc } = env;
  bound(env, { eff: '2025-11-01' });
  turnOn(env, 'renewal');
  run(() => agents.run(users.uwm, { agentIds: ['renewal'] }));
  const [s] = agents.suggestions(users.uwm);
  assert.throws(() => run(() => agents.decide(s.id, { decision: 'accept' }, users.agent)), (e) => e.status === 403);
  assert.throws(() => run(() => agents.decide(s.id, { decision: 'maybe' }, users.uw)), (e) => e.status === 422);
  const done = run(() => agents.decide(s.id, { decision: 'accept', note: 'looks right' }, users.uw));
  assert.equal(done.status, 'Accepted');
  assert.equal(done.decidedBy, 'uw');
  const renewal = pc.db.jobs.find((j) => j.type === 'Renewal');
  assert.ok(renewal, 'the renewal was started');
  assert.equal(renewal.history[0].by, 'uw', 'by the person, not by the agent');
  assert.throws(() => run(() => agents.decide(s.id, { decision: 'dismiss' }, users.uw)), (e) => e.status === 409, 'decided once');
  const entry = pc.db.auditLog.find((e) => e.action === 'suggestion.accepted');
  assert.equal(entry.actor.id, 'uw');
  assert.deepEqual(entry.reasons.slice(0, 1), [s.reasons[0]]);
});

test('a dismissed suggestion does not come back for the same case', () => {
  const env = world('2026-03-01');
  const { agents, users, run } = env;
  bound(env, { eff: '2025-11-01' });
  turnOn(env, 'renewal');
  run(() => agents.run(users.uwm, { agentIds: ['renewal'] }));
  const [s] = agents.suggestions(users.uwm);
  run(() => agents.decide(s.id, { decision: 'dismiss', note: 'customer is leaving' }, users.uwm));
  assert.equal(run(() => agents.run(users.uwm, { agentIds: ['renewal'] }))[0].created, 0);
  assert.equal(agents.suggestions(users.uwm, { status: 'Open' }).length, 0);
});

test('an event wakes only the agent that cares, and only for the policy in it', () => {
  const env = world('2026-03-01');
  const { agents, users, run, pc } = env;
  const a = bound(env, { eff: '2025-11-01' });
  bound(env, { eff: '2025-10-20' });
  turnOn(env, 'renewal');
  const policyNumber = pc.db.policies.find((p) => p.id === a.sub.policyId).policyNumber;
  const result = run(() => agents.onEvent({ type: 'PolicyIssued', payload: { policyNumber } }));
  assert.deepEqual(result.map((r) => [r.agentId, r.created]), [['renewal', 1]]);
  assert.equal(agents.suggestions(users.uwm).length, 1, 'the other policy waits for the daily sweep');
});

// ------------------------------------------------------------------ keep-customers agent

test('the keep-customers agent suggests a message to a lapsed customer, unless somebody was in touch recently', () => {
  const env = world('2026-03-01');
  const { agents, users, run, pc } = env;
  bound(env, { eff: '2025-08-01' }); // ended 2026-02-01: lapsed 28 days ago
  turnOn(env, 'keep-customers');
  run(() => agents.run(users.uwm, { agentIds: ['keep-customers'] }));
  const [s] = agents.suggestions(users.uwm);
  assert.equal(s.proposed.action, 'send_message');
  assert.equal(s.proposed.params.template, 'lapse');
  assert.equal(s.proposed.params.channel, 'email');
  assert.ok(s.reasons.some((r) => /lapsed/i.test(r)));
  run(() => agents.decide(s.id, { decision: 'dismiss' }, users.uwm));

  // Recent contact: nothing to suggest.
  const env2 = world('2026-03-01');
  const b2 = bound(env2, { eff: '2025-08-01' });
  env2.run(() => env2.pc.logFollowUp(b2.sub.policyId, { channel: 'Phone', result: 'No answer', date: '2026-02-27' }, env2.users.uwm));
  turnOn(env2, 'keep-customers');
  assert.equal(env2.run(() => env2.agents.run(env2.users.uwm, { agentIds: ['keep-customers'] }))[0].created, 0);
  assert.ok(pc);
});

// ------------------------------------------------------------------ billing agent

test('the billing agent suggests a reminder for a late invoice, and sends a long-overdue one to a person: it never cancels', () => {
  const env = world('2026-03-01');
  const { agents, users, run, pc } = env;
  const { sub } = bound(env, { eff: '2026-03-01' });
  turnOn(env, 'billing');
  const due = pc.db.invoices.filter((i) => i.policyId === sub.policyId && i.amount > 0).sort((x, y) => x.dueDate.localeCompare(y.dueDate))[0];
  env.setToday(require('../src/dates').addDays(due.dueDate, 7));
  run(() => agents.run(users.uwm, { agentIds: ['billing'] }));
  let open = agents.suggestions(users.uwm, { status: 'Open' });
  assert.equal(open.length, 1);
  assert.equal(open[0].kind, 'reminder');
  assert.equal(open[0].proposed.action, 'contact_customer', 'there is no payment-reminder message template, so a person makes the contact');
  env.setToday(require('../src/dates').addDays(due.dueDate, 20));
  run(() => agents.run(users.uwm, { agentIds: ['billing'] }));
  open = agents.suggestions(users.uwm, { status: 'Open' });
  const escalation = open.find((s) => s.kind === 'escalate');
  assert.ok(escalation, 'a person is asked to look');
  assert.equal(escalation.proposed, null);
  assert.match(escalation.summary, /cancellation/i);
  assert.equal(pc.db.jobs.filter((j) => j.type === 'Cancellation').length, 0, 'nothing was cancelled');
});

// ------------------------------------------------------------------ underwriting agent

test('the underwriting agent recommends approving a small issue within its limits, and refers the rest to a person with reasons', () => {
  const env = world('2026-03-01');
  const { agents, users, run, pc } = env;
  const small = bound(env, { home: true, bind: false, dwelling: { yearBuilt: 1995, roofAge: 22 } }); // level 1
  const big = bound(env, { home: true, bind: false, dwelling: { yearBuilt: 1990, roofAge: 30 } }); // level 2
  turnOn(env, 'underwriting');
  run(() => agents.run(users.uwm, { agentIds: ['underwriting'] }));
  const all = agents.suggestions(users.uwm);
  const forSmall = all.find((s) => s.subject.jobId === small.sub.id);
  const forBig = all.find((s) => s.subject.jobId === big.sub.id);
  assert.equal(forSmall.kind, 'recommend_approval');
  assert.equal(forSmall.proposed.action, 'approve_uw_issue');
  assert.deepEqual(forSmall.proposed.params.keys, ['HO_ROOF_AGE']);
  assert.ok(forSmall.reasons.some((r) => /Roof/.test(r)));
  assert.equal(forBig.kind, 'refer');
  assert.equal(forBig.proposed, null);
  assert.ok(forBig.reasons.some((r) => /manager/i.test(r)));

  // Accepting runs under the person's own authority.
  run(() => agents.decide(forSmall.id, { decision: 'accept' }, users.uw));
  const job = pc.db.jobs.find((j) => j.id === small.sub.id);
  assert.equal(job.uwApprovals.HO_ROOF_AGE.by, 'uw');
  assert.throws(() => run(() => agents.decide(forBig.id, { decision: 'accept' }, users.uw)), (e) => e.status === 422 && /no action/i.test(e.message), 'a referral is dismissed or handled, not executed');
});

test('tightening a limit changes what the underwriting agent recommends, with no code change', () => {
  const env = world('2026-03-01');
  const { agents, users, run } = env;
  const { sub } = bound(env, { home: true, bind: false, dwelling: { yearBuilt: 1995, roofAge: 22 } });
  turnOn(env, 'underwriting');
  run(() => agents.setLimits('underwriting', { maxPremium: 1 }, users.uwm));
  run(() => agents.run(users.uwm, { agentIds: ['underwriting'] }));
  const [s] = agents.suggestions(users.uwm);
  assert.equal(s.subject.jobId, sub.id);
  assert.equal(s.kind, 'refer');
  assert.ok(s.reasons.some((r) => /premium/i.test(r) && /limit/i.test(r)), s.reasons.join('|'));
});

test('an agent is tested on past cases before it is trusted: the backtest compares it with what people decided', () => {
  const env = world('2026-03-01');
  const { agents, users, run, pc } = env;
  const { sub } = bound(env, { home: true, bind: false, dwelling: { yearBuilt: 1995, roofAge: 22 } });
  run(() => pc.approveIssue(sub.id, 'HO_ROOF_AGE', 'fine', users.uw)); // a person approved it
  const wrong = bound(env, { home: true, bind: false, dwelling: { yearBuilt: 1990, roofAge: 30 } });
  run(() => pc.approveIssue(wrong.sub.id, 'HO_ROOF_AGE', 'ok', users.uwm)); // a manager approved a big one
  const report = agents.backtest('underwriting', users.uwm);
  assert.equal(report.cases, 2);
  assert.equal(report.agree, 2, 'it would have approved the small one and referred the big one, as people did');
  assert.equal(report.agreementRate, 1);
  assert.throws(() => agents.backtest('renewal', users.uwm), (e) => e.status === 422);
  assert.throws(() => agents.backtest('underwriting', users.uw), (e) => e.status === 403);
});

// ------------------------------------------------------------------ compliance agent

test('the compliance agent reports (and only reports): a protected trait in a reason, or a broken audit chain', () => {
  const env = world('2026-03-01');
  const { agents, users, run, pc, audit } = env;
  turnOn(env, 'compliance');
  run(() => audit.record({ actor: users.uwm, action: 'x', subject: 's' }));
  run(() => audit.record({ actor: users.uwm, action: 'y', subject: 's' }));
  // A suggestion whose reason names a protected trait.
  pc.db.agentSuggestions.push({ id: 'sug-bad', number: 'SUG-9999999', agentId: 'underwriting', kind: 'refer', status: 'Open', summary: 'x', reasons: ['Refer: the applicant is of a certain religion'], proposed: null, subject: {}, createdAt: pc.now(), dedupeKey: 'bad' });
  pc.db.auditLog[0].reasons = ['tampered'];
  const before = JSON.stringify(pc.db.jobs) + JSON.stringify(pc.db.policies);
  run(() => agents.run(users.uwm, { agentIds: ['compliance'] }));
  const findings = agents.suggestions(users.uwm).filter((s) => s.agentId === 'compliance');
  assert.ok(findings.some((f) => f.kind === 'finding' && /protected/i.test(f.summary)));
  assert.ok(findings.some((f) => f.kind === 'finding' && /audit/i.test(f.summary)));
  assert.ok(findings.every((f) => f.proposed === null), 'it reports only');
  assert.equal(JSON.stringify(pc.db.jobs) + JSON.stringify(pc.db.policies), before);
});

test('the agents act on suggestions, never on policies: a full sweep with everything on changes no job, policy, invoice or message', () => {
  const env = world('2026-03-01');
  const { agents, users, run, pc } = env;
  bound(env, { eff: '2025-11-01' });
  const h = bound(env, { home: true, bind: false, dwelling: { yearBuilt: 1995, roofAge: 22 } });
  for (const id of Object.keys(AGENTS)) if (AGENTS[id].status === 'built') turnOn(env, id);
  const snap = () => JSON.stringify([pc.db.jobs, pc.db.policies, pc.db.invoices, pc.db.messages, pc.db.payments]);
  const before = snap();
  const results = run(() => agents.run(users.uwm, {}));
  assert.ok(results.reduce((n, r) => n + (r.created || 0), 0) >= 2);
  assert.equal(snap(), before);
  assert.ok(h);
});
