'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSignatures, hashDocument } = require('../src/esign');

// The provider is simulated; the binding is not. A signature covers the bytes, so an altered document cannot inherit one.

const freshStore = () => ({ data: { signatures: [], seq: {} }, next(n) { this.data.seq[n] = (this.data.seq[n] || 0) + 1; return this.data.seq[n]; } });
const PDF = Buffer.from('%PDF-1.4 policy schedule, premium 11800');
const ALTERED = Buffer.from('%PDF-1.4 policy schedule, premium 1180');

test('a signed document reports signed, with the signer recorded', () => {
  const store = freshStore();
  const esign = createSignatures(store);
  const record = esign.sign({ signer: { id: 'uwm', role: 'UW Manager' }, document: PDF, documentRef: 'PA-0000001' });
  assert.equal(record.status, 'signed');
  assert.equal(record.signerId, 'uwm');
  assert.equal(record.documentHash, hashDocument(PDF));
  assert.match(record.consent, /agree to sign it electronically/);
  assert.equal(esign.check(PDF).signed, true);
});

test('an altered document is not signed, and the signature it had is reported stale', () => {
  const store = freshStore();
  const esign = createSignatures(store);
  esign.sign({ signer: { id: 'uwm' }, document: PDF, documentRef: 'PA-0000001' });
  const result = esign.check(ALTERED, { documentRef: 'PA-0000001' });
  assert.equal(result.signed, false, 'the signature does not carry over to different bytes');
  assert.equal(result.stale.length, 1, 'the earlier signature is reported as stale, not hidden');
});

test('the gate refuses an unsigned document and passes a signed one', () => {
  const store = freshStore();
  const esign = createSignatures(store);
  assert.throws(() => esign.requireSigned(PDF, { documentRef: 'PA-1' }), /has not been signed/);
  esign.sign({ signer: { id: 'uwm' }, document: PDF, documentRef: 'PA-1' });
  assert.equal(esign.requireSigned(PDF, { documentRef: 'PA-1' }).signed, true);
});

test('signing the same bytes twice returns the first signature rather than a second one', () => {
  const store = freshStore();
  const esign = createSignatures(store);
  const first = esign.sign({ signer: { id: 'uwm' }, document: PDF, documentRef: 'PA-1' });
  const again = esign.sign({ signer: { id: 'uwm' }, document: PDF, documentRef: 'PA-1' });
  assert.equal(again.id, first.id);
  assert.equal(esign.check(PDF).signatures.length, 1);
});

test('a different signer on the same document is a separate signature, and missing input is refused', () => {
  const store = freshStore();
  const esign = createSignatures(store);
  esign.sign({ signer: { id: 'uwm' }, document: PDF, documentRef: 'PA-1' });
  esign.sign({ signer: { id: 'uw' }, document: PDF, documentRef: 'PA-1' });
  assert.equal(esign.check(PDF).signatures.length, 2);
  assert.throws(() => esign.sign({ document: PDF, documentRef: 'PA-1' }), /signer is required/);
  assert.throws(() => esign.sign({ signer: { id: 'x' }, document: PDF }), /document reference is required/);
});
