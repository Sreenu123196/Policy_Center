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

### Next

| Slice | Work |
|---|---|
| R0.3 | `src/knowledge/answer.js` — Claude with citations; plain-code checks (every fact cited, citations only from allowed passages, uncited → retry once → "not found"); prompt-injection test. |
| R0.4 | `scripts/knowledge-cli.js` — 20 questions against the real Voyage and Claude APIs (ask before running: it costs money). |
| R1 | Hybrid search (vector + keyword), reciprocal rank fusion, reranker, contextual sentences, evaluation set; target recall@8 ≥ 90%. |
| R2 | Audience and date filters applied before ranking, policy-as-of tool, masking, query log; leak tests must score 0. |
| R3 | Ask page in the UI with numbered citations and a source viewer, in three languages. |
| R4 | Customer and agent use, agentic tools, hand-off to a person. |
| R5 | Dashboard, content-gap report, nightly drift run. |

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
