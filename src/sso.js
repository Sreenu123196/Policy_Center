'use strict';
// Single sign-on and MFA, simulated behind the shape a real provider gives us.
//
// A session exists in two states: created and awaiting a second factor, or active. Everything protected asks for an active
// session, so a session that has not satisfied its challenge is refused everywhere rather than in the one place someone
// remembered to check. The provider is fake; the rule is not.

const crypto = require('node:crypto');
const { AppError } = require('./appError');

const SESSION_TTL_MS = 30 * 60 * 1000;
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

function createSso({ store, now = () => Date.now() } = {}) {
  const sessions = () => {
    store.data.ssoSessions = store.data.ssoSessions || [];
    return store.data.ssoSessions;
  };

  function issueCode() {
    return String(crypto.randomInt(100000, 999999));
  }

  /** Step 1: the provider vouches for a subject; we open a session awaiting its second factor. */
  function startSession({ subject, role, mfaRequired = true }) {
    if (!subject) throw new AppError(422, 'a subject is required');
    const session = {
      id: 'SSO-' + String(store.next('ssoSession')).padStart(7, '0'),
      subject,
      role: role || null,
      state: mfaRequired ? 'awaiting_mfa' : 'active',
      createdAt: new Date(now()).toISOString(),
      expiresAt: new Date(now() + SESSION_TTL_MS).toISOString(),
      challenge: mfaRequired
        ? { code: issueCode(), expiresAt: new Date(now() + CHALLENGE_TTL_MS).toISOString(), attempts: 0 }
        : null,
    };
    sessions().push(session);
    // The code is returned only because this is a simulation: a real provider sends it to the person, never to the caller.
    return { session, simulatedCode: session.challenge ? session.challenge.code : null };
  }

  function find(id) {
    const session = sessions().find((s) => s.id === id);
    if (!session) throw new AppError(404, 'Session not found');
    return session;
  }

  function satisfyChallenge(id, code) {
    const session = find(id);
    // Only a session that is awaiting its challenge may be challenged. Everything else - active, locked, expired - is
    // refused here, because a locked session must not be recoverable with the code that locked it.
    if (session.state !== 'awaiting_mfa') throw new AppError(409, 'This session is not awaiting a challenge (' + session.state + ')');
    if (Date.parse(session.challenge.expiresAt) < now()) {
      session.state = 'expired';
      throw new AppError(403, 'The challenge has expired; start again');
    }
    session.challenge.attempts += 1;
    if (String(code) !== session.challenge.code) {
      if (session.challenge.attempts >= 3) session.state = 'locked';
      throw new AppError(403, 'The code is not correct');
    }
    session.state = 'active';
    session.challenge = null;
    return session;
  }

  /** What every protected route asks: an active, unexpired session, or a refusal. */
  function requireActive(id) {
    const session = find(id);
    if (session.state !== 'active') throw new AppError(403, 'This session is not authenticated');
    if (Date.parse(session.expiresAt) < now()) {
      session.state = 'expired';
      throw new AppError(403, 'This session has expired; sign in again');
    }
    return session;
  }

  return { startSession, satisfyChallenge, requireActive, find, SESSION_TTL_MS, CHALLENGE_TTL_MS };
}

module.exports = { createSso, SESSION_TTL_MS, CHALLENGE_TTL_MS };
