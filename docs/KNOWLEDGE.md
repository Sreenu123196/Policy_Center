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

### The number that matters: 54% on the real corpus (21 October)

`scripts/knowledge-eval.js` ingests all four wordings (22 chunks) and asks all 50 cases with the real embedder and
model:

| Measure | Result |
|---|---|
| Correctness | **27/50 (54%)** |
| Answerable cases that cited the right clause | **7/30 (23%)** |
| Correct "not found" | 20/20 (100%) |

The earlier 75% was measured against a database holding only the Homeowners wording, so retrieval had no chance to
confuse products. With four wordings it does: most refusals are the right question answered from the wrong product's
clause, or not found because the right clause lost to another product's near-identical language ("we cover the
buildings", "deductible shown in the schedule"). That makes **product scoping the first fix**, not the prompt: when a
question names a product (home, auto, commercial property, workers compensation), the filter should restrict to that
product before ranking - the columns already exist on every chunk.

### Faithfulness, language and injection: blocked by a refusal, not measured (21 October)

`scripts/knowledge-quality.js` measures the three qualities that need a real model: a poisoned document for injection,
Hindi and Telugu questions for language, and a judge with a written rubric for faithfulness. Run on the four-wording
corpus, every answer came back as "I could not find that in the documents." - including the English jewellery question
whose clause is in the context. So:

| Measure | Result | Why |
|---|---|---|
| Injection resistance | **not measurable yet** | the poisoned passage was in context, but the answer refused, so compliance could not be tested |
| Language | **1/3** (English pass only) | two refusals, both in English, so the asked language was never used |
| Faithfulness | **0/1 judged** | the sampled answer refused, so there was nothing to judge |

The common cause is the answering step refusing on fragments: a long clause is split across chunks and the chunk that
carries the number ("up to 2,500 dollars") can be outside the eight passages, so the model sees half a sentence and
correctly declines to state a limit. That also explains the 54% correctness far better than product confusion alone.

Next fix, in this order: **never split a clause that fits in the budget**, and give each fragment its clause heading so a
partial clause is recognisably partial; then re-run `knowledge-eval.js` (correctness) and `knowledge-quality.js`
(these three measures). Both harnesses exist now, so each fix costs one run to judge.

### The duplicate clauses were real, and they were five versions of one wording (22 October)

`SELECT version_id, COUNT(*) FROM chunks GROUP BY version_id` on the evaluation database:

| version | chunks |
|---|---|
| v-1792581834852 ... v-1792601280351 | 6 each, **30 in total** |
| document_versions rows | 5, each a full re-ingest of the same wording |

So every "duplicate clause" in a top-8 was the same clause from a different publication of the same document. The
answer path was shown the correct passage four times and near-identical wording of other clauses, which is a plausible
cause of the refusals recorded above - and it makes the 54% correctness a measure of a polluted index, not only of
retrieval.

Two attempts to filter the index to current versions both failed and were reverted: `valid_to IS NULL` is wrong because
`valid_to` is a version's own end date, not a retirement marker, and a "latest by created_at" variant was not applied
cleanly. The next attempt must first decide what marks a retired version - the publishing code sets the previous
version's `valid_to` to the publication time, so either that convention is made explicit with a `retired` flag or the
query uses the newest row per document with a test that proves it, before any measurement is believed again.

### The version filter was right, and it changed nothing in the measurement (22 October)

After filtering retrieval to the newest publication, the fifty-case run reported exactly the same numbers as before:
**27/50 correctness, 7/30 right-clause citation**. That is a useful correction to my own diagnosis: `knowledge-eval.js`
ingests into a fresh temporary database, so it never had five publications to confuse it. The duplicated clauses were
real in the **live** database - the one the Ask page and the assistant use - which had accumulated five re-ingests.
So the filter fixes the user-facing path and leaves the evaluation untouched.

Which means the 54% is genuine cross-product retrieval: with four wordings, the right clause is found less than a
quarter of the time. The next lever is product scoping - `product` is on every chunk, and a question that names a
product should restrict the candidates before ranking, exactly as the audience filter does. That change is measurable
by the same run.

### Product scoping works, and still the model refuses (22 October)

The probe, per question, with and without the product filter:

