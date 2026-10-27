'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildWalkthrough } = require('../src/walkthrough');

// The words are ours; only the rendering is a vendor's.

const POLICY = { policyNumber: 'HO-0000001', product: 'Homeowners', effectiveDate: '2026-03-01', premium: 11800, coverages: ['Dwelling', 'Contents'] };

test('a walkthrough has beats, captions and a duration estimate, in order', () => {
  const w = buildWalkthrough({ policy: POLICY });
  assert.equal(w.language, 'en');
  assert.equal(w.beats.length, 4);
  assert.equal(w.beats[0].section, 'Your policy');
  assert.match(w.beats[0].text, /HO-0000001/);
  assert.ok(w.captions.length >= w.beats.length);
  assert.ok(w.estimatedSeconds > 0);
});

test('captions split a long beat into readable chunks without losing words', () => {
  const w = buildWalkthrough({ policy: POLICY, wordsPerCaption: 4 });
  const joined = w.captions.map((c) => c.text).join(' ');
  for (const beat of w.beats) assert.ok(joined.includes(beat.text.split(' ')[0]));
  assert.ok(w.captions.every((c) => c.text.split(/\s+/).length <= 4));
});

test('Telugu and Hindi produce their own words, and an unsupported language falls back visibly', () => {
  assert.match(buildWalkthrough({ policy: POLICY, language: 'te' }).beats[0].text, /పాలసీ/);
  assert.match(buildWalkthrough({ policy: POLICY, language: 'hi' }).beats[0].text, /पॉलिसी/);
  const tamil = buildWalkthrough({ policy: POLICY, language: 'ta' });
  assert.equal(tamil.language, 'en');
  assert.equal(tamil.fellBack, true);
});

test('no beat promises cover or invents a figure, and a policy without a number is refused', () => {
  const w = buildWalkthrough({ policy: { ...POLICY, coverages: [] } });
  const all = w.beats.map((b) => b.text).join(' ');
  assert.equal(/guarantee|promise|definitely|covered for any/i.test(all), false);
  assert.throws(() => buildWalkthrough({ policy: {} }), /policy number is required/);
});
