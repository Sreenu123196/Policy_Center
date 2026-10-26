# Project status

Last updated: 26 October 2026, at main.

## What exists

The platform (policies, billing, claims, contacts, permissions, audit) plus the governed AI layer from the review document: phases 1 to 3 complete, and the repository half of phase 4.

| Measure | Value |
|---|---|
| Tests | 749 passing (npm test) |
| Merge gate | npm run gate:policy passes at a baseline of 749 |
| API | 200+ routes, every one with a permission row or a declared public exception |
| Runtime | JSON file by default; PostgreSQL by setting DATABASE_URL |
| Boot | npm start, then GET /health answers 200 |

## The review document, item by item

| Phase | Items | State |
|---|---|---|
| 1 | B3 PII/injection, B1 citations, B4 scoped RAG, B10 gateway, B11 eval gate | complete |
| 2 | B2 procedures, B17 registry and kill switch, B21 second verifier, B30 plan panel, B25 cited search, B26 dependency graph, B29 merge gate | complete |
| 2 | B7 maker-checker | complete in this repo; Telegram delivery needs the other service and its token |
| 3 | B5 endorsement diff, B8 KYB, B9 call scribe, B13 chronology, B18 registry verifier, B19 fraud simulator, B20 sovereign mode, B12 MCP, B22 underwriting memo | complete |
| 4 | B6 multilingual FNOL, B14 photo inspection, B15 Tenglish audit, B23 dual consent | complete for the repository half |
| 4 | B27 content credentials, B28 walkthrough video | not started: need a signing service and a video vendor |
| A | A9 policy Q&A | complete; A10 and A11 partial |
| - | B24 NPCI mandate notice | partial: the rule needs RBI/NPCI confirmation |

## What is deliberately not claimed

- Not deployed. docs/DEPLOY.md is a checklist, and none of it has been run against Render or Netlify.
- Not certified. Sovereign mode, SSO and e-sign are mechanisms behind flags; certification is an audit and a contract.
- Measured on 26 October, on twenty of the evaluation cases: correctness 80 percent (16 of 20), citation 7 of 10. Two failures matter more than the
  score: q09 was refused although its clause (HO-1.2) was in the passages sent. The other failure, q15 ("does the policy cover a home office used for
  business"), turned out to be **a wrong label rather than a wrong answer**: the home wording excludes business liability at HO-2.2, so "not covered" is
  the correct answer and the case now expects it. The case set was wrong, which is the better finding than a model error - and it is why a single run is
  not a measurement.
- Not verified against live vendors. Bolna's request paths are marked for confirmation; the regulatory corpus is illustrative and must be replaced with licensed text.
- Vision is absent. B14 inspects whether a photograph can be trusted; it does not describe the damage.

## How to check any of this

    npm test
    npm run gate:policy -- --tests 749
    npm start        # then GET http://localhost:<PORT>/health

## The honest next steps

1. Deploy: environment variables, the import step, then the four checks in docs/DEPLOY.md.
2. One vendor decision at a time: a vision provider turns B14 from a triage gate into an inspection; signing and video close B27 and B28.
3. Measure the assistant again: a larger case set, three runs, median and range, before anyone quotes a number.
