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

// The two flags tested through HTTP, because that is how they are used: SSO_ENFORCE_MFA and ESIGN_REQUIRED.

async function serve() {
  const env = setup('2026-03-01');
  const auth = new Auth(env.pc);
  const manager = env.pc.staffById('uwm');
  manager.passwordHash = hashPassword(TEST_PASSWORD);
  manager.mustChangePassword = false;
  const api = createApi(env.pc, env.store, {
    backupDir: path.join(os.tmpdir(), 'pc-flags-backups'),
    auth,
    bus: new EventBus(env.pc),
  });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    api(req, res, url.pathname, url.searchParams);
  });
  await new Promise((ok) => server.listen(0, ok));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (method, url, body, cookie) => {
    const res = await fetch(base + url, {
      method,
      headers: { ...(cookie ? { Cookie: cookie } : {}), 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const bytes = Buffer.from(await res.arrayBuffer());
    const isJson = /application\/json/.test(res.headers.get('content-type') || '');
    return { status: res.status, body: isJson && bytes.length ? JSON.parse(bytes.toString()) : bytes, setCookie: res.headers.get('set-cookie') };
  };
  const managerCookie = `pc_session=${auth.login('uwm', TEST_PASSWORD).token}`;
  return { env, server, call, managerCookie };
}

test('with SSO_ENFORCE_MFA=1 the cookie is withheld until the challenge is satisfied', async () => {
  process.env.SSO_ENFORCE_MFA = '1';
  const { server, call } = await serve();
  try {
    const login = await call('POST', '/auth/login', { username: 'uwm', password: TEST_PASSWORD });
    assert.equal(login.status, 200);
    assert.equal(login.body.mfaRequired, true, 'the sign-in asks for a second factor');
    assert.equal(login.setCookie, null, 'no cookie is issued yet');
    assert.ok(login.body.sessionId, 'a session id comes back');

    const mfa = await call('POST', '/auth/sso/mfa', { sessionId: login.body.sessionId, code: login.body.simulatedCode });
    assert.equal(mfa.status, 200);
    assert.match(String(mfa.setCookie), /pc_session=/, 'the cookie is issued once the challenge is satisfied');

    const withCookie = await call('GET', '/policies', undefined, String(mfa.setCookie).split(';')[0]);
    assert.equal(withCookie.status, 200, 'the issued cookie works');

    const replay = await call('POST', '/auth/sso/mfa', { sessionId: login.body.sessionId, code: login.body.simulatedCode });
    assert.notEqual(replay.status, 200, 'the same challenge cannot be used twice');
  } finally {
    delete process.env.SSO_ENFORCE_MFA;
    server.close();
  }
});

test('with ESIGN_REQUIRED=1 a bind is refused until the schedule is signed', async () => {
  const { env, server, call, managerCookie } = await serve();
  process.env.ESIGN_REQUIRED = '1';
  try {
    const acct = env.run(() => account(env.pc, env.users.agent));
    const job = env.run(() => autoSubmission(env.pc, env.users.agent, acct, '2026-03-01'));
    env.run(() => env.pc.quote(job.id, env.users.agent));
    const quoted = env.pc.job(job.id, env.users.agent);

    const refused = await call('POST', `/jobs/${job.id}/bind`, {}, managerCookie);
    assert.equal(refused.status, 403, 'an unsigned schedule cannot bind: ' + JSON.stringify(refused.body));

    const document = quoted.jobNumber + '|' + quoted.quote.premium;
    const signed = await call('POST', '/esign/signatures', { document, documentRef: quoted.jobNumber }, managerCookie);
    assert.equal(signed.status, 200, JSON.stringify(signed.body));

    const bound = await call('POST', `/jobs/${job.id}/bind`, {}, managerCookie);
    assert.equal(bound.status, 200, 'a signed schedule binds: ' + JSON.stringify(bound.body));
  } finally {
    delete process.env.ESIGN_REQUIRED;
    server.close();
  }
});