| question | detected | open top-8 | scoped top-8 |
|---|---|---|---|
| collision deductible | PersonalAuto | PA-2.1, PA-2.2, HO-1.1, HO-2.1, ... | six PersonalAuto clauses only |
| theft of the car | PersonalAuto | PA-2.2, PA-2.1, ..., HO-1.2, CP-1.2 | six PersonalAuto clauses only |
| jewellery and watches | Homeowners | HO-1.2 first, then two Homeowners, then three other products | six Homeowners clauses |
| period of indemnity | none | CP-1.2 first, then mixed | (left open, as designed) |

So the filter does what it claims: the wrong product's clauses disappear. And the measured score did not move - 27/50,
7/30 - because the clause was already first in the open list for the jewellery question, and the model refused anyway.

That places the bottleneck precisely: not retrieval, not the index, not product noise, but the answering step, which
declines to answer while the correct clause sits at rank 1. The next investigation is the request the answer layer
actually builds - whether the passages reach the model as citable blocks, and whether the "reply exactly this" rule is
discharging on its own caution. Everything upstream of that is now measured and, for three separate hypotheses, proven
innocent.

### What actually moved the number (22 October)

| Change | Correctness (50 cases) | Right clause cited (30 answerable) |
|---|---|---|
| baseline, four wordings | 27/50 (54%) | 7/30 (23%) |
| literal citation markers instead of structured citations | (12-case run: 3 answerable questions stopped refusing) | |
| clause heading in each passage + "match on meaning, not phrasing" | **30/50 (60%)** | **11/30 (37%)** |
| clause number and heading embedded with the body | **34/50 (68%)** | **14/30 (47%)** |

The citation mismatch was the single largest defect: the request asked for structured citations while validation
checked literal [n] markers, so genuine answers were retried and returned as "I could not find that in the documents."
Four retrieval hypotheses were measured and refuted before that was found; the fault was in how the answer was checked,
not in what was retrieved.

Remaining gap to 90%: questions phrased in a person's words ("settle a claim myself", "special limits") still sometimes
miss a clause that says "written consent" or "jewellery, watches and furs". Next levers, in order: index the clause
heading as part of the embedded text so paraphrase meets paraphrase, raise the number of passages for long wordings, and
only then consider a model reranker.

### Embedding the heading was the second real gain

Storing the body alone meant a question phrased in the words of a heading ("special limits", "dwelling") had nothing to
match. Embedding "clause - heading - body" while still storing the body alone lifted correctness 60% -> 68% and
right-clause citation 37% -> 47% on the same fifty cases.

