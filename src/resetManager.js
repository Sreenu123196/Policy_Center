'use strict';
// Gives the UW Manager a new temporary password and hands it back once. Used by scripts/reset-manager.js.
// It works on either store, so a database installation is not locked out when the password is lost.

const { PolicyCenter } = require('./policyCenter');
const { hashPassword, temporaryPassword } = require('./passwords');

// The record is looked up inside the unit of work on purpose: outside one the store hands out the plain data (reads cost
// nothing extra), and a change made to that plain record would not be saved.
async function resetManagerPassword(store) {
  const pc = new PolicyCenter(store);
  const password = temporaryPassword();
  let username = null;
  store.transaction(() => {
    const manager = pc.db.staff.find((person) => person.role === 'UW Manager');
    if (!manager) return;
    manager.passwordHash = hashPassword(password);
    manager.mustChangePassword = true;
    manager.active = true;
    username = manager.username;
  });
  if (!username) throw new Error('No UW Manager account was found in the book.');
  return { username, password };
}

module.exports = { resetManagerPassword };
