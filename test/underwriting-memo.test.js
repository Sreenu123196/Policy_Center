'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildMemo } = require('../src/underwritingMemo');

// The memo is only useful if the three columns stay apart.

const FACTS = [
  { name: 'occupancy', value: 'owner-occupied', source: 'proposal form 3' },
  { name: 'construction', value: 'brick', source: 'survey 12 March' },
  { name: 'yearBuilt', value: 1998, source: 'municipal record' },
  { name: 'protectionClass', value: '2', source: 'ISO lookup' },
];

test('a complete file is ready, with facts sourced and assumptions grounded', () => {
  const memo = buildMemo({
    submission: 'HO-0000001',
    facts: FACTS,
    assumptions: [{ name: 'roofAge', value: 8, restsOn: 'yearBuilt' }],
  });
  assert.equal(memo.ready, true);
  assert.equal(memo.verdict, 'ready for decision');
  assert.equal(memo.assumptions[0].grounded, true);
  assert.equal(memo.facts.find((f) => f.name === 'yearBuilt').source, 'municipal record');
});

test('an assumption that rests on nothing is flagged, and the file is not ready', () => {
  const memo = buildMemo({ submission: 'HO-2', facts: FACTS, assumptions: [{ name: 'roofAge', value: 8 }] });
  assert.equal(memo.ready, false);
  assert.equal(memo.ungrounded.length, 1);
  assert.match(memo.ungrounded[0].reason, /names no fact/);
  assert.match(memo.verdict, /ungrounded assumption/);
});

test('an assumption resting on something that is not a fact is flagged', () => {
  const memo = buildMemo({ submission: 'HO-3', facts: FACTS, assumptions: [{ name: 'roofAge', value: 8, restsOn: 'inspection' }] });
  assert.equal(memo.ungrounded[0].reason, 'It rests on "inspection", which is not a fact in this file.');
});

test('a fact without a source is refused: it is an assumption wearing the wrong label', () => {
  assert.throws(() => buildMemo({ submission: 'HO-4', facts: [{ name: 'occupancy', value: 'rented' }] }), /no source/);
});

test('missing required items become open questions, and declared gaps are kept once', () => {
  const memo = buildMemo({ submission: 'HO-5', facts: [{ name: 'occupancy', value: 'rented', source: 'form' }], gaps: ['claimsHistory', 'occupancy'] });
  assert.ok(memo.gaps.includes('construction'));
  assert.ok(memo.gaps.includes('claimsHistory'));
  assert.equal(memo.gaps.filter((g) => g === 'occupancy').length, 0, 'occupancy is covered by a fact, so it is not a gap');
  assert.match(memo.verdict, /open question/);
});

test('a submission reference is required', () => {
  assert.throws(() => buildMemo({}), /submission reference is required/);
});
