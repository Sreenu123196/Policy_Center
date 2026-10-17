'use strict';
// Gives the UW Manager (sudhakar) a new temporary password, printed in this window only.
// Use it when the first-start password was lost. Stop the app first (Ctrl+C in its window), run this,
// then start the app again and sign in with the new temporary password.
//
//   npm run reset-manager

const path = require('node:path');
const { Store } = require('../src/store');
const { PolicyCenter } = require('../src/policyCenter');
const { hashPassword, temporaryPassword } = require('../src/passwords');

const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, '..', 'data', 'policycenter.json');
const store = new Store(DATA_FILE);
const pc = new PolicyCenter(store);

const manager = pc.staffById('sudhakar');
if (!manager) {
  console.error('No UW Manager account named sudhakar was found in the data file.');
  process.exit(1);
}

const password = temporaryPassword();
store.transaction(() => {
  manager.passwordHash = hashPassword(password);
  manager.mustChangePassword = true;
  manager.active = true;
});

console.log('------------------------------------------------------------');
console.log('New temporary password for sudhakar (UW Manager)');
console.log(`Username: sudhakar`);
console.log(`Temporary password: ${password}`);
console.log('He must choose a new password at the first sign-in.');
console.log('------------------------------------------------------------');
