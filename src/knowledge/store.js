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
CREATE TABLE IF NOT EXISTS ingestion_runs (
  id TEXT PRIMARY KEY, agent TEXT NOT NULL, versions INTEGER, chunks INTEGER,
  model TEXT, ok INTEGER NOT NULL, error TEXT, duration_ms INTEGER, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS query_log (
  id TEXT PRIMARY KEY, user_id TEXT, role TEXT, audience TEXT, question TEXT NOT NULL,
  status TEXT, citations TEXT, latency_ms INTEGER, created_at TEXT NOT NULL
);
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

    logQuery({ id, userId, role, audience, question, status, citations, latencyMs, createdAt = new Date().toISOString() }) {
      db.prepare(`INSERT INTO query_log (id, user_id, role, audience, question, status, citations, latency_ms, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        id, userId || null, role || null, audience || null, question, status || null,
        JSON.stringify(citations || []), latencyMs ?? null, createdAt,
      );
      return id;
    },

    getQueryLog: (limit = 20) => db.prepare('SELECT * FROM query_log ORDER BY created_at DESC LIMIT ?').all(limit),

    // Reindex support: which versions still carry another model, their chunks, and a way to rewrite one embedding.
    staleVersions(currentModel) {
      return db.prepare(
        'SELECT version_id AS versionId, COUNT(*) AS chunks FROM chunks WHERE embed_model <> ? GROUP BY version_id',
      ).all(currentModel);
    },

    chunksForVersion(versionId) {
      return db.prepare('SELECT * FROM chunks WHERE version_id = ? ORDER BY id').all(versionId);
    },

    updateChunkEmbedding(id, embedding, embedModel) {
      db.prepare('UPDATE chunks SET embedding = ?, embed_model = ? WHERE id = ?')
        .run(JSON.stringify(embedding), embedModel, id);
    },

    logRun({ agent, versions, chunks, model, ok, error, durationMs, createdAt = new Date().toISOString() }) {
      const id = require('node:crypto').randomUUID();
      db.prepare(`INSERT INTO ingestion_runs (id, agent, versions, chunks, model, ok, error, duration_ms, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        id, agent, versions ?? null, chunks ?? null, model || null, ok ? 1 : 0, error || null, durationMs ?? null, createdAt,
      );
      return id;
    },

    getRuns: (limit = 20) => db.prepare('SELECT * FROM ingestion_runs ORDER BY created_at DESC LIMIT ?').all(limit),

    // Everything the admin screen shows, in one call: documents, their versions with chunk counts and models, and
    // the last runs. Kept here so the screen has no SQL of its own.
    adminOverview(runLimit = 10) {
      const documents = db.prepare('SELECT id, title, source, created_at FROM documents ORDER BY created_at DESC').all();
      const versions = db.prepare(`
        SELECT v.id, v.document_id, v.version, v.valid_from, v.valid_to,
               COUNT(c.id) AS chunks, GROUP_CONCAT(DISTINCT c.embed_model) AS models
        FROM document_versions v LEFT JOIN chunks c ON c.version_id = v.id
        GROUP BY v.id ORDER BY v.valid_from DESC`).all();
      return { documents, versions, runs: db.prepare('SELECT * FROM ingestion_runs ORDER BY created_at DESC LIMIT ?').all(runLimit) };
    },

    getChunk: (id) => db.prepare('SELECT * FROM chunks WHERE id = ?').get(id),
    getVersion: (id) => db.prepare('SELECT * FROM document_versions WHERE id = ?').get(id),

    // Cosine similarity in JS for R0's corpus size; sqlite-vec replaces this at R1 without changing callers.
    searchVector(queryVector, { embedModel, limit = 10, filters = null } = {}) {
      const rows = db.prepare('SELECT * FROM chunks').all().filter((row) => matchesFilters(row, filters));
      const wrong = rows.find((r) => r.embed_model !== embedModel);
      if (wrong) {
        throw new Error(`refusing to compare embeddings: index has ${wrong.embed_model}, query is ${embedModel}`);
      }
      return rows
        .map((row) => ({ ...row, score: cosine(queryVector, JSON.parse(row.embedding)) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
    },

    searchKeyword(term, { limit = 10, filters = null } = {}) {
      const rows = db.prepare('SELECT * FROM chunks WHERE text LIKE ? OR context LIKE ? LIMIT ?')
        .all(`%${term}%`, `%${term}%`, limit * 5);
      return rows.filter((row) => matchesFilters(row, filters)).slice(0, limit);
    },
  };
}

// Filters run before scoring, not after: a passage the person may not see must never influence the ranking, or its
// presence would leak through which clause was cited.
function matchesFilters(row, filters) {
  if (!filters) return true;
  if (Array.isArray(filters.audiences) && !filters.audiences.includes(row.audience)) return false;
  if (filters.asOf) {
    if (row.valid_from && String(row.valid_from) > String(filters.asOf)) return false;
    if (row.valid_to && String(row.valid_to) <= String(filters.asOf)) return false;
  }
  return true;
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i += 1) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

module.exports = { openKnowledgeStore, cosine, matchesFilters, SCHEMA };
