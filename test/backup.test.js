'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { setup, account, autoSubmission } = require('./helpers');
const { Store } = require('../src/store');
const { createApi } = require('../src/api');
const { Auth } = require('../src/auth');
const { hashPassword } = require('../src/passwords');
const { TEST_PASSWORD } = require('./signin');
const { writeBackup, listBackups, verifyBackup, restoreBackup } = require('../src/backup');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pc-backup-'));

test('a backup is a checked copy of the data: restoring it brings back exactly what was saved', () => {
  const dir = tmp();
  const dataFile = path.join(dir, 'policycenter.json');
  const env = setup('2026-03-01');
  const store = new Store(dataFile);
  store.data = JSON.parse(JSON.stringify(env.store.data));
  const a = account(env.pc, 'agent');
  store.data = JSON.parse(JSON.stringify(env.store.data));
  store.save();
  const before = fs.readFileSync(dataFile, 'utf8');

  const made = writeBackup(JSON.stringify(store.data), path.join(dir, 'backups'), { now: new Date('2026-03-01T10:00:00Z') });
  assert.match(path.basename(made.file), /^policycenter-20260301-100000\.json$/);
  assert.equal(verifyBackup(made.file).ok, true);
  assert.ok(made.counts.accounts >= 1);

  // The data is damaged after the backup.
  fs.writeFileSync(dataFile, '{"accounts": [');
  const restored = restoreBackup(made.file, dataFile);
  assert.equal(fs.readFileSync(dataFile, 'utf8'), before);
  assert.ok(fs.existsSync(restored.keptCopy), 'what was there is kept, not thrown away');
  assert.equal(fs.readFileSync(restored.keptCopy, 'utf8'), '{"accounts": [');
  assert.equal(new Store(dataFile).data.accounts.length, store.data.accounts.length, 'the restored file loads');
  assert.ok(a);
});

test('a backup that was changed, cut short or is not data is refused, and the live file is left alone', () => {
  const dir = tmp();
  const dataFile = path.join(dir, 'policycenter.json');
  fs.writeFileSync(dataFile, '{"accounts":[1]}');
  const good = writeBackup(JSON.stringify({ accounts: [], policies: [] }), path.join(dir, 'b'), { now: new Date('2026-03-01T10:00:00Z') });

  fs.appendFileSync(good.file, ' ');
  assert.equal(verifyBackup(good.file).ok, false);
  assert.match(verifyBackup(good.file).reason, /checksum/i);
  assert.throws(() => restoreBackup(good.file, dataFile), /checksum/i);

  const stray = path.join(dir, 'b', 'policycenter-20260302-000000.json');
  fs.writeFileSync(stray, '[]');
  assert.equal(verifyBackup(stray).ok, false, 'no checksum file');
  assert.throws(() => restoreBackup(stray, dataFile));
  assert.equal(fs.readFileSync(dataFile, 'utf8'), '{"accounts":[1]}', 'the live file was not touched');
  assert.throws(() => restoreBackup(path.join(dir, 'b', 'nothing.json'), dataFile), /not found|no such/i);
});

test('only the newest backups are kept', () => {
  const dir = path.join(tmp(), 'b');
  for (let day = 1; day <= 6; day++) writeBackup('{"accounts":[]}', dir, { keep: 3, now: new Date(Date.UTC(2026, 2, day, 1, 0, 0)) });
  const names = listBackups(dir).map((b) => b.name);
  assert.deepEqual(names, ['policycenter-20260306-010000.json', 'policycenter-20260305-010000.json', 'policycenter-20260304-010000.json']);
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.sha256')).length, 3, 'the checksum files go with them');
});

async function serve() {
  const env = setup('2026-03-01');
  const auth = new Auth(env.pc);
  for (const u of ['uwm', 'uw', 'agent']) {
    const s = env.pc.staffById(u);
    s.passwordHash = hashPassword(TEST_PASSWORD);
    s.mustChangePassword = false;
  }
  const backupDir = path.join(tmp(), 'backups');
  const api = createApi(env.pc, env.store, { auth, backupDir });
  const server = http.createServer((req, res) => { const u = new URL(req.url, 'http://x'); api(req, res, u.pathname, u.searchParams); });
  await new Promise((ok) => server.listen(0, ok));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const as = async (username) => {
    const res = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: TEST_PASSWORD }) });
    return String(res.headers.get('set-cookie')).split(';')[0];
  };
  return { ...env, server, base, as, backupDir };
}

test('a UW manager can take and list backups; nobody else can', async () => {
  const s = await serve();
  try {
    const manager = await s.as('uwm');
    const made = await fetch(`${s.base}/admin/backup`, { method: 'POST', headers: { Cookie: manager } });
    assert.equal(made.status, 200);
    const body = await made.json();
    assert.match(body.name, /^policycenter-\d{8}-\d{6}\.json$/);
    assert.ok(body.bytes > 0 && body.sha256.length === 64);
    assert.equal(verifyBackup(path.join(s.backupDir, body.name)).ok, true);

    const list = await (await fetch(`${s.base}/admin/backups`, { headers: { Cookie: manager } })).json();
    assert.equal(list[0].name, body.name);
    assert.equal(list[0].verified, true);

    for (const user of ['uw', 'agent']) {
      const cookie = await s.as(user);
      assert.equal((await fetch(`${s.base}/admin/backup`, { method: 'POST', headers: { Cookie: cookie } })).status, 403, user);
      assert.equal((await fetch(`${s.base}/admin/backups`, { headers: { Cookie: cookie } })).status, 403, user);
    }
  } finally {
    s.server.close();
  }
});

test('a backup holds no session tokens', async () => {
  const s = await serve();
  try {
    const manager = await s.as('uwm');
    const made = await (await fetch(`${s.base}/admin/backup`, { method: 'POST', headers: { Cookie: manager } })).json();
    const text = fs.readFileSync(path.join(s.backupDir, made.name), 'utf8');
    assert.ok(!text.includes(manager.split('=')[1]), 'the live session token is not in the file');
  } finally {
    s.server.close();
  }
});
