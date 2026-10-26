'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createAops } = require('../src/aops');

// A procedure permits an action; the absence of one forbids it. The second rule is the one that keeps a new tool from inheriting
// permission simply by existing.

const aops = createAops();

test('an underwriting bind within the role limit is permitted, and the English is returned with it', () => {
  const result = aops.check({ action: 'bind.approve', role: 'Underwriter', amount: 200000 });
  assert.equal(result.allowed, true);
  assert.equal(result.procedure.id, 'UW-BIND-001');
  assert.match(result.plainEnglish, /up to the authority their role carries/);
  assert.equal(result.limit, 250000);
});

test('an amount above the role limit is refused, naming the limit', () => {
  const result = aops.check({ action: 'bind.approve', role: 'Underwriter', amount: 300000 });
  assert.equal(result.allowed, false);
  assert.match(result.reason, /above the 250000/);
});

test('a role with no authority under the procedure is refused', () => {
  const result = aops.check({ action: 'bind.approve', role: 'Agent', amount: 1000 });
  assert.equal(result.allowed, false);
  assert.match(result.reason, /carries no authority/);
});

test('an action no procedure covers is refused, whatever the role', () => {
  const result = aops.check({ action: 'policy.cancel', role: 'UW Manager' });
  assert.equal(result.allowed, false);
  assert.match(result.reason, /No procedure covers/);
  assert.equal(result.procedure, null);
});

test('paying a claim is reserved to a person even at zero value', () => {
  const result = aops.check({ action: 'claim.settle', role: 'UW Manager', amount: 0 });
  assert.equal(result.allowed, false);
  assert.match(result.reason, /reserves this to a person/);
});

test('the requester of an approval cannot decide it, as written in the procedure', () => {
  const result = aops.check({ action: 'bind.approve', role: 'UW Manager', amount: 5000, actor: 'uwm', requestedBy: 'uwm' });
  assert.equal(result.allowed, false);
  assert.match(result.reason, /cannot also decide/);
});

test('referring a claim is permitted at any value, because referring is not deciding', () => {
  const result = aops.check({ action: 'claim.refer', role: 'Adjuster', amount: 999999 });
  assert.equal(result.allowed, true);
  assert.equal(result.procedure.id, 'CLM-REFER-001');
});

test('reserve drafting has its own limit, and an unknown procedure id is refused', () => {
  assert.equal(aops.check({ action: 'claim.reserve', role: 'Adjuster', amount: 25000 }).allowed, true);
  assert.equal(aops.check({ action: 'claim.reserve', role: 'Adjuster', amount: 25001 }).allowed, false);
  assert.throws(() => aops.get('NOPE-1'), /No procedure/);
  assert.equal(aops.list().length >= 5, true);
});
