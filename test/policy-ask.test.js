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
const { EventBus } = require('../src/eventBus');
const { TEST_PASSWORD } = require('./signin');

// A9: an agent asks about their own policy and gets a cited answer; another agent's policy is refused; and "not found" is said
// rather than guessed. The knowledge service is fake, so this tests the route, the access rule and the shape of the reply.

const FAKE_ANSWER = {
  ask: async () => ({ status: 'answered', answer: 'Jewellery is covered up to 2,500 dollars [1].', citations: [{ clause: 'HO-1.2', headingPath: 'S > HO-1.2', page: 2 }] }),
};
const FAKE_NOT_FOUND = { ask: async () => ({ status: 'not_found', answer: 'I could not find that in the documents.', citations: [] }) };

async function serve(knowledge) {
  const env = setup('2026-03-01');
  const auth = new Auth(env.pc);
  for (const name of ['agent', 'agent2']) {
    const staff = env.pc.db.staff.find((s) => s.username === name);
    if (staff) { staff.passwordHash = hashPassword(TEST_PASSWORD); staff.mustChangePassword = false; }
  }
  const api = createApi(env.pc, env.store, { backupDir: path.join(os.tmpdir(), 'pc-ask'), auth, bus: new EventBus(env.pc), knowledge });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    api(req, res, url.pathname, url.searchParams);
  });
  await new Promise((ok) => server.listen(0, ok));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const get = async (url, username) => {
    const res = await fetch(base + url, { headers: { Cookie: `pc_session=${auth.login(username, TEST_PASSWORD).token}` } });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const acct = env.run(() => account(env.pc, env.users.agent));
  const job = env.run(() => autoSubmission(env.pc, env.users.agent, acct, '2026-03-01'));
  env.run(() => env.pc.quote(job.id, env.users.agent));
  env.run(() => env.pc.bind(job.id, env.users.agent));
  const policy = env.pc.policy(job.policyId, env.users.agent);
  return { env, server, get, policy };
}

test('an agent asks about their own policy and gets citations', async () => {
  const { server, get, policy } = await serve(FAKE_ANSWER);
  try {
    const result = await get(`/policies/${policy.id}/ask?q=jewellery limit`, 'agent');
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.notFound, false);
    assert.match(result.body.answer, /2,500/);
    assert.equal(result.body.citations[0].clause, 'HO-1.2');
    assert.equal(result.body.policy.policyNumber, policy.policyNumber);
  } finally { server.close(); }
});

test('another agent cannot ask about that policy', async () => {
  const { server, get, policy } = await serve(FAKE_ANSWER);
  try {
    const result = await get(`/policies/${policy.id}/ask?q=jewellery limit`, 'agent2');
    assert.ok([403, 404].includes(result.status), 'refused with ' + result.status);
    assert.equal(result.body && result.body.answer, undefined, 'no answer leaks to a stranger');
  } finally { server.close(); }
});

test('a question the documents cannot answer says so', async () => {
  const { server, get, policy } = await serve(FAKE_NOT_FOUND);
  try {
    const result = await get(`/policies/${policy.id}/ask?q=flood premium`, 'agent');
    assert.equal(result.status, 200);
    assert.equal(result.body.notFound, true);
    assert.match(result.body.answer, /could not find/);
    assert.deepEqual(result.body.citations, []);
  } finally { server.close(); }
});
