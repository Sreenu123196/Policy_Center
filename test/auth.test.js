'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Store } = require('../src/store');
const { PolicyCenter } = require('../src/policyCenter');
const { seed } = require('../src/seed');
const { Auth } = require('../src/auth');
const { createApi } = require('../src/api');
const { hashPassword, verifyPassword, temporaryPassword } = require('../src/passwords');

function app() {
  const store = new Store();
  const pc = new PolicyCenter(store);
  store.transaction(() => seed(pc));
  return { store, pc, auth: new Auth(pc) };
}

// Sudhakar (UW Manager) signs in for the first time with the one-time password the server prints.
function firstSignIn() {
  const env = app();
  const first = env.pc.bootstrapManager();
  const login = env.auth.login('sudhakar', first.temporaryPassword);
  return { ...env, first, login };
}

// Starts the API on a free port for one test.
async function withApi(pc, store, auth, fn) {
  const api = createApi(pc, store, { auth });
  const server = http.createServer((req, res) => { const u = new URL(req.url, 'http://x'); api(req, res, u.pathname, u.searchParams); });
  await new Promise((ok) => server.listen(0, ok));
  try {
    await fn(`http://localhost:${server.address().port}/api`);
  } finally {
    server.close();
  }
}

test('passwords: stored as salted hashes that verify only with the right password', () => {
  const h = hashPassword('a-good-password');
  assert.ok(h.startsWith('scrypt$'));
  assert.equal(h.includes('a-good-password'), false);
  assert.equal(verifyPassword('a-good-password', h), true);
  assert.equal(verifyPassword('a-good-passwore', h), false);
  assert.equal(verifyPassword('x', null), false);
  assert.notEqual(hashPassword('same'), hashPassword('same'), 'salts differ');
  const t = temporaryPassword();
  assert.equal(t.length, 12);
  assert.doesNotMatch(t, /[0O1lI]/, 'no easily confused characters');
});

test('sign-in: the manager gets a first password, must change it, then can sign in normally', () => {
  const { pc, auth, first, login } = firstSignIn();
  assert.equal(first.username, 'sudhakar');
  assert.equal(login.mustChangePassword, true);
  assert.equal(login.user.role, 'UW Manager');
  assert.equal(login.user.passwordHash, undefined, 'the hash never leaves the server');
  const sudhakar = auth.userFor(login.token);
  assert.equal(sudhakar.id, 'sudhakar');
  pc.changeOwnPassword(sudhakar, { current: first.temporaryPassword, next: 'my-own-password' });
  assert.equal(sudhakar.mustChangePassword, false);
  assert.equal(auth.login('sudhakar', 'my-own-password').mustChangePassword, false);
});

test('sign-in: wrong passwords are refused, and too many lock the account for a while', () => {
  const { pc, auth } = app();
  pc.bootstrapManager();
  for (let i = 0; i < 4; i++) assert.throws(() => auth.login('sudhakar', 'wrong'), /Wrong username or password/);
  assert.throws(() => auth.login('sudhakar', 'wrong'), /Wrong username or password/, 'the fifth wrong try');
  assert.throws(() => auth.login('sudhakar', 'anything'), /Too many wrong passwords/);
});

test('sign-in: a session expires after eight hours', () => {
  const { pc, auth, login } = firstSignIn();
  assert.ok(auth.userFor(login.token));
  pc.clockMs = Date.now() + 9 * 3600 * 1000;
  assert.equal(auth.userFor(login.token), null);
  pc.clockMs = null;
});

test('staff: only the UW Manager creates accounts; agents need a producer code', () => {
  const { pc, first } = firstSignIn();
  const sudhakar = pc.user('sudhakar');
  const made = pc.createStaff({ username: 'ravi.k', name: 'Venkatesh', role: 'Insurance Executive' }, sudhakar);
  assert.match(made.temporaryPassword, /^[A-Za-z0-9]{12}$/);
  assert.equal(pc.staffById('ravi.k').mustChangePassword, true);
  assert.equal(pc.staffById('ravi.k').reportsTo, 'sudhakar');
  assert.throws(() => pc.createStaff({ username: 'ravi.two', name: 'Naagarjuna', role: 'Insurance Executive' }, pc.user('uw')), /Only the UW Manager/);
  assert.throws(() => pc.createStaff({ username: 'ravi.k', name: 'Again', role: 'Insurance Executive' }, sudhakar), /already taken/);
  assert.throws(() => pc.createStaff({ username: 'Bad Name!', name: 'X Y', role: 'Agent', producerCode: 'PC-100' }, sudhakar), /Username/);
  assert.throws(() => pc.createStaff({ username: 'newagent', name: 'New Agent', role: 'Agent' }, sudhakar), /producer code/);
  assert.throws(() => pc.createStaff({ username: 'newagent', name: 'New Agent', role: 'Director' }, sudhakar), /Role must be/);
  pc.createStaff({ username: 'newagent', name: 'New Agent', role: 'Agent', producerCode: 'PC-200' }, sudhakar);
  assert.equal(pc.staffById('newagent').producerCode, 'PC-200');
  assert.ok(first);
});

test('staff: the new person signs in with the temporary password and must change it', () => {
  const { pc, auth } = firstSignIn();
  const made = pc.createStaff({ username: 'ravi.k', name: 'Venkatesh', role: 'Insurance Executive' }, pc.user('sudhakar'));
  const v = auth.login('ravi.k', made.temporaryPassword);
  assert.equal(v.mustChangePassword, true);
  assert.equal(v.user.role, 'Insurance Executive');
  pc.changeOwnPassword(auth.userFor(v.token), { current: made.temporaryPassword, next: 'venkatesh-own-1' });
  assert.equal(auth.login('ravi.k', 'venkatesh-own-1').user.name, 'Venkatesh');
  assert.throws(() => auth.login('ravi.k', made.temporaryPassword), /Wrong username/);
});

