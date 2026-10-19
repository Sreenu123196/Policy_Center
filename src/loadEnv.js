'use strict';
// Reads KEY=value lines from a .env file in the project folder into process.env, so settings (Gmail, API keys) do not depend on
// which terminal window started the server. Values already set in the environment win. .env is ignored by git: never commit it.
const fs = require('node:fs');
const path = require('node:path');

function loadEnv(file = path.join(__dirname, '..', '.env'), env = process.env) {
  if (!fs.existsSync(file)) return [];
  const loaded = [];
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (line.trim().startsWith('#')) continue;
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let value = m[2];
    if (/^(".*"|'.*')$/.test(value)) value = value.slice(1, -1);
    if (env[m[1]] === undefined || env[m[1]] === '') {
      env[m[1]] = value;
      loaded.push(m[1]);
    }
  }
  return loaded;
}

module.exports = { loadEnv };
