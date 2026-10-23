'use strict';
// Simulated e-sign.
//
// A signature is bound to the document's bytes, not to a filename: the record stores a hash of what was signed, so a signed
// PDF cannot be swapped for another and still look signed. The provider is simulated; the binding is the part that matters,
// and it is the part a real provider would also give us.

const crypto = require('node:crypto');
const { AppError } = require('./appError');

const CONSENT_TEXT = 'I have read the document identified above and I agree to sign it electronically.';

function hashDocument(bytes) {
  if (!bytes) throw new AppError(422, 'the document is required');
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function createSignatures(store) {
  const records = () => {
    store.data.signatures = store.data.signatures || [];
    return store.data.signatures;
  };

  /**
   * @param {{signer: object, document: Buffer|string, documentRef: string, consent?: string}} input
   */
  function sign({ signer, document, documentRef, consent }) {
    if (!signer || !signer.id) throw new AppError(422, 'a signer is required');
    if (!documentRef) throw new AppError(422, 'a document reference is required');
    const hash = hashDocument(document);
    const existing = records().find((r) => r.documentHash === hash && r.signerId === signer.id && r.status === 'signed');
    if (existing) return existing; // signing the same bytes twice is not a second signature
    const record = {
      id: 'SIG-' + String(store.next('signature')).padStart(7, '0'),
      documentRef,
      documentHash: hash,
      signerId: signer.id,
      signerRole: signer.role || null,
      consent: consent || CONSENT_TEXT,
      status: 'signed',
      signedAt: new Date().toISOString(),
    };
    records().push(record);
    return record;
  }

  /** Is this document signed by anyone whose signature is still valid for these bytes? */
  function check(document, { documentRef = null } = {}) {
    const hash = hashDocument(document);
    const found = records().filter((r) => r.documentHash === hash && r.status === 'signed');
    return {
      signed: found.length > 0,
      signatures: found,
      // A reference that was signed but whose bytes no longer match is reported as unsigned, not as signed-then-changed.
      stale: documentRef ? records().filter((r) => r.documentRef === documentRef && r.documentHash !== hash) : [],
    };
  }

  /** The gate an issue step calls: no signature for these bytes, no issue. */
  function requireSigned(document, options = {}) {
    const result = check(document, options);
    if (!result.signed) throw new AppError(403, 'This document has not been signed');
    return result;
  }

  return { sign, check, requireSigned, CONSENT_TEXT };
}

module.exports = { createSignatures, hashDocument, CONSENT_TEXT };
