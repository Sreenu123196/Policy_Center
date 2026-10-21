'use strict';
// The last ranking step before assembling context: fused candidates are scored against the question and cut to the
// number the answer prompt can hold. The reranker is injected (a fake in tests, a model in production) so retrieval
// quality can be measured separately from what the model thinks.

const DEFAULT_TOP_N = 8;

/**
 * @param {object} options
 * @param {string} options.query
 * @param {Array<object>} options.candidates  fused rows (must have id, text, clause)
 * @param {(query: string, candidates: Array<object>) => (number[]|Promise<number[]>)} options.reranker
 *        returns one score per candidate, higher is better
 * @param {number} [options.topN]
 * @returns {Promise<Array<object>>} candidates with rerankScore, best first, at most topN
 */
async function rerank({ query, candidates, reranker, topN = DEFAULT_TOP_N }) {
  if (!candidates.length) return [];
  if (!reranker) return candidates.slice(0, topN);
  const scores = await reranker(query, candidates);
  if (!Array.isArray(scores) || scores.length !== candidates.length) {
    throw new Error(`reranker returned ${scores && scores.length} scores for ${candidates.length} candidates`);
  }
  return candidates
    .map((candidate, index) => ({ ...candidate, rerankScore: scores[index] }))
    .sort((a, b) => b.rerankScore - a.rerankScore || b.hybridScore - a.hybridScore)
    .slice(0, topN);
}

module.exports = { rerank, DEFAULT_TOP_N };
