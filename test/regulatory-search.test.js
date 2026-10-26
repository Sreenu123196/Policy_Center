'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRegulatorySearch } = require('../src/regulatory');
const { ENTRIES } = require('../src/regulatoryCorpus');

// The guarantee: the excerpt is copied from the corpus, never composed. And when nothing matches, the answer is "no result" rather than
// the nearest plausible rule.

const search = createRegulatorySearch();

test('a question about settlement finds the settlement rule, cited, with the sentence copied', () => {
  const result = search.search({ query: 'how many days to settle a claim' });
  assert.equal(result.found, true);
  assert.equal(result.results[0].id, 'REG-CLM-001');
  assert.match(result.results[0].excerpt, /thirty days/);
  const entry = ENTRIES.find((e) => e.id === 'REG-CLM-001');
  assert.ok(entry.text.includes(result.results[0].excerpt), 'the excerpt appears verbatim in the corpus');
});

test('a question about mandate notice finds that rule, not the settlement one', () => {
  const result = search.search({ query: 'notice before electronic mandate debit' });
  assert.equal(result.results[0].id, 'REG-MND-001');
  assert.match(result.results[0].excerpt, /twenty-four hours/);
});

test('an unrelated question abstains rather than guessing', () => {
  const result = search.search({ query: 'what is the weather in Hyderabad tomorrow' });
  assert.equal(result.found, false);
  assert.deepEqual(result.results, []);
});

test('every result is verbatim, and every entry is labelled illustrative', () => {
  for (const entry of ENTRIES) {
    const result = search.search({ query: entry.title, limit: 5 });
    assert.equal(result.found, true, 'the title finds its own entry: ' + entry.title);
    assert.ok(entry.text.includes(result.results[0].excerpt), 'verbatim for ' + entry.id);
    assert.equal(result.results[0].illustrative, true, 'marked illustrative so no screen can present it as law');
  }
});

test('an empty query is refused, and a limit is respected', () => {
  assert.throws(() => search.search({ query: '   ' }), /q is required/);
  const result = search.search({ query: 'claim days notice customer', limit: 2 });
  assert.ok(result.results.length <= 2);
});
