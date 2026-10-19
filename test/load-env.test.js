'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadEnv } = require('../src/loadEnv');

test('a .env file fills in settings that are not already set, and ignores comments', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pc-env-')), '.env');
  fs.writeFileSync(file, '# mail\nGMAIL_USER=me@gmail.com\nGMAIL_APP_PASSWORD="abcd efgh ijkl mnop"\r\nPORT=4000\nBAD LINE\n');
  const env = { PORT: '3000' };
  assert.deepEqual(loadEnv(file, env), ['GMAIL_USER', 'GMAIL_APP_PASSWORD']);
  assert.equal(env.GMAIL_USER, 'me@gmail.com');
  assert.equal(env.GMAIL_APP_PASSWORD, 'abcd efgh ijkl mnop');
  assert.equal(env.PORT, '3000', 'the environment wins over the file');
  assert.deepEqual(loadEnv(path.join(os.tmpdir(), 'no-such-file.env'), {}), []);
});
