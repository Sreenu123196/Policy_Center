'use strict';
// One entry point for asking a question, used by the API route and by the chatbot tool.
//
// Order matters and is deliberate: derive the audience from the signed-in user, filter candidates before ranking, ask,
// then log the masked question with the outcome. Every dependency is injected, so the whole path can be tested without
// a network and without a real model.

const { randomUUID } = require('node:crypto');
const { hybridSearch } = require('./retrieve');
const { answerQuestion } = require('./answer');
const { filtersForUser } = require('./access');
const { safeQuery } = require('./mask');

const DEFAULT_LIMIT = 8;

/**
 * @param {object} deps
 * @param {object} deps.store       knowledge store adapter
 * @param {string} deps.embedModel  model the index was built with
 * @param {(texts: string[]) => Promise<number[][]>} deps.embedder
 * @param {{messages: {create: Function}}} deps.client  Claude (a fake in tests)
 * @returns {{ask: Function, search: Function}}
 */
function createKnowledgeService({ store, embedModel, embedder, client, documentEmbedder = null }) {
  /**
   * Retrieve, answer, log.
   * @param {{id?: string, role: string}} user
   * @param {string} question
   * @param {{asOf?: string, language?: string, limit?: number}} [options]
   */
  async function ask(user, question, { asOf = null, language = 'en', limit = DEFAULT_LIMIT } = {}) {
    const started = Date.now();
    const filters = filtersForUser(user, { asOf });
    const [vector] = await embedder([question]);
    const candidates = hybridSearch({
      store, embedModel, queryVector: vector, queryText: question, limit, filters,
    });

    const result = await answerQuestion({ client, question, passages: candidates, language });

    const logged = safeQuery(question);
    store.logQuery({
      id: randomUUID(),
      userId: user && user.id,
      role: user && user.role,
      audience: filters.audiences.join(','),
      question: logged.masked,
      status: result.status,
      citations: result.citations,
      latencyMs: Date.now() - started,
    });

    return {
      status: result.status,
      answer: result.answer,
      citations: result.citations.map((number) => ({
        number,
        clause: candidates[number - 1] ? candidates[number - 1].clause : null,
        headingPath: candidates[number - 1] ? candidates[number - 1].headingPath : null,
        page: candidates[number - 1] ? candidates[number - 1].page : null,
      })),
      passages: candidates.map((row, index) => ({
        number: index + 1, clause: row.clause, headingPath: row.headingPath, page: row.page,
      })),
      attempts: result.attempts,
    };
  }

  /** Retrieval without an answer: used by the admin screen and by the chatbot's search tool. */
  async function search(user, question, { asOf = null, limit = DEFAULT_LIMIT } = {}) {
    const filters = filtersForUser(user, { asOf });
    const [vector] = await embedder([question]);
    return hybridSearch({ store, embedModel, queryVector: vector, queryText: question, limit, filters })
      .map((row, index) => ({
        number: index + 1, id: row.id, clause: row.clause, headingPath: row.headingPath,
        page: row.page, audience: row.audience, text: row.text.slice(0, 400),
      }));
  }

  /**
   * Re-embed every chunk whose model is not the current one. One transaction per version: a version either moves to the
   * new model whole or stays on the old one, so a half-migrated version can never answer.
   */
  async function reindex() {
    const started = Date.now();
    const embedForDocument = documentEmbedder || embedder;
    const stale = store.staleVersions(embedModel);
    let chunks = 0;

    for (const entry of stale) {
      const rows = store.chunksForVersion(entry.versionId);
      try {
        const vectors = await embedForDocument(rows.map((row) => row.text));
        if (!Array.isArray(vectors) || vectors.length !== rows.length) {
          throw new Error('embedder returned ' + (vectors && vectors.length) + ' vectors for ' + rows.length + ' chunks');
        }
        store.transaction(() => {
          rows.forEach((row, index) => store.updateChunkEmbedding(row.id, vectors[index], embedModel));
        });
        chunks += rows.length;
      } catch (err) {
        const durationMs = Date.now() - started;
        store.logRun({ agent: 'reindex', versions: stale.length, chunks, model: embedModel, ok: false, error: err.message, durationMs });
        return { versions: stale.length, chunks, model: embedModel, durationMs, ok: false, error: err.message };
      }
    }

    const durationMs = Date.now() - started;
    store.logRun({ agent: 'reindex', versions: stale.length, chunks, model: embedModel, ok: true, durationMs });
    return { versions: stale.length, chunks, model: embedModel, durationMs, ok: true };
  }

  return { ask, search, reindex };
}

module.exports = { createKnowledgeService };
