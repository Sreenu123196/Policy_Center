'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizePath } = require('../src/paths');

// The design names routes /v1/...; the application registers them unprefixed. One normalisation keeps both spellings
// working without a second route table, a second set of matrix rows or a second OpenAPI contract.

test('the version and api prefixes are removed', () => {
  assert.equal(normalizePath('/v1/policies'), '/policies');
  assert.equal(normalizePath('/api/policies'), '/policies');
  assert.equal(normalizePath('/api/v1/policies'), '/policies');
  assert.equal(normalizePath('/v1/knowledge/ask'), '/knowledge/ask');
});

test('unprefixed paths are untouched, including ones that merely start with the letters', () => {
  assert.equal(normalizePath('/policies'), '/policies');
  assert.equal(normalizePath('/v10/thing'), '/v10/thing');
  assert.equal(normalizePath('/apiary'), '/apiary');
});

test('an empty path becomes the root', () => {
  assert.equal(normalizePath(''), '/');
  assert.equal(normalizePath('/api'), '/');
  assert.equal(normalizePath('/v1'), '/');
});
