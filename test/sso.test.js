'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSso } = require('../src/sso');

// The provider is simulated; the rule is not. A session that has not satisfied its challenge is refused everywhere.

function world(nowMs = Date.parse('2026-10-23T10:00:00Z')) {
  const store = { data: { ssoSessions: [], seq: {} }, next: (n) => { store.data.seq[n] = (store.data.seq[n] || 0) + 1; return store.data.seq[n]; } };
  let clock = nowMs;
  const sso = createSso({ store, now: () => clock });
  return { sso, store, advance: (ms) => { clock += ms; } };
}

test('a session starts awaiting its second factor and is refused until satisfied', () => {
  const { sso } = world();
  const { session, simulatedCode } = sso.startSession({ subject: 'asha', role: 'Underwriter' });
  assert.equal(session.state, 'awaiting_mfa');
  assert.match(simulatedCode, /^\d{6}$/);
  assert.throws(() => sso.requireActive(session.id), /not authenticated/);
  const active = sso.satisfyChallenge(session.id, simulatedCode);
  assert.equal(active.state, 'active');
  assert.equal(sso.requireActive(session.id).subject, 'asha');
});

test('a wrong code does not activate the session, and three failures lock it', () => {
  const { sso } = world();
  const { session, simulatedCode } = sso.startSession({ subject: 'asha' });
  const wrong = simulatedCode === '000000' ? '111111' : '000000';
  // Three wrong attempts lock the session; every call throws, so each is caught deliberately.
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    assert.throws(() => sso.satisfyChallenge(session.id, wrong), /not correct/);
  }
  assert.equal(session.state, 'locked');
  assert.throws(() => sso.satisfyChallenge(session.id, simulatedCode), /not awaiting a challenge \(locked\)/);
});

test('an expired challenge cannot be satisfied, and an expired session is refused', () => {
  const { sso, advance } = world();
  const first = sso.startSession({ subject: 'asha' });
  advance(6 * 60 * 1000);
  assert.throws(() => sso.satisfyChallenge(first.session.id, first.simulatedCode), /expired/);

  const second = sso.startSession({ subject: 'asha' });
  sso.satisfyChallenge(second.session.id, second.simulatedCode);
  advance(31 * 60 * 1000);
  assert.throws(() => sso.requireActive(second.session.id), /expired/);
});

test('a session can be created without MFA when the policy allows it', () => {
  const { sso } = world();
  const { session, simulatedCode } = sso.startSession({ subject: 'service-account', mfaRequired: false });
  assert.equal(session.state, 'active');
  assert.equal(simulatedCode, null);
  assert.equal(sso.requireActive(session.id).subject, 'service-account');
});

test('an unknown session looks missing', () => {
  const { sso } = world();
  assert.throws(() => sso.requireActive('SSO-9999999'), /Session not found/);
});
