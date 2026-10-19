'use strict';
// Backup and restore of the data file. A backup is the data as text plus a .sha256 file next to it, so a copy that was changed,
// cut short or half written is found before it is restored. Backups hold personal data and password hashes: keep them as safe as the data.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const NAME = /^policycenter-\d{8}-\d{6}\.json$/;
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');
const stamp = (d) => d.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

function counts(data) {
  const n = (k) => (Array.isArray(data[k]) ? data[k].length : 0);
  return { accounts: n('accounts'), policies: n('policies'), jobs: n('jobs'), claims: n('claims'), events: n('events') };
}

function replaceFile(file, text) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text);
  for (let attempt = 1; ; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (err) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(err.code) || attempt >= 8) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * attempt);
    }
  }
}

// Writes the backup and keeps only the newest `keep`. `text` is the data as JSON text.
function writeBackup(text, dir, { keep = 14, now = new Date() } = {}) {
  const data = JSON.parse(text); // refuse to back up something that is not data
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `policycenter-${stamp(now)}.json`);
  const digest = sha256(text);
  replaceFile(file, text);
  replaceFile(`${file}.sha256`, `${digest}  ${path.basename(file)}\n`);
  const all = fs.readdirSync(dir).filter((n) => NAME.test(n)).sort().reverse();
  for (const old of all.slice(keep)) {
    fs.rmSync(path.join(dir, old), { force: true });
    fs.rmSync(path.join(dir, `${old}.sha256`), { force: true });
  }
  return { file, name: path.basename(file), bytes: Buffer.byteLength(text), sha256: digest, counts: counts(data) };
}

// Is this backup whole? Returns { ok, reason, counts }.
function verifyBackup(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { ok: false, reason: 'The backup was not found' };
  }
  let expected;
  try {
    expected = fs.readFileSync(`${file}.sha256`, 'utf8').trim().split(/\s+/)[0];
  } catch {
    return { ok: false, reason: 'The checksum file is missing' };
  }
  if (sha256(text) !== expected) return { ok: false, reason: 'The checksum does not match: the backup was changed or is incomplete' };
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'The backup is not valid JSON' };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data) || !Array.isArray(data.accounts) || !Array.isArray(data.policies)) return { ok: false, reason: 'The backup is not PolicyCenter data' };
  return { ok: true, counts: counts(data) };
}

// Newest first.
function listBackups(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((n) => NAME.test(n)).sort().reverse().map((name) => {
    const file = path.join(dir, name);
    const check = verifyBackup(file);
    return { name, bytes: fs.statSync(file).size, createdAt: fs.statSync(file).mtime.toISOString(), verified: check.ok, reason: check.ok ? null : check.reason, counts: check.counts || null };
  });
}

// Puts a verified backup in place of the live data file. What was there is kept next to it, never overwritten. Stop the server first.
function restoreBackup(file, target, { now = new Date() } = {}) {
  const check = verifyBackup(file);
  if (!check.ok) throw new Error(check.reason);
  const text = fs.readFileSync(file, 'utf8');
  let keptCopy = null;
  if (fs.existsSync(target)) {
    keptCopy = `${target}.before-restore-${stamp(now)}`;
    fs.copyFileSync(target, keptCopy);
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  replaceFile(target, text);
  return { restoredTo: target, keptCopy, counts: check.counts };
}

module.exports = { writeBackup, verifyBackup, listBackups, restoreBackup };
