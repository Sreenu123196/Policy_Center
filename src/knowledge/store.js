'use strict';
// SQLite store for the Knowledge Assistant, behind a small adapter so pgvector can replace it.
// Schema follows Appendix A of the design: filters (audience, dates) exist from R0 even though retrieval uses
// them only from R2, so no migration is needed later. Every chunk records the embedding model that produced its
// vector: comparisons across models are refused rather than silently wrong.

const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, source TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS document_versions (
  id TEXT PRIMARY KEY, document_id TEXT NOT NULL, version INTEGER NOT NULL,
  valid_from TEXT NOT NULL, valid_to TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS chunks (
  id TEXT PRIMARY KEY, version_id TEXT NOT NULL, document_id TEXT NOT NULL,
  heading_path TEXT, clause TEXT, page INTEGER, text TEXT NOT NULL, context TEXT,
  audience TEXT NOT NULL, product TEXT, language TEXT NOT NULL DEFAULT 'en',
  sensitivity TEXT NOT NULL DEFAULT 'internal',
  embed_model TEXT NOT NULL, embedding TEXT NOT NULL,
  valid_from TEXT NOT NULL, valid_to TEXT
);
CREATE INDEX IF NOT EXISTS chunks_model ON chunks(embed_model);
`;

function openKnowledgeStore(file) {
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  return {
    close: () => db.close(),

    // One unit of work for an ingest: either the whole version lands or none of it does.
    transaction(fn) {
      db.exec('BEGIN');
      try {
        const result = fn();
        db.exec('COMMIT');
        return result;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },

    countChunks(versionId) {
      return db.prepare('SELECT COUNT(*) AS n FROM chunks WHERE version_id = ?').get(versionId).n;
    },

    addDocument({ id, title, source, createdAt = new Date().toISOString() }) {
      db.prepare('INSERT OR IGNORE INTO documents (id, title, source, created_at) VALUES (?, ?, ?, ?)').run(id, title, source, createdAt);
      return id;
    },

    addVersion({ id, documentId, version, validFrom, validTo = null, createdAt = new Date().toISOString() }) {
      db.prepare('INSERT INTO document_versions (id, document_id, version, valid_from, valid_to, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, documentId, version, validFrom, validTo, createdAt);
      return id;
    },

    // Publishing a version retires the previous one: the old version keeps its history but stops being current.
    publishVersion(documentId, versionId, publishedAt) {
      db.prepare('UPDATE document_versions SET valid_to = ? WHERE document_id = ? AND id <> ? AND valid_to IS NULL')
        .run(publishedAt, documentId, versionId);
      return db.prepare('SELECT * FROM document_versions WHERE id = ?').get(versionId);
    },

    addChunk(chunk) {
      db.prepare(`INSERT INTO chunks (id, version_id, document_id, heading_path, clause, page, text, context,
        audience, product, language, sensitivity, embed_model, embedding, valid_from, valid_to)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        chunk.id, chunk.versionId, chunk.documentId, chunk.headingPath || null, chunk.clause || null,
        chunk.page ?? null, chunk.text, chunk.context || null, chunk.audience,
        chunk.product || null, chunk.language || 'en', chunk.sensitivity || 'internal',
        chunk.embedModel, JSON.stringify(chunk.embedding), chunk.validFrom, chunk.validTo || null,
      );
      return chunk.id;
    },

    getChunk: (id) => db.prepare('SELECT * FROM chunks WHERE id = ?').get(id),
    getVersion: (id) => db.prepare('SELECT * FROM document_versions WHERE id = ?').get(id),

    // Cosine similarity in JS for R0's corpus size; sqlite-vec replaces this at R1 without changing callers.
    searchVector(queryVector, { embedModel, limit = 10 } = {}) {
      const rows = db.prepare('SELECT * FROM chunks').all();
      const wrong = rows.find((r) => r.embed_model !== embedModel);
      if (wrong) {
        throw new Error(`refusing to compare embeddings: index has ${wrong.embed_model}, query is ${embedModel}`);
      }
      return rows
        .map((row) => ({ ...row, score: cosine(queryVector, JSON.parse(row.embedding)) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
    },

    searchKeyword(term, { limit = 10 } = {}) {
      return db.prepare('SELECT * FROM chunks WHERE text LIKE ? LIMIT ?').all(`%${term}%`, limit);
    },
  };
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i += 1) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

module.exports = { openKnowledgeStore, cosine, SCHEMA };
