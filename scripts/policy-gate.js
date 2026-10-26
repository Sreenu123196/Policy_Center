'use strict';
// Usage: node scripts/policy-gate.js [--base origin/main]
//
// Collects what the gate needs: the suite's count, the routes and their permission rows, the files in the diff, and the diff itself.
// Exits non-zero if any rule fails, so CI and a pre-push hook behave the same way.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { runGate } = require('../src/policyGate');

function sh(args) {
  try { return execFileSync('git', args, { encoding: 'utf8' }); }
  catch (err) { return String(err.stdout || ''); }
}

function main() {
  const argIndex = process.argv.indexOf('--base');
  const base = argIndex > -1 ? process.argv[argIndex + 1] : 'origin/main';
  const baselineFile = path.join(__dirname, '..', 'docs', 'gate-baseline.json');
  const baseline = fs.existsSync(baselineFile) ? JSON.parse(fs.readFileSync(baselineFile, 'utf8')).minTests : 0;

  const countText = fs.existsSync(path.join(__dirname, '..', 'docs', 'test-count.txt'))
    ? fs.readFileSync(path.join(__dirname, '..', 'docs', 'test-count.txt'), 'utf8') : '';
  // The count comes from a recorded run (CI writes a file) or from --tests, so the gate never guesses.
  const testsIndex = process.argv.indexOf('--tests');
  const reported = testsIndex > -1
    ? Number(process.argv[testsIndex + 1])
    : Number((countText.match(/# pass (\d+)/) || [])[1] || 0);

  const { setup } = require('../test/helpers');
  const { createApi } = require('../src/api');
  const env = setup('2026-03-01');
  const api = createApi(env.pc, env.store, {});
  const routes = api.routes.map((r) => ({ method: r.method, pattern: r.pattern }));

  const matrixSource = fs.readFileSync(path.join(__dirname, '..', 'test', 'permissions-matrix.test.js'), 'utf8');
  const rows = [...matrixSource.matchAll(/^\s*'([A-Z]+ [^']+)':/gm)].map((m) => m[1]);
  // Public routes are a deliberate exception, recorded in PUBLIC rather than in the matrix. Both lists together are the permission story.
  const publicBlock = (matrixSource.match(/const PUBLIC = \[([\s\S]*?)\];/) || [])[1] || '';
  const publicKeys = [...publicBlock.matchAll(/'([A-Z]+ [^']+)'/g)].map((m) => m[1]);
  const matrixKeys = [...rows, ...publicKeys];

  const files = sh(['diff', '--name-only', base + '...HEAD']).split('\n').filter(Boolean);
  const diffText = sh(['diff', base + '...HEAD']);

  const result = runGate({ reported, baseline, routes, matrixKeys, files, diffText });
  for (const item of result.results) console.log((item.ok ? 'ok   ' : 'FAIL ') + item.rule + ': ' + item.detail);
  console.log(result.passed ? '\nGate passed.' : '\nGate failed.');
  process.exit(result.passed ? 0 : 1);
}

main();
