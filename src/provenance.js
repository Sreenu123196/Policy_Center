'use strict';
// B27: provenance for a document we issued.
//
// A vendor's content credential is an attestation by a certificate authority that a file came from a particular organisation. The part that can be built here is the part that matters
// technically: a manifest that names the document, its hash and the generator, signed with a key we hold, so an altered file fails verification rather than merely looking different.

const crypto = require('node:crypto');
const { AppError } = require('./appError');

const MANIFEST_VERSION = 1;

function digestOf(bytes) {
  if (bytes === undefined || bytes === null) throw new AppError(422, 'the document is required');
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

/**
 * @param {{document: Buffer|string, documentId: string, generator?: string, issuer: string, signedAt?: string, key: string}} input
 */
function signManifest({ document, documentId, generator = 'policycenter-sim', issuer, signedAt = new Date().toISOString(), key } = {}) {
  if (!documentId) throw new AppError(422, 'a document id is required');
  if (!issuer) throw new AppError(422, 'an issuer is required');
  if (!key) throw new AppError(500, 'a signing key is required');
  const manifest = { version: MANIFEST_VERSION, documentId, digest: digestOf(document), generator, issuer, signedAt };
  const signature = crypto.createHmac('sha256', key).update(JSON.stringify(manifest)).digest('hex');
  return { manifest, signature, algorithm: 'hmac-sha256' };
}

/** Verification recomputes the digest from the file it is given, so a manifest cannot be moved to another document. */
function verifyManifest({ manifest, signature, document, key } = {}) {
  if (!manifest || !signature) return { valid: false, reason: 'a manifest and its signature are required' };
  if (!key) throw new AppError(500, 'a signing key is required');
  const expected = crypto.createHmac('sha256', key).update(JSON.stringify(manifest)).digest('hex');
  if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) return { valid: false, reason: 'the signature does not match the manifest' };
  if (document !== undefined) {
    const digest = digestOf(document);
    if (digest !== manifest.digest) return { valid: false, reason: 'the document has changed since it was signed' };
  }
  return { valid: true, reason: 'the manifest is signed and the document matches', manifest };
}

module.exports = { signManifest, verifyManifest, digestOf, MANIFEST_VERSION };
