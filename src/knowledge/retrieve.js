'use strict';
// Retrieval: two independent rankings, fused by reciprocal rank.
//
// Why hybrid: vector search answers "what is this about" and misses exact tokens (a clause number, "2,500", "30 days");
// keyword search does the opposite. R0 was vector-only and eight of twenty answerable questions never retrieved their
// clause. Fusing the two lists with 1/(60+rank) is the cheapest fix that does not need a model.
//
// The reranker and the audience/date filters are separate steps, added next; they take the fused list, so nothing here
// needs to change when they arrive.

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'are', 'was', 'were', 'what', 'when', 'where', 'which', 'who', 'how', 'does', 'do', 'did',
  'can', 'could', 'should', 'would', 'with', 'from', 'this', 'that', 'these', 'those', 'there', 'their', 'have',
  'has', 'had', 'under', 'over', 'into', 'about', 'any', 'all', 'your', 'you', 'our', 'its', 'not', 'but', 'than',
  'then', 'them', 'they', 'will', 'shall', 'may', 'might', 'must', 'mich', 'much', 'many', 'more', 'most',
]);

const RRF_K = 60;

function tokenize(text) {
  return [...new Set(String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 2 && !STOP_WORDS.has(word)))];
}

/** Reciprocal rank fusion over ranked id lists: score = sum of 1/(k + rank). */
function fuse(lists, { k = RRF_K } = {}) {
  const scores = new Map();
  for (const list of lists) {
    list.forEach((id, index) => {
      scores.set(id, (scores.get(id) || 0) + 1 / (k + index + 1));
    });
  }
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
    .map(([id, score]) => ({ id, score }));
}

/**
 * Hybrid search.
 *
 * @param {object} options
 * @param {object} options.store
 * @param {string} options.embedModel  the model the index was built with; vector search refuses a mismatch
 * @param {number[]} [options.queryVector]  omitted in keyword-only mode
 * @param {string} options.queryText
 * @param {number} [options.pool]  how many candidates each half contributes
 * @param {number} [options.limit]  how many results to return
 * @returns {Array<object>} chunk rows with hybridScore, best first
 */
function hybridSearch({ store, embedModel, queryVector, queryText, pool = 50, limit = 8 }) {
  const lists = [];
  const vectorList = [];

  if (queryVector) {
    for (const row of store.searchVector(queryVector, { embedModel, limit: pool })) {
      vectorList.push(row.id);
    }
    lists.push(vectorList);
  }

  // Keyword half: every meaningful word is a separate lookup, then the union is ranked by how many words it matched
  // and where it appeared. One LIKE per word is enough at this corpus size and keeps the adapter unchanged.
  const keywordHits = new Map();
  for (const term of tokenize(queryText).slice(0, 10)) {
    const rows = store.searchKeyword(term, { limit: pool });
    // A term that matches many clauses says little ("cover"); a term that matches one says a lot ("jewellery",
    // "30 days"). Weighting by rarity is what makes the keyword half better than noise.
    const weight = 1 / Math.max(1, rows.length);
    rows.forEach((row, index) => {
      const current = keywordHits.get(row.id) || { id: row.id, weight: 0, hits: 0, best: pool };
      current.weight += weight;
      current.hits += 1;
      current.best = Math.min(current.best, index);
      keywordHits.set(row.id, current);
    });
  }
  const keywordList = [...keywordHits.values()]
    .sort((a, b) => b.weight - a.weight || b.hits - a.hits || a.best - b.best)
    .map((entry) => entry.id);
  if (keywordList.length) lists.push(keywordList);

  const fused = fuse(lists, {});
  return fused.slice(0, limit).map(({ id, score }) => ({
    ...store.getChunk(id),
    hybridScore: score,
    fromVector: vectorList.includes(id),
    fromKeyword: keywordList.includes(id),
  }));
}

module.exports = { hybridSearch, fuse, tokenize, RRF_K };
