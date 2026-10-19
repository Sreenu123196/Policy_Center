'use strict';
// Back up the data file while the server runs or stopped (the file is replaced atomically, so a copy is always whole).
//   node scripts/backup.js                 -> data/backups/policycenter-<time>.json (+ .sha256), keeps the newest 14
//   DATA_FILE=... BACKUP_DIR=... BACKUP_KEEP=30 node scripts/backup.js
const fs = require('node:fs');
const path = require('node:path');
const { writeBackup } = require('../src/backup');

const dataFile = process.env.DATA_FILE || path.join(__dirname, '..', 'data', 'policycenter.json');
const dir = process.env.BACKUP_DIR || path.join(path.dirname(dataFile), 'backups');
if (!fs.existsSync(dataFile)) {
  console.error(`No data file at ${dataFile}`);
  process.exit(1);
}
const made = writeBackup(fs.readFileSync(dataFile, 'utf8'), dir, { keep: Number(process.env.BACKUP_KEEP) || 14 });
console.log(`Backed up ${made.counts.accounts} accounts and ${made.counts.policies} policies to ${made.file} (${(made.bytes / 1048576).toFixed(1)} MB, sha256 ${made.sha256.slice(0, 12)}...)`);
