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

const FIRST_PASSWORD = 'first-password-1';

function app() {
  const store = new Store();
  const pc = new PolicyCenter(store);
  store.transaction(() => seed(pc));
  return { store, pc, auth: new Auth(pc) };
}

// The first person to open the app creates the UW Manager account and signs in.
function setUp() {
  const env = app();
  env.pc.setupFirstManager({ username: 'sudhakar', password: FIRST_PASSWORD });
  const login = env.auth.login('sudhakar', FIRST_PASSWORD);
  return { ...env, login };
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

test('setup: the first person chooses the UW Manager username and password; no password is pre-set', () => {
  const { pc, login } = setUp();
  assert.equal(pc.setupNeeded(), false);
  assert.equal(login.user.username, 'sudhakar');
  assert.equal(login.user.role, 'UW Manager');
  assert.equal(login.mustChangePassword, false, 'the person chose it, so no change is forced');
  assert.equal(login.user.passwordHash, undefined, 'the hash never leaves the server');
});

test('setup: a new username renames the manager and keeps the team reporting to him', () => {
  const env = app();
  env.pc.setupFirstManager({ username: 'manager.s', password: FIRST_PASSWORD });
  assert.equal(env.pc.staffById('manager.s').role, 'UW Manager');
  assert.equal(env.pc.staffById('sudhakar'), null);
  assert.equal(env.pc.staffById('venkatesh').reportsTo, 'manager.s');
});

test('setup: it works only once, and needs a valid username and an 8-character password', () => {
  const env = app();
  assert.throws(() => env.pc.setupFirstManager({ username: 'ab', password: FIRST_PASSWORD }), /Username/);
  assert.throws(() => env.pc.setupFirstManager({ username: 'sudhakar', password: 'short' }), /8 characters/);
  env.pc.setupFirstManager({ username: 'sudhakar', password: FIRST_PASSWORD });
  assert.throws(() => env.pc.setupFirstManager({ username: 'other', password: FIRST_PASSWORD }), /already set up/);
});

test('sign-in: wrong passwords are refused, and too many lock the account for a while', () => {
  const { auth } = setUp();
  for (let i = 0; i < 4; i++) assert.throws(() => auth.login('sudhakar', 'wrong'), /Wrong username or password/);
  assert.throws(() => auth.login('sudhakar', 'wrong'), /Wrong username or password/, 'the fifth wrong try');
  assert.throws(() => auth.login('sudhakar', 'anything'), /Too many wrong passwords/);
});

test('sign-in: a session expires after eight hours', () => {
  const { pc, auth, login } = setUp();
  assert.ok(auth.userFor(login.token));
  pc.clockMs = Date.now() + 9 * 3600 * 1000;
  assert.equal(auth.userFor(login.token), null);
  pc.clockMs = null;
});

test('staff: only the UW Manager creates accounts; agents need a producer code', () => {
  const { pc } = setUp();
  const manager = pc.user('sudhakar');
  const made = pc.createStaff({ username: 'ravi.k', name: 'Ravi K', role: 'Insurance Executive' }, manager);
  assert.match(made.temporaryPassword, /^[A-Za-z0-9]{12}$/);
  assert.equal(pc.staffById('ravi.k').mustChangePassword, true);
  assert.equal(pc.staffById('ravi.k').reportsTo, 'sudhakar');
  assert.throws(() => pc.createStaff({ username: 'ravi.two', name: 'Ravi Two', role: 'Insurance Executive' }, pc.user('uw')), /Only the UW Manager/);
  assert.throws(() => pc.createStaff({ username: 'ravi.k', name: 'Again', role: 'Insurance Executive' }, manager), /already taken/);
  assert.throws(() => pc.createStaff({ username: 'Bad Name!', name: 'X Y', role: 'Agent', producerCode: 'PC-100' }, manager), /Username/);
  assert.throws(() => pc.createStaff({ username: 'newagent', name: 'New Agent', role: 'Agent' }, manager), /producer code/);
  assert.throws(() => pc.createStaff({ username: 'newagent', name: 'New Agent', role: 'Director' }, manager), /Role must be/);
  pc.createStaff({ username: 'newagent', name: 'New Agent', role: 'Agent', producerCode: 'PC-200' }, manager);
  assert.equal(pc.staffById('newagent').producerCode, 'PC-200');
});

test('staff: the new person signs in with the temporary password and must change it', () => {
  const { pc, auth } = setUp();
  const made = pc.createStaff({ username: 'ravi.k', name: 'Ravi K', role: 'Insurance Executive' }, pc.user('sudhakar'));
  const v = auth.login('ravi.k', made.temporaryPassword);
  assert.equal(v.mustChangePassword, true);
  assert.equal(v.user.role, 'Insurance Executive');
  pc.changeOwnPassword(auth.userFor(v.token), { current: made.temporaryPassword, next: 'ravi-own-pass-1' });
  assert.equal(auth.login('ravi.k', 'ravi-own-pass-1').user.name, 'Ravi K');
  assert.throws(() => auth.login('ravi.k', made.temporaryPassword), /Wrong username/);
});

test('staff: a password reset replaces the old password, ends sessions, and forces a change', () => {
  const { pc, auth } = setUp();
  const made = pc.createStaff({ username: 'ravi.k', name: 'Ravi K', role: 'Insurance Executive' }, pc.user('sudhakar'));
  const old = auth.login('ravi.k', made.temporaryPassword);
  pc.changeOwnPassword(auth.userFor(old.token), { current: made.temporaryPassword, next: 'ravi-own-pass-1' });
  const reset = pc.resetStaffPassword('ravi.k', pc.user('sudhakar'));
  auth.endSessionsFor('ravi.k');
  assert.equal(auth.userFor(old.token), null, 'the old session is ended');
  assert.throws(() => auth.login('ravi.k', 'ravi-own-pass-1'), /Wrong username/);
  assert.equal(auth.login('ravi.k', reset.temporaryPassword).mustChangePassword, true);
});

test('staff: turning an account off stops sign-in and ends its sessions; no one turns off their own', () => {
  const { pc, auth } = setUp();
  const made = pc.createStaff({ username: 'ravi.k', name: 'Ravi K', role: 'Insurance Executive' }, pc.user('sudhakar'));
  const v = auth.login('ravi.k', made.temporaryPassword);
  pc.setStaffActive('ravi.k', false, pc.user('sudhakar'));
  auth.endSessionsFor('ravi.k');
  assert.equal(auth.userFor(v.token), null);
  assert.throws(() => auth.login('ravi.k', made.temporaryPassword), /Wrong username/);
  assert.throws(() => pc.setStaffActive('sudhakar', false, pc.user('sudhakar')), /your own account/);
});

test('staff: a changed password must be right, new, and at least 8 characters', () => {
  const { pc } = setUp();
  const manager = pc.user('sudhakar');
  assert.throws(() => pc.changeOwnPassword(manager, { current: 'wrong', next: 'longenough' }), /current password is wrong/);
  assert.throws(() => pc.changeOwnPassword(manager, { current: FIRST_PASSWORD, next: 'short' }), /at least 8/);
  assert.throws(() => pc.changeOwnPassword(manager, { current: FIRST_PASSWORD, next: FIRST_PASSWORD }), /not the same/);
});

test('API: every call needs a session, and a header someone sends is not a sign-in', async () => {
  const { pc, store, auth } = setUp();
  await withApi(pc, store, auth, async (base) => {
    assert.equal((await fetch(`${base}/desktop`, { headers: { 'X-User': 'sudhakar' } })).status, 401);
    assert.equal((await fetch(`${base}/auth/me`)).status, 401);
    const bad = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'sudhakar', password: 'nope-nope' }) });
    assert.equal(bad.status, 401);
    assert.equal(bad.headers.get('set-cookie'), null, 'a failed sign-in sets no cookie');
  });
});

