'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const gate = require('../src/policyGate');

// Each rule is a mistake this repository actually made. Every one is tested by reproducing it.

const healthy = {
  reported: 657,
  baseline: 657,
  routes: [{ method: 'GET', pattern: '/policies' }],
  matrixKeys: ['GET /policies'],
  files: ['src/a.js', 'test/a.test.js'],
  diffText: 'const answer = 42;',
};

test('a healthy change passes every rule', () => {
  const result = gate.runGate(healthy);
  assert.equal(result.passed, true);
  assert.equal(result.results.length, 6, 'two route rules plus count, tests, secrets, env');
  assert.equal(result.results.every((r) => r.ok), true);
});

test('a shrinking suite fails: this is the twelve deleted tests', () => {
  const result = gate.checkTestCount({ reported: 645, baseline: 657 });
  assert.equal(result[0].ok, false);
  assert.match(result[0].detail, /shrank: 645/);
});

test('an unreported or unrecorded count fails, because the gate cannot prove anything', () => {
  assert.equal(gate.checkTestCount({ reported: 0, baseline: 657 })[0].ok, false);
  assert.equal(gate.checkTestCount({ reported: 657, baseline: 0 })[0].ok, false);
});

test('a route with no permission row fails, and a row with no route fails separately', () => {
  const missingRow = gate.checkRoutes({ routes: [{ method: 'GET', pattern: '/new' }], matrixKeys: [] });
  assert.equal(missingRow[0].ok, false);
  assert.match(missingRow[0].detail, /GET \/new/);
  const missingRoute = gate.checkRoutes({ routes: [], matrixKeys: ['GET /gone'] });
  assert.equal(missingRoute[1].ok, false);
  assert.match(missingRoute[1].detail, /GET \/gone/);
});

test('a source change with no test change fails', () => {
  const result = gate.checkSourceNeedsTests({ files: ['src/api.js'] });
  assert.equal(result[0].ok, false);
  assert.match(result[0].detail, /no test change/);
});

test('a commit that only touches docs or tests is fine', () => {
  assert.equal(gate.checkSourceNeedsTests({ files: ['docs/A.md'] })[0].ok, true);
  assert.equal(gate.checkSourceNeedsTests({ files: ['test/a.test.js'] })[0].ok, true);
});

test('secret-shaped strings fail, and ordinary prose does not', () => {
  assert.equal(gate.checkSecrets({ text: 'const key = "sk-ant-abcdefghijklmnop";' })[0].ok, false);
  assert.equal(gate.checkSecrets({ text: 'const password = "correct horse battery staple";' })[0].ok, true);
  assert.equal(gate.checkSecrets({ text: 'RAZORPAY_KEY_SECRET=abcdefgh12345678' })[0].ok, false);
});

test('an environment file fails, but the example file is allowed', () => {
  assert.equal(gate.checkEnvFile({ files: ['.env'] })[0].ok, false);
  assert.equal(gate.checkEnvFile({ files: ['.env.example'] })[0].ok, true);
  assert.equal(gate.checkEnvFile({ files: ['config/.env.local'] })[0].ok, false);
});
