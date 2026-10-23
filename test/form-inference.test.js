'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { inferForm, formsFor } = require('../src/formInference');

// The first matching rule wins and the answer says why. These are the cases an underwriter would ask about.

test('an older house takes the older-home form even when it is expensive', () => {
  const result = inferForm({ product: 'Homeowners', facts: { yearBuilt: 1935, dwellingValue: 900000 } });
  assert.equal(result.form, 'HO-8');
  assert.match(result.reason, /before 1950/);
});

test('a valuable modern house takes the comprehensive form', () => {
  const result = inferForm({ product: 'Homeowners', facts: { yearBuilt: 2005, dwellingValue: 800000 } });
  assert.equal(result.form, 'HO-5');
  assert.match(result.reason, /comprehensive/);
});

test('an ordinary house takes the standard form', () => {
  const result = inferForm({ product: 'Homeowners', facts: { yearBuilt: 1995, dwellingValue: 300000 } });
  assert.equal(result.form, 'HO-3');
});

test('auto depends on whether physical damage cover is included', () => {
  assert.equal(inferForm({ product: 'PersonalAuto', facts: { collision: true } }).form, 'PA-2');
  assert.equal(inferForm({ product: 'PersonalAuto', facts: {} }).form, 'PA-1');
});

test('the answer records which forms were considered', () => {
  const result = inferForm({ product: 'Homeowners', facts: { yearBuilt: 1995 } });
  assert.deepEqual(result.considered.map((c) => c.form), ['HO-8', 'HO-5', 'HO-3']);
  assert.deepEqual(result.considered.map((c) => c.matched), [false, false, true]);
});

test('an unknown product is refused rather than defaulted', () => {
  assert.throws(() => inferForm({ product: 'PetInsurance' }), /No forms are defined/);
  assert.deepEqual(formsFor('PersonalAuto'), ['PA-2', 'PA-1']);
});
