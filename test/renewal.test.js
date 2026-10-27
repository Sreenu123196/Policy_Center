'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { lapseRisk, draftRenewal } = require('../src/renewal');

// A renewal agent earns its place by naming why a policy is at risk and by stopping before it sends anything.

const policy = (over = {}) => ({ policyNumber: 'HO-0000001', renewalDate: '2026-04-01', status: 'In force', ...over });

test('a renewal inside thirty days is medium risk, with the days named', () => {
  const risk = lapseRisk({ policy: policy(), asOf: '2026-03-15' });
  assert.equal(risk.level, 'medium');
  assert.equal(risk.daysToRenewal, 17);
  assert.equal(risk.reasons[0].code, 'renewal-due');
  assert.match(risk.reasons[0].detail, /17 day/);
});

test('outstanding instalments or a passed date are high risk, and both are listed', () => {
  const lapsed = lapseRisk({ policy: policy({ renewalDate: '2026-03-01' }), asOf: '2026-03-15', instalmentsDue: 2 });
  assert.equal(lapsed.level, 'high');
  const codes = lapsed.reasons.map((r) => r.code).sort();
  assert.deepEqual(codes, ['already-lapsed', 'instalments-outstanding']);
});

test('a distant renewal with contact details is low risk and has no reasons', () => {
  const risk = lapseRisk({ policy: policy(), asOf: '2026-01-01', contacts: 2 });
  assert.equal(risk.level, 'low');
  assert.deepEqual(risk.reasons, []);
});

test('no contact details is a reason on its own, because a reminder cannot arrive', () => {
  const risk = lapseRisk({ policy: policy(), asOf: '2026-03-20', contacts: 0 });
  assert.ok(risk.reasons.some((r) => r.code === 'no-contact'));
});

test('the draft is written in the customer language, and an unsupported one falls back visibly', () => {
  const english = draftRenewal({ policy: policy(), language: 'en', customerName: 'Asha' });
  assert.match(english.text, /Dear Asha/);
  assert.equal(english.send.status, 'held_for_person');
  const telugu = draftRenewal({ policy: policy(), language: 'te', customerName: 'Rao' });
  assert.equal(telugu.language, 'te');
  assert.match(telugu.text, /పాలసీ/);
  const tamil = draftRenewal({ policy: policy(), language: 'ta' });
  assert.equal(tamil.language, 'en');
  assert.equal(tamil.fellBack, true);
});

test('no draft promises cover or quotes a price, and a missing policy is refused', () => {
  for (const language of ['en', 'hi', 'te']) {
    const draft = draftRenewal({ policy: policy(), language });
    assert.equal(/guarantee|promise|premium|₹|rs\./i.test(draft.text), false, language + ' draft makes no promise');
  }
  assert.throws(() => draftRenewal({}), /policy number is required/);
  assert.throws(() => lapseRisk({}), /renewal date is required/);
});
