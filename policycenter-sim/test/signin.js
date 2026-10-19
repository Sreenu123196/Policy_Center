'use strict';
// Test helper: a session cookie for a staff member, so API tests can sign in the same way the app does.
const { Auth } = require('../src/auth');
const { hashPassword } = require('../src/passwords');

const TEST_PASSWORD = 'test-password-1';

// Gives the person a password and signs them in. Returns the Cookie header value.
function cookieFor(pc, username) {
  const staff = pc.staffById(username);
  staff.passwordHash = hashPassword(TEST_PASSWORD);
  staff.mustChangePassword = false;
  const auth = new Auth(pc);
  const { token } = auth.login(username, TEST_PASSWORD);
  return { auth, cookie: `pc_session=${token}` };
}

module.exports = { cookieFor, TEST_PASSWORD };
