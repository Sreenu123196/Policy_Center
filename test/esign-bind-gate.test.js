'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSignatures } = require('../src/esign');

// What the bind gate signs over: the job number and its quoted premium. The second test is the one that matters - if the premium
// changes, the signature no longer covers the thing being bound.

const freshStore = () => ({ data: { signatures: [], seq: {} }, next(n) { this.data.seq[n] = (this.data.seq[n] || 0) + 1; return this.data.seq[n]; } });
const documentFor = (job) => job.jobNumber + '|' + (job.quote && job.quote.premium !== undefined ? job.quote.premium : '');

const JOB = { jobNumber: 'J0000001', quote: { premium: 732.84 } };

test('an unsigned quote cannot bind, and signing it lets it through', () => {
  const store = freshStore();
  const esign = createSignatures(store);
  assert.throws(() => esign.requireSigned(documentFor(JOB), { documentRef: JOB.jobNumber }), /has not been signed/);
  esign.sign({ signer: { id: 'uwm', role: 'UW Manager' }, document: documentFor(JOB), documentRef: JOB.jobNumber });
  assert.equal(esign.requireSigned(documentFor(JOB), { documentRef: JOB.jobNumber }).signed, true);
});

test('a changed premium invalidates the signature, because the signed text changes with it', () => {
  const store = freshStore();
  const esign = createSignatures(store);
  esign.sign({ signer: { id: 'uwm' }, document: documentFor(JOB), documentRef: JOB.jobNumber });
  const requoted = { ...JOB, quote: { premium: 999.99 } };
  assert.throws(() => esign.requireSigned(documentFor(requoted), { documentRef: JOB.jobNumber }), /has not been signed/);
  const check = esign.check(documentFor(requoted), { documentRef: JOB.jobNumber });
  assert.equal(check.stale.length, 1, 'the signature on the old premium is reported as stale');
});