test('staff: a password reset replaces the old password, ends sessions, and forces a change', () => {
  const { pc, auth } = firstSignIn();
  const made = pc.createStaff({ username: 'ravi.k', name: 'Venkatesh', role: 'Insurance Executive' }, pc.user('sudhakar'));
  const old = auth.login('ravi.k', made.temporaryPassword);
  pc.changeOwnPassword(auth.userFor(old.token), { current: made.temporaryPassword, next: 'venkatesh-own-1' });
  const reset = pc.resetStaffPassword('ravi.k', pc.user('sudhakar'));
  auth.endSessionsFor('ravi.k');
  assert.equal(auth.userFor(old.token), null, 'the old session is ended');
  assert.throws(() => auth.login('ravi.k', 'venkatesh-own-1'), /Wrong username/);
  assert.equal(auth.login('ravi.k', reset.temporaryPassword).mustChangePassword, true);
});

test('staff: turning an account off stops sign-in and ends its sessions; no one turns off their own', () => {
  const { pc, auth } = firstSignIn();
  const made = pc.createStaff({ username: 'ravi.k', name: 'Venkatesh', role: 'Insurance Executive' }, pc.user('sudhakar'));
  const v = auth.login('ravi.k', made.temporaryPassword);
  pc.setStaffActive('ravi.k', false, pc.user('sudhakar'));
  auth.endSessionsFor('ravi.k');
  assert.equal(auth.userFor(v.token), null);
  assert.throws(() => auth.login('ravi.k', made.temporaryPassword), /Wrong username/);
  assert.throws(() => pc.setStaffActive('sudhakar', false, pc.user('sudhakar')), /your own account/);
});

test('staff: a changed password must be right, new, and at least 8 characters', () => {
  const { pc, first } = firstSignIn();
  const sudhakar = pc.user('sudhakar');
  assert.throws(() => pc.changeOwnPassword(sudhakar, { current: 'wrong', next: 'longenough' }), /current password is wrong/);
  assert.throws(() => pc.changeOwnPassword(sudhakar, { current: first.temporaryPassword, next: 'short' }), /at least 8/);
  assert.throws(() => pc.changeOwnPassword(sudhakar, { current: first.temporaryPassword, next: first.temporaryPassword }), /not the same/);
});

test('API: every call needs a session, and a header someone sends is not a sign-in', async () => {
  const { pc, store, auth } = firstSignIn();
  await withApi(pc, store, auth, async (base) => {
    assert.equal((await fetch(`${base}/desktop`, { headers: { 'X-User': 'sudhakar' } })).status, 401);
    assert.equal((await fetch(`${base}/auth/me`)).status, 401);
    const bad = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'sudhakar', password: 'nope-nope' }) });
    assert.equal(bad.status, 401);
    assert.equal(bad.headers.get('set-cookie'), null, 'a failed sign-in sets no cookie');
  });
});

test('API: the first sign-in sets a cookie and blocks the app until the password is changed', async () => {
  const { pc, store, auth, first } = firstSignIn();
  pc.staffById('sudhakar').passwordHash = pc.staffById('sudhakar').passwordHash; // already set by firstSignIn
  await withApi(pc, store, auth, async (base) => {
    const login = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'sudhakar', password: first.temporaryPassword }) });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie');
    assert.match(cookie, /pc_session=[0-9a-f]{64}; HttpOnly; SameSite=Strict/);
    const body = await login.json();
    assert.equal(body.token, undefined, 'the token is not in the response body');
    const sess = cookie.split(';')[0];
    assert.equal((await (await fetch(`${base}/auth/me`, { headers: { Cookie: sess } })).json()).mustChangePassword, true);
    assert.equal((await fetch(`${base}/desktop`, { headers: { Cookie: sess } })).status, 403, 'blocked until the password changes');
    const changed = await fetch(`${base}/auth/password`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: sess }, body: JSON.stringify({ current: first.temporaryPassword, next: 'a-new-password' }) });
    assert.equal(changed.status, 200);
    assert.equal((await fetch(`${base}/desktop`, { headers: { Cookie: sess } })).status, 200);
  });
});

test('API: only the UW Manager lists and creates staff accounts', async () => {
  const { pc, store, auth, first } = firstSignIn();
  pc.changeOwnPassword(pc.user('sudhakar'), { current: first.temporaryPassword, next: 'manager-pass-1' });
  const manager = auth.login('sudhakar', 'manager-pass-1');
  await withApi(pc, store, auth, async (base) => {
    const cookie = `pc_session=${manager.token}`;
    const list = await fetch(`${base}/staff`, { headers: { Cookie: cookie } });
    assert.equal(list.status, 200);
    const people = await list.json();
    assert.ok(people.some((p) => p.username === 'sudhakar'));
    assert.ok(people.every((p) => p.passwordHash === undefined), 'no password data in the list');
    const created = await fetch(`${base}/staff`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ username: 'ravi.two', name: 'Naagarjuna', role: 'Insurance Executive' }) });
    assert.equal(created.status, 200);
    assert.match((await created.json()).temporaryPassword, /^[A-Za-z0-9]{12}$/);
  });
});
