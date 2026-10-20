'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { setup, account } = require('./helpers');
const { AuditLog } = require('../src/audit');
const { AgentService } = require('../src/agents');
const { Auth } = require('../src/auth');
const { hashPassword } = require('../src/passwords');
const { createApi } = require('../src/api');
const { TEST_PASSWORD } = require('./signin');

// An agent suggestion has to reach the person whose job it is. The internal agents (renewal, underwriting) are underwriting
// work; the customer-facing ones (keep-customers, billing) belong to the producer who owns the account, and to staff who
// see the whole book. Nobody sees another producer's customers, and the read-only executive sees none.
// GET /suggestions/mine is the door the Desktop and Work queues use; it is open to every signed-in person and returns
// only what is addressed to them. GET /agents/suggestions (the whole queue) stays underwriting and managers only.

async function world() {
  const env = setup('2026-03-01');
  const audit = new AuditLog(env.pc);
  const agents = new AgentService(env.pc, { audit });
  const auth = new Auth(env.pc);
  for (const username of ['uwm', 'uw', 'agent', 'agent2', 'venkatesh']) {
    const staff = env.pc.staffById(username);
    if (!staff) continue;
    staff.passwordHash = hashPassword(TEST_PASSWORD);
    staff.mustChangePassword = false;
  }
  const mine = env.run(() => account(env.pc, env.users.agent));
  const other = env.run(() => account(env.pc, env.pc.user('agent2')));
  const add = (id, agentId, audience) => {
    env.pc.db.agentSuggestions.push({ id, number: id.toUpperCase(), agentId, status: 'Open', kind: 'finding', summary: `Suggestion ${id}`, reasons: ['because'], subject: {}, audience, dedupeKey: id, createdAt: '2026-03-01' });
  };
  add('s-renewal', 'renewal', agents.audienceFor('renewal', { subject: { accountId: mine.id } }));
  add('s-keep-mine', 'keep-customers', agents.audienceFor('keep-customers', { subject: { accountId: mine.id } }));
  add('s-keep-other', 'keep-customers', agents.audienceFor('keep-customers', { subject: { accountId: other.id } }));
  add('s-compliance', 'compliance', agents.audienceFor('compliance', {}));
  const api = createApi(env.pc, env.store, { auth, agents });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    api(req, res, url.pathname, url.searchParams);
  });
  await new Promise((ok) => server.listen(0, ok));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const cookies = Object.fromEntries(['uwm', 'uw', 'agent', 'agent2', 'venkatesh'].map((name) => [name, `pc_session=${auth.login(name, TEST_PASSWORD).token}`]));
  const get = async (path, who) => {
    const res = await fetch(base + path, { headers: { Cookie: cookies[who] } });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return { ...env, agents, server, cookies, get, mine, other };
}

test('a suggestion says who it is for', () => {
  const env = setup('2026-03-01');
  const agents = new AgentService(env.pc, { audit: new AuditLog(env.pc) });
  const acct = env.run(() => account(env.pc, env.users.agent, { producerCode: 'PC-100' }));

  const renewal = agents.audienceFor('renewal', { subject: { accountId: acct.id } });
  assert.deepEqual(renewal.roles, ['Underwriter', 'UW Manager']);
  assert.equal(renewal.producerCode, null, 'internal work is not tied to a producer');

  const keep = agents.audienceFor('keep-customers', { subject: { accountId: acct.id } });
  assert.ok(keep.roles.includes('Agent'), 'the producing agent is told');
  assert.equal(keep.producerCode, 'PC-100', 'and only the agent who owns the account');

  const compliance = agents.audienceFor('compliance', { subject: {} });
  assert.deepEqual(compliance.roles, ['UW Manager']);
  assert.equal(compliance.producerCode, null);
});

test('each person sees only the open suggestions addressed to them', async () => {
  const w = await world();
  try {
    const ids = (who) => w.agents.suggestionsFor(w.pc.user(who)).items.map((s) => s.id).sort();
    assert.deepEqual(ids('uw'), ['s-keep-mine', 's-keep-other', 's-renewal'], 'underwriting work and every customer');
    assert.deepEqual(ids('agent'), ['s-keep-mine'], 'only their own customers');
    assert.deepEqual(ids('agent2'), ['s-keep-other'], 'only their own customers');
    assert.deepEqual(ids('uwm'), ['s-compliance', 's-keep-mine', 's-keep-other', 's-renewal']);
    assert.deepEqual(ids('venkatesh'), [], 'the read-only executive sees none');

    const forAgent = w.agents.suggestionsFor(w.pc.user('agent'));
    assert.equal(forAgent.count, 1);
    assert.equal(forAgent.byAgent[0].agentId, 'keep-customers');
    assert.equal(forAgent.byAgent[0].name, 'Keep-customers agent');
  } finally {
    w.server.close();
  }
});

test('the screens can ask for "mine" and get only theirs', async () => {
  const w = await world();
  try {
    const uwm = await w.get('/suggestions/mine', 'uwm');
    assert.equal(uwm.status, 200);
    assert.equal(uwm.body.count, 4);
    assert.deepEqual(uwm.body.items.map((s) => s.id).sort(), ['s-compliance', 's-keep-mine', 's-keep-other', 's-renewal']);

    const agent = await w.get('/suggestions/mine', 'agent');
    assert.equal(agent.status, 200);
    assert.deepEqual(agent.body.items.map((s) => s.id), ['s-keep-mine']);
    assert.equal(agent.body.items[0].agent, 'Keep-customers agent', 'the screen is told which agent it came from');

    const exec = await w.get('/suggestions/mine', 'venkatesh');
    assert.equal(exec.status, 200);
    assert.equal(exec.body.count, 0);

    // The whole queue is still a different door, and an agent may not open it.
    assert.equal((await w.get('/agents/suggestions', 'agent')).status, 403);
    assert.equal((await w.get('/agents/suggestions', 'uw')).status, 200);
  } finally {
    w.server.close();
  }
});
