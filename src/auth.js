'use strict';
// Sign-in for the app: passwords stored as salted scrypt hashes, sessions that expire, and a lockout after
// repeated wrong passwords. Sessions live in memory, so a server restart signs everyone out.

const crypto = require('node:crypto');
const { AppError } = require('./policyCenter');
const { verifyPassword } = require('./passwords');

const SESSION_HOURS = 8;
const MAX_FAILURES = 5;
const LOCK_MINUTES = 15;
class Auth {
  constructor(pc) {
    this.pc = pc;
    this.sessions = new Map(); // token -> { userId, expires }
    this.failures = new Map(); // username -> { count, lockedUntil }
  }

  now() {
    return this.pc.nowMs();
  }

  login(username, password) {
    const key = String(username || '').toLowerCase();
    const f = this.failures.get(key) || { count: 0, lockedUntil: 0 };
    if (f.lockedUntil > this.now()) {
      throw new AppError(429, `Too many wrong passwords. Try again in ${Math.ceil((f.lockedUntil - this.now()) / 60000)} minutes.`);
    }
    const staff = this.pc.staffByUsername(key);
    const ok = staff && staff.active && verifyPassword(password, staff.passwordHash);
    if (!ok) {
      f.count += 1;
      if (f.count >= MAX_FAILURES) {
        f.lockedUntil = this.now() + LOCK_MINUTES * 60000;
        f.count = 0;
      }
      this.failures.set(key, f);
      throw new AppError(401, 'Wrong username or password');
    }
    this.failures.delete(key);
    const token = crypto.randomBytes(32).toString('hex');
    this.sessions.set(token, { userId: staff.id, expires: this.now() + SESSION_HOURS * 3600000 });
    return { token, user: this.pc.userView(staff), mustChangePassword: Boolean(staff.mustChangePassword) };
  }

  logout(token) {
    this.sessions.delete(token);
  }

  // The signed-in user for a token, or null if the session is missing or expired.
  userFor(token) {
    const s = token && this.sessions.get(token);
    if (!s) return null;
    if (s.expires < this.now()) {
      this.sessions.delete(token);
      return null;
    }
    const staff = this.pc.staffById(s.userId);
    return staff && staff.active ? staff : null;
  }

  // Ends every session for a person (used when their password is reset or the account is deactivated).
  endSessionsFor(userId) {
    for (const [token, s] of this.sessions) if (s.userId === userId) this.sessions.delete(token);
  }
}

module.exports = { Auth, SESSION_HOURS };
