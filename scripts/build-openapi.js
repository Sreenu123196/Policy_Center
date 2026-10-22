'use strict';
// Write docs/openapi.json from the routes this build registers. Run with: npm run openapi

const fs = require('node:fs');
const path = require('node:path');
const { buildSpec } = require('../src/openapi');

(async () => {
  const { setup } = require('../test/helpers');
  const env = setup('2026-03-01');
  try {
    const { createApi } = require('../src/api');
    const spec = buildSpec(createApi(env.pc, env.store, {}).routes);
    const out = path.join(__dirname, '../docs/openapi.json');
    fs.writeFileSync(out, JSON.stringify(spec, null, 2) + '\n', 'utf8');
    const operations = Object.values(spec.paths).reduce((sum, methods) => sum + Object.keys(methods).length, 0);
    console.log('wrote', out, '-', Object.keys(spec.paths).length, 'paths,', operations, 'operations');
  } finally {
    if (env.close) env.close();
  }
})().catch((err) => { console.error('openapi build failed:', err.message); process.exit(1); });
