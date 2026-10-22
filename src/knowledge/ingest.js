'use strict';
// Turning a wording into chunks: structure-aware, metadata-carrying, and published all-or-nothing.
//
// Why structure first: an answer must cite "HO-1.2, page 2", so a chunk may never straddle two clauses. Splitting on
// headings keeps the heading path and clause number that the citation needs; only a clause longer than the limit is
// cut further, and then on paragraph boundaries.
//
// Why publish atomically: a half-indexed version would answer questions from a document that is not current. If any
// embedding fails, the transaction rolls back and the previous version stays current.

const TOKENS_PER_WORD = 1.35;
const MAX_TOKENS = 800;
const MAX_CHUNK_CHARS = 3000; // used only to estimate page numbers for a plain-text source

function estimateTokens(text) {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.ceil(words * TOKENS_PER_WORD));
}

function pageAt(offset) {
  return 1 + Math.floor(offset / MAX_CHUNK_CHARS);
}

// Split a clause body that is too long, on paragraph boundaries, into pieces under the token limit.
function splitLong(body, limit = MAX_TOKENS) {
  if (estimateTokens(body) <= limit) return [body];
  const paragraphs = body.split(/\n{2,}/).filter((p) => p.trim());
  const parts = [];
  let current = '';
  for (const paragraph of paragraphs) {
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (estimateTokens(candidate) > limit && current) {
      parts.push(current);
      current = paragraph;
    } else {
      current = candidate;
    }
  }
  if (current) parts.push(current);
  return parts.flatMap((part) => (estimateTokens(part) > limit ? splitByWords(part, limit) : [part]));
}

function splitByWords(text, limit) {
  const words = text.split(/\s+/).filter(Boolean);
  const perPiece = Math.floor(limit / TOKENS_PER_WORD);
  const pieces = [];
  for (let i = 0; i < words.length; i += perPiece) pieces.push(words.slice(i, i + perPiece).join(' '));
  return pieces;
}

/**
 * Split a wording by its structure.
 * Returns [{ text, headingPath, clause, page }] where headingPath is "Section 1 > HO-1.2".
 */
function splitByStructure(text) {
  const lines = text.split('\n');
  const chunks = [];
  let section = null;
  let clause = null;
  let body = [];
  let offset = 0;
  let clauseOffset = 0;

  const flush = () => {
    const joined = body.join('\n').trim();
    body = [];
    if (!joined) return;
    // Text before the first section (title, notice) is not citable: it has no clause and no heading path.
    if (!section) return;
    const headingPath = [section, clause].filter(Boolean).join(' > ');
    for (const part of splitLong(joined)) {
      chunks.push({ text: part, headingPath, clause, page: pageAt(clauseOffset) });
    }
  };

  for (const line of lines) {
    const sectionMatch = /^##\s+(Section\s+\d+\.[^#]*)$/.exec(line.trim());
    const clauseMatch = /^###\s+([A-Z]{2}-\d+\.\d+)\s+(.*)$/.exec(line.trim());
    if (sectionMatch) {
      flush();
      section = sectionMatch[1].trim();
      clause = null;
      clauseOffset = offset;
    } else if (clauseMatch) {
      flush();
      clause = clauseMatch[1];
      clauseOffset = offset;
    } else {
      body.push(line);
    }
    offset += line.length + 1;
  }
  flush();
  return chunks;
}

/**
 * Ingest one version of a document.
 *
 * @param {object} options
 * @param {object} options.store      adapter from src/knowledge/store.js
 * @param {(texts: string[]) => Promise<number[][]>} options.embedder  injected; a fake in tests
 * @param {string} options.embedModel  model name stored on every chunk
 * @param {{id: string, title: string, source: string}} options.document
 * @param {{id: string, version: number, validFrom: string}} options.version
 * @param {string} options.text
 * @param {object} options.metadata   audience, product, language, sensitivity, validFrom
 * @returns {Promise<object>} the KnowledgeIndexed result (event wiring comes later)
 */
async function ingestVersion({ store, embedder, embedModel, document, version, text, metadata }) {
  const meta = {
    audience: metadata.audience,
    product: metadata.product || null,
    language: metadata.language || 'en',
    sensitivity: metadata.sensitivity || 'internal',
    validFrom: metadata.validFrom || version.validFrom,
  };
  if (!meta.audience) throw new Error('metadata.audience is required: the access filter depends on it');

  const parts = splitByStructure(text);
  if (!parts.length) throw new Error('the wording produced no chunks');

  // Embed first: a failure here must leave the store untouched, so it happens before any write.
  const embedText = (part) => [part.clause, part.headingPath ? String(part.headingPath).split('>').pop().trim() : null, part.text]
    .filter(Boolean).join(' - ');
  const vectors = await embedder(parts.map(embedText));
  if (!Array.isArray(vectors) || vectors.length !== parts.length) {
    throw new Error(`embedder returned ${vectors && vectors.length} vectors for ${parts.length} chunks`);
  }

  const chunks = parts.map((part, index) => ({
    id: `${version.id}-c${index + 1}`,
    versionId: version.id,
    documentId: document.id,
    headingPath: part.headingPath,
    clause: part.clause,
    context: part.clause ? `${part.clause} in "${part.headingPath}" of the ${meta.product || 'policy'} wording.` : null,
    page: part.page,
    text: part.text,
    audience: meta.audience,
    product: meta.product,
    language: meta.language,
    sensitivity: meta.sensitivity,
    embedModel,
    embedding: vectors[index],
    validFrom: meta.validFrom,
    validTo: null,
  }));

  const publishedAt = new Date().toISOString();
  store.transaction(() => {
    store.addDocument({ id: document.id, title: document.title, source: document.source });
    store.addVersion({
      id: version.id,
      documentId: document.id,
      version: version.version,
      validFrom: version.validFrom,
    });
    for (const chunk of chunks) store.addChunk(chunk);
    store.publishVersion(document.id, version.id, publishedAt);
  });

  return {
    event: 'KnowledgeIndexed',
    documentId: document.id,
    versionId: version.id,
    version: version.version,
    chunks: chunks.length,
    embedModel,
    publishedAt,
  };
}

module.exports = { ingestVersion, splitByStructure, estimateTokens, splitLong };
