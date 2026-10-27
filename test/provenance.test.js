'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { signManifest, verifyManifest } = require('../src/provenance');

// A manifest that cannot survive an edit is the point; a vendor adds the attestation that we are who we say we are.

const KEY = 'test-signing-key';
const DOC = Buffer.from('%PDF-1.4 policy schedule HO-0000001');

test('a signed manifest verifies against the document it names', () => {
  const signed = signManifest({ document: DOC, documentId: 'HO-0000001', issuer: 'PolicyCenter', key: KEY });
  const check = verifyManifest({ ...signed, document: DOC, key: KEY });
  assert.equal(check.valid, true);
  assert.equal(signed.manifest.digest.length, 64);
  assert.equal(signed.algorithm, 'hmac-sha256');
});

test('an altered document fails, and says the document changed', () => {
  const signed = signManifest({ document: DOC, documentId: 'HO-1', issuer: 'PolicyCenter', key: KEY });
  const check = verifyManifest({ ...signed, document: Buffer.from('%PDF-1.4 premium 1'), key: KEY });
  assert.equal(check.valid, false);
  assert.match(check.reason, /changed since it was signed/);
});

test('a tampered manifest fails even with the original document', () => {
  const signed = signManifest({ document: DOC, documentId: 'HO-1', issuer: 'PolicyCenter', key: KEY });
  const tampered = { ...signed.manifest, issuer: 'Somebody Else' };
  const check = verifyManifest({ manifest: tampered, signature: signed.signature, document: DOC, key: KEY });
  assert.equal(check.valid, false);
  assert.match(check.reason, /signature does not match/);
});

test('the wrong key does not verify, and a missing key is refused', () => {
  const signed = signManifest({ document: DOC, documentId: 'HO-1', issuer: 'PolicyCenter', key: KEY });
  assert.equal(verifyManifest({ ...signed, document: DOC, key: 'other' }).valid, false);
  assert.throws(() => signManifest({ document: DOC, documentId: 'x', issuer: 'y' }), /signing key is required/);
});
