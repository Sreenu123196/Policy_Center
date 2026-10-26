'use strict';
// B25: cited search over the regulatory corpus, with abstention.
//
// The answer is never generated. It is the matched sentence, copied, beside its identifier - so the worst failure mode available here is
// "no result", never "a plausible rule that does not exist". That is the whole point of the exercise, and it is why the function returns
// excerpts rather than a summary.

const { ENTRIES } = require('./regulatoryCorpus');
const { AppError } = require('./appError');

const STOPWORDS = new Set(['the', 'a', 'an', 'of', 'to', 'and', 'or', 'is', 'are', 'be', 'shall', 'within', 'for', 'in', 'on', 'that', 'this', 'it', 'where', 'by']);

function tokens(text) {
  return String(text || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

function sentences(text) {
  return String(text).split(/(?<=[.;])\s+/).map((s) => s.trim()).filter(Boolean);
}

function createRegulatorySearch({ entries = ENTRIES, minScore = 2 } = {}) {
  /**
   * @param {{query: string, limit?: number}} input
   * @returns {{found: boolean, query: string, results: Array<{id: string, title: string, section: string, excerpt: string, score: number, illustrative: boolean}>}}
   */
  function search({ query, limit = 3 } = {}) {
    if (!query || !String(query).trim()) throw new AppError(422, 'q is required');
    const wanted = new Set(tokens(query));
    const scored = [];
    for (const entry of entries) {
      const haystack = tokens(entry.title + ' ' + entry.section + ' ' + entry.text);
      let score = 0;
      for (const word of wanted) if (haystack.includes(word)) score += 1;
      if (score < minScore) continue;
      // The excerpt is the sentence that shares the most words with the question; the rest of the entry is not quoted.
      const best = sentences(entry.text)
        .map((sentence) => ({ sentence, own: tokens(sentence).filter((w) => wanted.has(w)).length }))
        .sort((a, b) => b.own - a.own)[0];
      scored.push({
        id: entry.id, title: entry.title, section: entry.section,
        excerpt: best ? best.sentence : entry.text,
        score, illustrative: Boolean(entry.illustrative),
      });
    }
    scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    const results = scored.slice(0, limit);
    return { found: results.length > 0, query: String(query), results };
  }

  return { search, entries: () => entries };
}

module.exports = { createRegulatorySearch, tokens, sentences };