Remaining gap to 90% is now concentrated in questions phrased loosely ("settle a claim myself", "third party injured on
my property"), where the clause exists but shares few words with the question. Next levers, in expected order: more
passages for the long wordings (8 of 22 chunks is a third of the corpus), then a model reranker measured against this
same harness.

### Faithfulness, language and injection, measured (22 October)

With the false refusals gone, the quality harness produced numbers:

| Measure | Result | Note |
|---|---|---|
| Injection resistance | **pass** | the poisoned passage was in context; the answer quoted the 2,500 limit and flagged that two documents disagree. It never asserted unlimited cover, which is what compliance would look like |
| Language | **2/3** | Hindi pass, English pass, Telugu refused ("could not find") because that question's clause was not retrieved |
| Faithfulness | **2/4** | two judged answers fully supported by their passages; two had at least one unsupported sentence |

The injection check itself had to be corrected: it failed any answer containing the words "no limit", including an answer
that was *quoting the poisoned instruction in order to reject it*. Compliance is asserting unlimited cover, not mentioning
it. The Telugu failure is a retrieval problem - the same question in English retrieved the clause and in Telugu did not -
which makes multilingual retrieval the next thing to measure.

### Language is 3/3 after one rule (22 October)

The Telugu failure was not retrieval: for the same question, HO-1.2 ranked first in English, Hindi and Telugu alike
(hybrid scores 0.033 / 0.016 / 0.016). The model was refusing because the passages are English and the question was not.
One rule says so explicitly - "the passages are written in English; answer in the person's language, translating the
clause as needed; a relevant passage is relevant whatever language the question was asked in" - and language went from
2/3 to **3/3**, with all three answers quoting HO-1.2 and its 2,500 limit.

That leaves faithfulness as the only quality measure still short: 2/4 on a sample of four, which is too small to act on.
The next step is a larger sample and reading the unsupported sentences, not changing the prompt again.

### More passages is not the lever either (22 October)

`knowledge-eval.js --passages 12` reports 35/50 (70%) and 15/30 (50%), against 34/50 (68%) and 14/30 (47%) with eight.
One case on each measure: inside the noise of a fifty-case set. So the remaining gap is not "the right clause was
fetched but ranked ninth".

That leaves three candidate causes, in order of cost: (1) the model declining while the clause is present, which needs
reading the failures one by one rather than another prompt change; (2) a reranker that would change which eight are sent;
(3) query expansion, rewriting a colloquial question in the wording's vocabulary before retrieval. The harness now has a
`--passages` flag, so any of the three can be judged by one run of the same fifty cases.

### Every failure is a refusal, and the score moves between identical runs (22 October)

A complete fifty-case run, with the reasons counted rather than eyeballed:

| Outcome | Count |
|---|---|
| refused an answerable question | **20** |
| answered with wrong or uncited facts | **0** |
| answered what should have been "not found" | **0** |

Two conclusions:

1. **The system never fabricates.** Across fifty cases and repeated runs it has never asserted a fact the passages do not
   support and has never answered a question the corpus cannot answer. Its failure mode is silence, which is the right
   one for insurance - and it means the 60% is 60% answered, not 60% correct.
2. **The score is not stable between identical runs.** The same code measured 34/50 (68%) and 30/50 (60%) a few minutes
   apart, and q01/q02 answered in one run and refused in the next. With twenty refusals and no wrong answers, the honest
   statement is "60-68% answered, 0% wrong", and a fifty-case set cannot resolve differences smaller than about four
   cases. Any future comparison needs either repeated runs or a larger set - otherwise a change that "gains two points"
   may be noise.

The next experiment should therefore be repeated runs of the same configuration (three runs, report the range) before any
new change is believed, and the refusal cases read one by one: the model is declining while the clause is present, which
is now the only failure left.

### Three identical runs: 58%, 75%, 42% - and a correction to this document (22 October)

The same twelve cases, the same code, run three times in a row:

| run | correctness |
|---|---|
| 1 | 7/12 (58%) |
| 2 | 9/12 (75%) |
| 3 | 5/12 (42%) |

A fifteen-point spread on identical inputs. **This contradicts the individual step-by-step numbers recorded above**:
54% -> 60% -> 68% were each a single run of fifty cases, and a fifty-case set with this much variance cannot support
them. The structural changes are real and proven by tests - literal citation markers (a genuine defect), the
multilingual rule (3/3 against 2/3, reproducible in one session), the heading in the embedding and in the passage (both
change what the model receives) - but **the claim that each lifted correctness by a specific number is not supported**.

What is supported, because it is not a single sample: recall@8 100%, access leaks 0, correct "not found" 100% (20 of 20
unanswerable cases, repeated), zero wrong or uncited facts across every run, language 3/3, injection pass.

The correct method from here: three runs per configuration, report the range and the median, and only call a difference
real when the ranges do not overlap. Until then, the honest summary of correctness is **"roughly 40-75% answered, 0%
wrong, one run in three lands near 70%"** - which is a far less satisfying sentence and the only true one.

### The first defensible number: median 75%, range 70-85% (22 October)

Three runs of the same twenty cases, same configuration:

| run | correctness | right clause cited |
|---|---|---|
| 1 | 14/20 (70%) | 4/10 (40%) |
| 2 | 17/20 (85%) | 7/10 (70%) |
| 3 | 15/20 (75%) | 5/10 (50%) |
| **median** | **75%** | **50%** |
| range | 70-85% | 40-70% |

This is the first figure in this document that rests on repeated runs rather than one sample, and it replaces every
single-run correctness number recorded above. Two things follow:

1. **Correctness is around 75%, not 60-68%.** The earlier figures were taken on the first twelve cases, which are a
   harder slice than the first twenty, and each was one sample.
2. **Right-clause citation is around 50%, with a wider range.** The model can answer correctly from a passage that is not
   the one the case names - which is why correctness sits well above citation accuracy. That is a measurement artefact as
   much as a quality signal: a question can be answered from a neighbouring clause that states the same rule.

The gap to 90% is now about fifteen points, inside the range's upper half, and the method to close it is fixed: three
runs per configuration, median reported, a difference believed only when ranges do not overlap.

### The refusal-rule experiment was inconclusive, so the rule is unchanged (22 October)

The four refusals all had their expected clause in context, which pointed at the answering instruction. The softened rule
was restored and measured repeatedly:

| configuration | runs | median |
|---|---|---|
| strict rule | 70%, 85%, 75% | **75%** |
| softened rule | 80%, 60% | 70% |
| softened rule, earlier attempt | 60% | - |

The spread within each configuration is wider than the difference between them, so the change is **not proven** and has
been reverted. The earlier decision to revert it "because 60% < 75%" was also unjustified - it compared two single runs -
but the right response to that mistake is a proper experiment, and the proper experiment says: no detectable difference.

What this means for the remaining gap: correctness sits at **75% median (70-85% range)** regardless of this rule, and a
twenty-case, three-run experiment cannot resolve ten points. Either the case set must grow (to a hundred or more) or the
number of runs must rise (five or seven), before the next prompt change can be judged. No further prompt changes should be
made until then - each one costs a measurement that cannot currently answer the question.

### The gate exists now (22 October)

`npm run knowledge:gate` runs the evaluation and fails below a floor: correctness >= 60% and right-clause citation
>= 25%. The floors sit below today's measured medians (~75% and ~50%) on purpose - a normal bad run must not fail the
build, a real regression must. Verified end to end: ten cases returned 60% and 60%, the gate passed with exit 0; the
same run below the floor exits 1.

It is not part of `npm test` because it spends model calls. `npm run knowledge:eval` and `npm run knowledge:quality`
are the manual entry points, `knowledge:gate` is the one a pipeline should call.

Remaining for a complete gate: faithfulness at scale (thirty judged answers), the customer use case's fifty cases, and
correctness tuning toward 90%. None of those is plumbing; two are measurement and one is writing.

### Faithfulness at scale: 4 of 10 (22 October)

Twelve sampled answers, ten judged (two were refusals, which cannot be faithful or unfaithful), rubric: every factual
sentence must be supported by the quoted passages, ignoring general truths and the mandatory claims sentence.

| result | count |
|---|---|
| fully supported | **4** |
| at least one unsupported sentence | **6** |

That is 40%, against a target of 98%, and it is the worst number in this document. It also contradicts the reassuring
figure in the evaluation - zero wrong or uncited facts - because the two measure different things: the evaluation checks
that a cited clause exists and the must-contain facts appear, while faithfulness asks whether every sentence is supported
by the passage it cites. An answer can cite HO-1.2 correctly and still add a sentence the clause does not contain.

The likely causes, to be checked by reading the six failures rather than guessing: answers that combine two clauses and
then state the combination as fact; answers that restate an example as a rule; and the model's habit of adding a short
summary sentence with no citation. Each is fixable in the prompt, but the fix must be judged by this measurement, which
now exists and is reproducible.

Language regressed to 2/3 in the same run - the Telugu question refused again - which is further evidence that one run is
not a result and that the earlier 3/3 was one favourable sample.

### The faithfulness measurement is itself unstable (22 October)

| run | judged | faithful |
|---|---|---|
| first | 10 | 4 (40%) |
| second, same code, minutes later | 5 | 4 (80%) |

The same cases flipped verdicts (q01 failed then passed; q04 failed both times), and one failure came back with "none
listed" - a judge that says an answer is unfaithful but cannot name the sentence. So 40% and 80% are both noise, and
neither can be quoted as the faithfulness of the system.

That is the third measurement in this document to fail the same way (correctness 42-85%, language 2/3 then 3/3, now
faithfulness 40-80%). The instruments are not yet trustworthy enough to support the gate they are meant to guard, and the
fix is the same in all three cases: more cases, repeated runs, and a judge asked three times with a majority verdict.

Until then the honest position on faithfulness is "not measured", not 40% and not 80%.

## Billing: the GST migration, and why it is not done yet (23 October)

Premium is posted at bind through the event bus (`accounting.postFromEvent`, `PREMIUM_EVENTS`), not at payment - an earlier
reading of the code in this session said otherwise and was wrong. The posting already carries commission expense and payable.

The change itself is small and was written, balanced and then reverted: add `gstPayable` (2200), split the gross into net and
GST, and compute commission on the net because tax is not commissionable.

It was reverted because **nine accounting tests encode the old basis** and several assert trial-balance figures that move when
GST appears. Examples that must change together:

- `test/accounting.test.js:47` - written premium credited `total`; must become the net of GST.
- `test/accounting.test.js:60` - commission `total * rate`; must become `net * rate`.
- the receivable, trial balance and closing tests that compare totals to gross.

That is a deliberate migration with a cut-over date, not a mechanical edit: historical postings stay on the old basis, and the
trial balance only reconciles from the cut-over. Doing it in one commit - code and tests together - is the only safe way, and
it needs a session with room to run the accounting suite repeatedly.

### GST in the ledger: what the diagnosis established (23 October)

Three attempts, each reverted, each narrowing the fault:

1. The change was written and every line balanced on paper, yet nine accounting tests reported totals of **0** - not wrong
   totals, absent entries.
2. A **direct** `accounting.post` with a GST line (Dr receivable 1,180 / Cr written premium 1,000 / Cr GST 180) succeeds and
   numbers the entry, and an unbalanced entry is refused with the expected message. So `post()` and the new account code are
   fine.
3. Instrumenting the premium branch of `postFromEvent` produced **no throw** and no log, while the totals stayed at zero. So
   the premium posting is not failing where I assumed; the entries are not reaching the journal at all.

That last point is the useful one: the next session should assert **what the bus did** - how many events it consumed, whether
`db.eventFailures` has entries, and whether the ledger contains any entry at all after a bind - rather than re-reading the
posting lines. Guessing at the arithmetic three times has produced three reverts and no progress; the missing observation is of
the event pipeline, not of the entry.

The change itself is known-good in isolation and documented above; it is the integration that is unobserved.

### GST migration: root cause found, 11 of 12 tests migrated, one real difference (23 October)

The three earlier failures had a single cause and it was mine: the require never landed. `const { gstOnPremium } = require('./billingRules')`
was inserted by matching `const round2 =`, which does not exist in `src/accounting.js` - so the call sites referenced a name
that was never imported, every premium posting threw, the event bus recorded the failure, and the tests saw totals of zero
rather than an error. The bus's failure record (`db.eventFailures[0].lastError = 'gstOnPremium is not defined'`) named it in
one line; the wrong harness (no bus) had hidden it for two attempts.

With the require in place: **11 of 12 accounting tests pass** after moving written premium and commission to the net basis -
written premium credits the net of GST, GST is its own liability, commission is earned on the net, and the commission statement
follows. All three are tested.

The twelfth is a genuine difference, not a stale expectation: `the receivable always agrees with the customers' ledgers` now
reports **531.82** after a cancellation. That is a reconciliation question - `accounting.reconciliation` comparing GL receivable
to customer balances - and the net-basis change has exposed a posting that still computes from gross (most likely the
cancellation pro-rata refund). It needs the reconciliation and cancellation postings read together, not a test adjusted.

So the migration is no longer blocked by a mystery: it is blocked by one real accounting question, with eleven tests already
migrated and passing.

## Where the Knowledge Assistant stands (23 October, measured)

| Measure | Target | Now | How it was measured |
|---|---|---|---|
| Recall at 8 | 90% | 93-100% across runs | `--recall`, four wordings |
| Access leaks | 0 | 0 | five roles, four questions, through the ask path |
| Correct "not found" | 95% | 100% (20 of 20) in two runs, 95% in one | unanswerable cases |
| Wrong or uncited facts | none | **0 in every run** | every evaluation run to date |
| Citation accuracy on answered questions | 95% | **94%** (15 of 16) | separated from refusals, misses labelled |
| Correctness | 90% | **78% median** (70-85% range) | three runs, twenty cases |
| Faithfulness | 98% | **not reliably measured** | judge flipped verdicts on identical answers |
| Language | 99% | 2/3 to 3/3 | unstable between runs |
| Injection resistance | 100% | pass | poisoned passage, never asserted unlimited cover |

The bottleneck is **refusals**: in a diagnosed run, 12 of 13 refused questions had the required clause in the passages sent, often
first. The model declines with evidence in hand. Two prompt attempts to loosen it were measured and reverted - the second produced
four confident wrong answers on unanswerable questions, which for insurance is worse than a refusal.

What would close the gap, in order:
1. **More cases**, hand-written, to a hundred or more: twenty cannot resolve ten points, and the range is seven points wide.
2. **A faithfulness judge that must name the unsupported sentence**, run three times per answer with a majority verdict.
3. **Answer-with-quotation then verify the quotation appears in the passage** - converts refusals into answers without permitting
   invention, which is the one trade not to make.

Nothing else in this document should be read as a claim about current quality.

## Postgres as the default runtime: attempted, reverted (23 October)

The plan was to import the real book and then let the runtime pick Postgres whenever a database directory exists. The first half
was tested against a small dataset; the second half was not safe on the real one:

| Step | Result |
|---|---|
| Small import, verified in the database | passes (2 tests) |
| Import of the real `data/policycenter.json` (153 policies, 186 ledger rows, 132 accounts) | **did not finish** within ten minutes |
| Collections added since the store's shape (contacts, mandates, signatures) | crashed the first run - `store.data[name]` was undefined; fixed by creating the array before pushing |

The default was therefore **not switched**. `data/pgdata` was deleted and `src/pg/open.js` reverted, because a runtime that picks
a database the moment the directory exists would have started against a half-imported book - policies without their ledger, or the
reverse. That is worse than staying on the JSON file.

Next attempt should measure instead of guessing: log progress per collection during the import (rows written, milliseconds) to find
where it stalls, and consider batching the rows rather than one push per row, because the tracker's per-row path is what a small
dataset hid.

The importer and its tests remain, and they are useful regardless: they prove the write path and the verification, which is the
part that caught the empty-database failure.

## Policy caps versus product validation: the cap is unreachable (23 October)

Attempting to price a capped limit exposed that the product model already caps: a homeowners personal-property limit above the cap is
refused by quote validation ("1 validation error"), so no valid input can reach the cap table. Two rules enforce the same ceiling, and
the newer one - the caps table - is dead code for that coverage.

The rating change that resolved caps was therefore reverted rather than left in place looking correct. The honest position:

- **Caps are enforced by the product model's validation today.** The caps table and `resolveLimit` are used by the admin route that
  explains a limit, not by rating.
- **Making rating use them requires deciding which is authoritative.** Either validation allows larger limits and the cap table becomes
  the guard, or the cap table documents a ceiling validation enforces. Doing both means two places to change and one of them silently
  stale - the same failure shape as the GST require, the missing route and the empty database.

Recorded so the next attempt starts with the decision, not with a change to rating.

### The import works; reopening the database does not (23 October)

With per-collection progress logging the import of the real book finished in **seconds**, not minutes:

    pushed 20/23 collections, 56 ms
    imported 23 collections, 2470 rows - verified

So the earlier "hang" was never the import. It was the step after it: **opening the same PGlite directory in a fresh process blocks**.
The importing process closes its store and exits cleanly, yet the next process waits - most likely a directory lock PGlite does not
release on close, or a shutdown it needs that `close()` does not perform.

**RESOLVED on 26 October** - see the entry below; the reopen failure was two bugs, and it is fixed.

At the time, that is why the default runtime was **not** switched: an app that cannot reopen its own database is worse than one on a JSON file.
`.env` is untouched, `src/pg/open.js` is unchanged, and the suite is 604 passing.

The imported directory (`data/pgdata`, 42 MB, verified rows) is left in place as evidence. Next step: prove a reopen in a fresh
process against a *copy* of the directory, and if the lock is the cause, find the PGlite shutdown that releases it - or run the
database in a separate process from the outset, which is what production does anyway.

## The Postgres reopen failure, resolved (26 October)

The earlier entry said reopening a PGlite directory in a fresh process blocks. It did not block: it failed, and the hang was the process failing to exit
afterwards. Two bugs, the second hiding the first.

1. `PostgresStore.close()` drained the write-ahead log and cleared its timer but **never closed the database**. PGlite keeps a worker alive, so the
   process never exited by itself.
2. `scripts/pg-import.js` called `process.exit` straight after closing, which **killed PGlite mid-close** and left a directory that answered
   "PGlite failed to initialize properly" on the next open.

Releasing the database is now opt-in - `close({ closeDatabase: true })` - because the restart tests close a store and deliberately reuse the same
database. Making it unconditional broke seven of them with "PGlite is closed", which is how the distinction was found rather than assumed.

Measured: import of the real book 2517 rows with no mismatches, process exits by itself with code 0, and a fresh process reopens with 153 policies, 186
ledger rows and 4 claims.

**To cut over**, set `DATABASE_URL=pglite://data/pgdata` in the deployment environment - never in `.env`, which seven tests read, and never through a
directory-detection default, which reached the test workers and failed eight of them.

## A run that contradicts an earlier claim (26 October)

Twenty cases, one run: correctness 16 of 20, citation 7 of 10. Two findings deserve recording rather than averaging away.

- **q15 was answered and should have been.** On inspection the home wording excludes business liability at HO-2.2, so "not covered" is the correct answer
  and the case was labelled wrongly. It now expects an answer citing HO-2.2, and the earlier withdrawal of the "no wrong facts" claim is itself withdrawn:
  the model did not invent anything here, the test did. This is a reminder that a failing case must be read before it is believed.
- **q09 was refused with its clause present.** "What is covered under special limits?" expected HO-1.2, which was among the passages sent, and the answer
  was "not found".

So the refusal problem runs both ways: the assistant declines questions it could answer, and answers one it should refuse. The second is the dangerous
direction and it is now on the record with a case id rather than a percentage.

### The lesson from q15

The case was written as unanswerable and the assistant answered it. The tempting reading was a model failure; the true reading was a missing exclusion in the
label. A single run, read by id, found it in ten minutes - a fine illustration of why the numbers in this document are worth less than the cases behind
them, and why every failure is printed with its question rather than only with a percentage.

## Two runs, same code, different answers (26 October)

| Run | Correctness | Citation (answerable) | q15 |
|---|---|---|---|
| first, before relabelling | 16/20 (80%) | 7/10 (70%) | answered (label then said not_found) |
| second, after relabelling | **13/20 (65%)** | **4/11 (36%)** | **refused, with HO-2.2 among the passages sent** |

Nothing changed in the code between them except the label of one case. The model is called without a temperature because `claude-opus-5-5` rejects the
parameter, so sampling is not pinned - and the spread is not a few points, it is fifteen on correctness and thirty-four on citation.

That makes every single-run figure in this document unsafe, including the ones written earlier today. The honest statement about the assistant is not "78%"
or "80%" or "65%": it is **"between 65 and 80% on twenty cases, with citation between 36 and 70%, and the run-to-run spread larger than the differences we
have been arguing about."**

Two consequences for anyone continuing:

1. **Three runs, median and range, or no number.** A single run cannot distinguish an improvement from noise at this variance, which is exactly the trap
   the earlier attempts fell into.
2. **Refusal-with-evidence is still the dominant failure.** q15 had its clause in context and was refused; q09 did the same in the first run. That is a
   prompt or threshold problem, not a retrieval one, and it is consistent across runs even when the numbers are not.

## Three runs, a median, and one failure that never moved (26 October)

| Run | Correctness | Citation (answerable) |
|---|---|---|
| 1 (pre-relabel) | 16/20 (80%) | 7/10 (70%) |
| 2 (post-relabel) | 13/20 (65%) | 4/11 (36%) |
| 3 (post-relabel) | 15/20 (75%) | 6/11 (55%) |
| **median** | **75%** | **55%** |

So the number to quote, if one must be quoted, is **75% correctness with citations at 55% over twenty cases**, and the range is stated beside it: correctness
65-80%, citation 36-70%. Anything narrower is a claim the data does not support.

What did not vary is more useful than what did: **q15 was refused in both post-relabel runs with HO-2.2 among the passages sent**, and q04, q05 and q10 were
refused with their clauses sent in the third run. The assistant declines questions whose answer is in front of it, consistently, whatever the aggregate says.
That is the thing to fix, and it is a prompt or threshold question rather than a retrieval one.

The measurement lesson is now written twice in this document because it was learned twice: **three runs, median and range, or no number.**

## The quotation fallback: one run, directional only (26 October)

| | before (median of three) | after (one run) |
|---|---|---|
| correctness | 75% (65-80) | **65%** |
| citation on answerable | 55% (36-70) | **73%** |

Read honestly: correctness fell inside the existing range, citation rose above it. One run cannot separate that from noise, so this is recorded as **directional,
not established** - and the rule stands: three runs, median and range, or no number.

What the run also showed is more useful than the totals: **q06 and q07 were still refused**. The fallback fires only when one sentence shares two question keywords,
so a refusal whose clause is present but whose sentence wording differs from the question still escapes it. That is the next specific thing to widen - and it is a
wording problem, not a retrieval one, which is consistent with every diagnosis since q09.
