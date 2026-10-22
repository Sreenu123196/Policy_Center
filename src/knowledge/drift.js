'use strict';
// Drift: a document changed and the index did not.
//
// Ingest records the hash of the text it indexed; the nightly job re-reads each registered source, hashes it the same
// way and compares. The hash normalises line endings, collapses runs of spaces and trims, so a whitespace-only edit is
// not reported - only a change to the words is.
//
// Where a source comes from is the only part that differs between this project and production: here it is a file path
// (or the text itself, for tests); in production it is whatever the content repository exposes.

const fs = require('node:fs');
const crypto = require('node:crypto');

function hashText(text) {
  return crypto.createHash('sha256')
    .update(String(text).replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').trim())
    .digest('hex');
}

/**
 * @param {{store: object, sources: Array<{documentId: string, path?: string, text?: string}>}} options
 * @returns {{checked: number, drifted: string[], rows: Array<{documentId: string, status: string}>}}
 */
function checkDrift({ store, sources }) {
  const rows = [];
  const drifted = [];
  for (const source of sources) {
    const text = source.text !== undefined ? source.text : fs.readFileSync(source.path, 'utf8');
    const stored = store.currentVersionHash(source.documentId);
    const status = !stored ? 'not-indexed' : (stored === hashText(text) ? 'current' : 'changed');
    if (status !== 'current') drifted.push(source.documentId);
    rows.push({ documentId: source.documentId, status });
  }
  return { checked: sources.length, drifted, rows };
}

module.exports = { checkDrift, hashText };
