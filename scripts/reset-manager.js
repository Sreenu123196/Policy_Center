'use strict';
// Gives the UW Manager a new temporary password, printed in this window only.
// Use it when the first-start password was lost. Stop the app first (Ctrl+C in its window), run this,
// then start the app again and sign in with the new temporary password.
//
//   npm run reset-manager
//   DATABASE_URL=postgres://... npm run reset-manager

const path = require('node:path');
const { loadEnv } = require('../src/loadEnv');
loadEnv();

const { Store } = require('../src/store');
const { openStoreFromEnv } = require('../src/pg/open');
const { resetManagerPassword } = require('../src/resetManager');

const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, '..', 'data', 'policycenter.json');

async function main() {
  const store = (await openStoreFromEnv({ dataFile: DATA_FILE })) || new Store(DATA_FILE);
  const { username, password } = await resetManagerPassword(store);
  if (typeof store.close === 'function') await store.close();

  console.log('------------------------------------------------------------');
  console.log(`New temporary password for ${username} (UW Manager)`);
  console.log(`Username: ${username}`);
  console.log(`Temporary password: ${password}`);
  console.log('They must choose a new password at the first sign-in.');
  console.log('------------------------------------------------------------');
}

main().catch((err) => {
  console.error('The password could not be reset:', err.message);
  process.exit(1);
});
