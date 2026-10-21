'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { maskText, safeQuery } = require('../src/knowledge/mask');

// Nothing that identifies a person may reach a log line. Each test is a shape that really appears in an Indian
// insurance conversation.

test('an Aadhaar number is masked, grouped or not', () => {
  assert.equal(maskText('Aadhaar 1234 5678 9012 please'), 'Aadhaar [AADHAAR] please');
  assert.equal(maskText('aadhaar 123456789012'), 'aadhaar [AADHAAR]');
});

test('a PAN is masked', () => {
  assert.equal(maskText('PAN is ABCDE1234F'), 'PAN is [PAN]');
});

test('a mobile number is masked with or without the country code', () => {
  assert.equal(maskText('call me on +91 98765 43210'), 'call me on [PHONE]');
  assert.equal(maskText('my number is 9876543210'), 'my number is [PHONE]');
  assert.equal(maskText('98765-43210 works'), '[PHONE] works');
});

test('a bank account number is masked', () => {
  // Fourteen digits: twelve ungrouped digits are ambiguous with an Aadhaar, and Aadhaar wins that tie on purpose.
  assert.equal(maskText('account 12345678901234'), 'account [ACCOUNT]');
});

test('an email address is masked', () => {
  assert.equal(maskText('write to asha.rao@example.com'), 'write to [EMAIL]');
});

test('a policy number and a clause number survive masking', () => {
  const text = 'Is PA-0000001 covered under HO-1.2?';
  assert.equal(maskText(text), text, 'a policy or clause number is not personal data');
});

test('safeQuery keeps the shape and drops the identifiers', () => {
  const result = safeQuery('My Aadhaar is 1234 5678 9012, is PA-0000001 covered?');
  assert.match(result.masked, /\[AADHAAR\]/);
  assert.equal(result.masked.includes('1234'), false);
  assert.match(result.masked, /PA-0000001/);
  assert.equal(result.length, 'short');
  assert.equal(result.maskedCount, 1);
});

test('a long question is truncated before it is stored', () => {
  const result = safeQuery('a'.repeat(900));
  assert.equal(result.masked.length, 500);
  assert.equal(result.length, 'long');
});
