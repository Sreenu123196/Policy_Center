'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildScript, intake, LANGUAGES } = require('../src/fnol');

// The script must be in the caller's language, and the intake must understand the loss whichever language it arrived in.

test('a script exists in each language, and every one has every question', () => {
  for (const language of LANGUAGES) {
    const script = buildScript(language);
    assert.equal(script.fallback, false);
    assert.equal(script.questions.length, 5, 'five questions in ' + language);
    for (const q of script.questions) assert.ok(q.trim().length > 3);
  }
  assert.equal(buildScript('hi').greeting.includes('धन्यवाद'), true, 'the Hindi greeting is Hindi');
});

test('an unsupported language falls back to English visibly, saying which was asked for', () => {
  const script = buildScript('ta');
  assert.equal(script.language, 'en');
  assert.equal(script.fallback, true);
  assert.equal(script.requested, 'ta');
});

test('a Hindi transcript yields the cause, an injury and the amount', () => {
  const result = intake({ language: 'hi', transcript: 'कल रात आग लगी, कोई चोट नहीं, मरम्मत 45,000 रुपये है.' });
  assert.equal(result.language, 'hi');
  assert.equal(result.found.cause, 'fire');
  assert.equal(result.found.amount, 45000);
  assert.equal(result.reserve.proposed, true);
  assert.equal(result.draft.cause, 'fire');
});

test('a Telugu transcript yields the cause and flags the missing amount as a gap', () => {
  const result = intake({ language: 'te', transcript: 'మా ఇంట్లో నీరు చేరింది, ఎవరికైనా గాయం అయింది.' });
  assert.equal(result.found.cause, 'water');
  assert.equal(result.found.injuries, true);
  assert.equal(result.found.amount, null);
  assert.equal(result.reserve.proposed, false);
  assert.match(result.reserve.reason, /No amount was stated/);
  assert.ok(result.missing.includes('amount'));
});

test('an English transcript still works, and an empty one lists its gaps', () => {
  const english = intake({ language: 'en', transcript: 'Theft at the shop last night, estimate Rs. 1,25,000.' });
  assert.equal(english.found.cause, 'theft');
  assert.equal(english.found.amount, 125000);
  const empty = intake({ transcript: '' });
  assert.deepEqual(empty.missing.sort(), ['amount', 'cause']);
  assert.equal(empty.reserve.proposed, false);
});
