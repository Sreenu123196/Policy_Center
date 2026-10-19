'use strict';
// Restore a backup. STOP THE SERVER FIRST: a running server keeps the data in memory and would save over the restored file.
//   node scripts/restore.js                    -> lists the backups and checks each one
//   node scripts/restore.js <backup file>      -> verifies it, keeps the current file as <file>.before-restore-<time>, puts the backup in place
const path = require('node:path');
const { listBackups, restoreBackup } = require('../src/backup');

const dataFile = process.env.DATA_FILE || path.join(__dirname, '..', 'data', 'policycenter.json');
const dir = process.env.BACKUP_DIR || path.join(path.dirname(dataFile), 'backups');
const wanted = process.argv[2];

if (!wanted) {
  const all = listBackups(dir);
  if (!all.length) console.log(`No backups in ${dir}`);
  for (const b of all) console.log(`${b.name}  ${(b.bytes / 1048576).toFixed(1)} MB  ${b.verified ? `ok (${b.counts.accounts} accounts, ${b.counts.policies} policies)` : `DAMAGED: ${b.reason}`}`);
  process.exit(0);
}
try {
  const result = restoreBackup(path.resolve(dir, wanted), dataFile);
  console.log(`Restored ${result.counts.accounts} accounts and ${result.counts.policies} policies to ${result.restoredTo}`);
  if (result.keptCopy) console.log(`What was there before is kept at ${result.keptCopy}`);
  console.log('Start the server again.');
} catch (err) {
  console.error(`Not restored: ${err.message}`);
  process.exit(1);
}
