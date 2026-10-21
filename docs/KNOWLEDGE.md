# Knowledge Assistant (RAG)

Answers questions in English, Hindi and Telugu **only** from the company's own documents, with a citation for every
fact, under the same access rules as the rest of the application.

## Status

### Done

| Slice | What exists |
|---|---|
| R0.1 | `src/knowledge/store.js` — SQLite adapter (`node:sqlite`, no dependency) with the full Appendix A chunk schema: audience, valid_from/valid_to, product, language, sensitivity, embed_model. Publishing a version retires the previous one. Search refuses to compare vectors from different models. |
| R0.1 | `test/knowledge-store.test.js` — 5 tests. |
| R0.2 | `src/knowledge/ingest.js` — structure-aware split (heading path, clause, page), metadata on every chunk, injected embedder, all-or-nothing publish inside one SQLite transaction, `KnowledgeIndexed` result object. |
| R0.2 | `test/knowledge-ingest.test.js` — 6 tests, fake embedder, no network. |
| R0.2 | `test/fixtures/knowledge/sample-home-wording.md` — fictional Homeowners wording written for testing only. |
| R0.3 | `src/knowledge/answer.js` — Claude `claude-opus-5-5`, passages as `search_result` blocks with citations enabled, system prompt from Appendix D, prompt caching. Plain-code checks: every factual sentence cited, every citation among the passages sent, one retry then "not found", cover answers always carry the claims-team sentence. |
| R0.3 | `test/knowledge-answer.test.js` — 9 tests with a fake Claude: cited answer accepted, uncited retried then refused, outside citation rejected, injection passage treated as data, missing fact gives "not found", cover sentence enforced. |

### Next

| Slice | Work |
|---|---|
| R0.4 | `scripts/knowledge-cli.js` — 20 questions against the real Voyage and Claude APIs (ask before running: it costs money). |
| R1 | Hybrid search (vector + keyword), RRF, reranker, contextual sentences, evaluation set. |
| R1 | Hybrid search (vector + keyword), reciprocal rank fusion, reranker, contextual sentences, evaluation set; target recall@8 ≥ 90%. |
| R2 | Audience and date filters applied before ranking, policy-as-of tool, masking, query log; leak tests must score 0. |
| R3 | Ask page in the UI with numbered citations and a source viewer, in three languages. |
| R4 | Customer and agent use, agentic tools, hand-off to a person. |
| R5 | Dashboard, content-gap report, nightly drift run. |

## Measured retrieval (2026-10-21, voyage-4, 22 chunks, 4 fictional wordings)

| Step | recall@3 | recall@8 |
|---|---|---|
| vector only (R0) | — | — |
| hybrid + RRF + context sentences | **0.90** | **1.00** |
| + overlap reranker | 0.80 | 0.90 |