test('API: setup status is public, and the first setup signs the person in', async () => {
  const env = app();
  await withApi(env.pc, env.store, env.auth, async (base) => {
    assert.equal((await (await fetch(`${base}/auth/status`)).json()).setupNeeded, true);
    const res = await fetch(`${base}/auth/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'sudhakar', password: FIRST_PASSWORD }) });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('set-cookie'), /pc_session=[0-9a-f]{64}; HttpOnly; SameSite=Strict/);
    assert.equal((await (await fetch(`${base}/auth/status`)).json()).setupNeeded, false);
    const again = await fetch(`${base}/auth/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'other', password: FIRST_PASSWORD }) });
    assert.equal(again.status, 409, 'setup cannot run twice');
  });
});

test('API: a person with a temporary password is blocked until they change it', async () => {
  const { pc, store, auth } = setUp();
  const made = pc.createStaff({ username: 'ravi.k', name: 'Ravi K', role: 'Insurance Executive' }, pc.user('sudhakar'));
  await withApi(pc, store, auth, async (base) => {
    const login = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'ravi.k', password: made.temporaryPassword }) });
    assert.equal(login.status, 200);
    const sess = login.headers.get('set-cookie').split(';')[0];
    assert.equal((await fetch(`${base}/desktop`, { headers: { Cookie: sess } })).status, 403, 'blocked until the password changes');
    const changed = await fetch(`${base}/auth/password`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: sess }, body: JSON.stringify({ current: made.temporaryPassword, next: 'ravi-own-pass-1' }) });
    assert.equal(changed.status, 200);
    assert.equal((await fetch(`${base}/desktop`, { headers: { Cookie: sess } })).status, 200);
  });
});

test('API: only the UW Manager lists and creates staff accounts', async () => {
  const { pc, store, auth, login } = setUp();
  await withApi(pc, store, auth, async (base) => {
    const cookie = `pc_session=${login.token}`;
    const list = await fetch(`${base}/staff`, { headers: { Cookie: cookie } });
    assert.equal(list.status, 200);
    const people = await list.json();
    assert.ok(people.some((p) => p.username === 'sudhakar'));
    assert.ok(people.every((p) => p.passwordHash === undefined), 'no password data in the list');
    const created = await fetch(`${base}/staff`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ username: 'ravi.two', name: 'Ravi Two', role: 'Insurance Executive' }) });
    assert.equal(created.status, 200);
    assert.match((await created.json()).temporaryPassword, /^[A-Za-z0-9]{12}$/);
  });
});