The design target is recall@8 >= 0.90: met by fusion alone. The overlap reranker makes it worse, so it is disabled by
default (\`rerank.js\` says so in a comment) until a model reranker can be measured on the same set. The one remaining
miss at k=3 is q01 ("perils under the property section"), which returns HO-1.1, HO-2.1 and CP-1.1 instead of HO-1.3;
at k=8 it is found.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Vector store | SQLite at `D:\PolicyCenter-Knowledge\knowledge.db`, behind the adapter in `src/knowledge/store.js` | No server to run, one file outside the repository, and the adapter keeps the pgvector migration a swap rather than a rewrite. pgvector remains the production target. |
| Embeddings | Voyage AI `voyage-4`, behind an injected embedder | Hosted and multilingual (Hindi and Telugu matter here), no multi-gigabyte model on this machine. Every chunk stores `embed_model`, and search refuses mixed models, so re-indexing to BGE-M3 later is a re-ingest, not a guessing game. |
| First source | `test/fixtures/knowledge/sample-home-wording.md` | A fictional wording written for testing: no real policy, company or customer data enters the index. |
| Chunking | By structure: heading path, clause number and page on every chunk | A citation has to name the clause the reader can find. Splitting on headings, and only cutting inside a clause when it exceeds 800 tokens, keeps that possible. |
| Publish | All or nothing, in one transaction | A half-indexed version would answer from a document that is not current. If any embedding fails, nothing of that version is stored and the old version stays current. |

## How to run

```powershell
cd C:\Users\MucharlaSreenivasulu\OneDrive\Desktop\AI-FDE\PolicyCenter-Sim
npm test                                  # full suite; the knowledge tests need no network
node --test test/knowledge-store.test.js   # the adapter alone
node --test test/knowledge-ingest.test.js  # ingest alone
```

Configuration lives in `.env` (git-ignored): `VOYAGE_API_KEY`, `ANTHROPIC_API_KEY`, `ANTHROPIC_WORKSPACE_ID`,
`KNOWLEDGE_DB`.

## Limits, stated plainly

- Retrieval in R0 is vector-only with cosine in JavaScript; the keyword index, RRF and the reranker arrive in R1, and
  `sqlite-vec` replaces the JavaScript scan when the corpus outgrows a few hundred chunks.
- The audience and date columns exist but no filter uses them yet; they are enforced in R2, and until then retrieval must
  not be exposed to a role that should not see the corpus.
- No OCR: a scanned PDF will ingest as empty text and is rejected rather than silently indexed.

## R3 exit against section 13 (Evaluation)

The design's section 13 is the gate for going live, not a description of the screens. Scored on 21 October 2026.

| Measure | Target | Measured | State |
|---|---|---|---|
| Recall at 8 | >= 90% | **100%** (voyage-4, 22 chunks, 4 wordings) | met |
| Access leaks | 0, always | **0** (5 roles x 4 questions, through the ask path) | met |
| Faithfulness | >= 98% | not measured | **not measured** |
| Citation accuracy | >= 95% | markers enforced in code (every sentence uncited -> retry -> refused; every [n] must be a passage we sent), but "supports the sentence" is semantic and unmeasured | **partly measured** |
| Correctness | >= 90% | **75% (15/20)** on 21 Oct, after retrieval improvements; 60% (12/20) before them | **below target** |
| Correct "not found" | >= 95% | **100% (10/10)** on 21 Oct; was 90% before the retrieval improvements | met |
| Language | >= 99% | not measured | **not measured** |
| Injection resistance | 100% | not measured; the prompt forbids it and nothing tests it | **not measured** |
| ~50 cases per use case | ~50 | 20 cases, one use case | **not met** |
| Run on every change, blocking a release | required | CLI only; not in any pipeline | **not met** |

Two consequences, stated plainly:

1. R3's screens and routes are built, but the phase cannot be called done against its own gate: three measures are
   unmeasured, two are below target on a stale run, and the case count is far short.
2. The cheapest next measurement is correctness and correct-not-found re-run now that retrieval reaches 100% at 8: the
   same 20 questions through `scripts/knowledge-cli.js`, which costs a handful of model calls. Faithfulness and
   citation accuracy need a judge with a written rubric; language and injection need two new case files.

Decisions only the business can make: **which audience policy wordings carry** (public lets agents read them,
underwriting keeps the corpus staff-only) and **who owns content** - the person who approves a wording for publication
and runs the weekly content-gap review.

### What moved the answer numbers (21 October)

| Run | Passages sent | Correct | Correct "not found" |
|---|---|---|---|
| before hybrid retrieval | 3 | 60% (12/20) | 90% |
| after hybrid + context sentences | 3 | 65% (13/20) | 100% |
| after sending 8 passages, as the design says | **8** | **75% (15/20)** | 100% |

The CLI was sending three passages while the page and the API already sent eight: the measurement under-fed the model,
so most of the remaining "not found" answers were the model correctly refusing on a context that did not contain the
clause. Correctness is still short of the 90% target, and the seven remaining misses are answerable questions whose
clause is now in context - which makes the next question an answering one (prompt, or the "say not found" rule firing
too eagerly), not a retrieval one.

### Prompt change measured and reverted (21 October)

Softening the refusal rule - "answer when a passage addresses the question, even partially" - **lowered** correctness
from 75% to 60% on the same 20 questions, so it was reverted at `98e44a4`. The stricter rule makes the model refuse
when a passage merely mentions the subject without stating the answer, which is the safer failure for insurance; the
looser rule turned refusals into guesses. Recorded because the intuition was wrong and the measurement is the
argument.

### Dedupe attempted twice, both measured harmful (21 October)

The trace showed eight slots filled by three clauses, so dedupe-by-clause looked like free quality. Tried twice: one
chunk per clause (reverted, broke two recall measures and two access assertions) and two chunks per clause over the
whole fused list (reverted, still lowered recall). The reason is structural: a long clause's *answer-bearing* chunk can
be its third or fourth, so any per-clause cap discards exactly the passage the question needs. Keeping the cap means
raising the fetch pool and choosing per clause by relevance to the question, which is the reranker's job - and the
reranker is disabled because it measured worse. Conclusion: leave ranking as it is until a reranker can be measured
better, and treat clause repetition as a known cost rather than a bug.
