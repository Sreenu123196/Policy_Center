# Porting the Insurance Suite features into PolicyCenter-Sim

The Insurance Suite (a TypeScript system built step by step as a learning project) is being folded into this app. The
Sim already has accounts, jobs, rating, underwriting, claims stages, a simple outbox, sign-in and tickets, so only the
features the Sim lacks are ported, rewritten in the Sim's own plain JavaScript (no new dependencies, `node --test`).

| # | Feature | Status | Where |
|---|---|---|---|
| 1 | Payments, allocation (oldest invoice first), credit, Paid / Part paid / Overdue, missed-payment steps (notice, then a cancellation for non-payment) | **Done** | `src/billing.js`, `src/invoiceView.js`, Billing tab, `test/billing-*.test.js` |
| 2 | Reinstatement when a late payment clears what was owed on a policy cancelled for non-payment (30-day window) | **Done** | `reinstateIfCleared` in `src/billing.js` |
| 3 | Event consumers with retries, growing wait and a dead-letter list; redrive by a manager; a collections consumer turns missed payments into activities | **Done** | `src/eventBus.js`, `src/consumers.js`, Administration page, `test/event-bus*.test.js` |
| 4 | Claim exposures (one claimant against one cover), reserves and payments per exposure, authority limits, second-person approval; new Claims screens (list, claim page, report a claim) | **Done** | `src/claimMoney.js`, Claims screens in `public/app.js`, `test/claim-*.test.js` |
| 5 | A claim keeps the policy as it was on the loss date (term, version, risk); late-report and not-verified flags shown on the claim list and page | **Done** | `policyAsOf` in `src/policyCenter.js`, `test/claim-intake.test.js` |
| 6 | Idempotency-Key on POSTs (same key and request: first answer replayed, work done once; a different request: 422); ETag and If-Match on accounts and jobs (stale edit: 412); the screens send both | **Done** | `src/api.js`, `public/app.js`, `test/api-safety.test.js` |
| 7 | A permissions matrix test: every route against every role (the table must list every route, so a new route forces a decision) | **Done** | `test/permissions-matrix.test.js` |
| 8 | At renewal the policy's own claims of the ending term feed the new risk: claim-free renewal discount (5% / 10% / 15%) for Personal Auto, loss history for Homeowners and the business lines; shown on the renewal job | **Done** | `claimExperience` and `applyClaimExperience` in `src/policyCenter.js`, `test/renewal-claims.test.js` |
| 9 | Cancellation refund netting as a small ledger | To do | |
| 10 | Screens for each of the above | With each feature | `public/app.js` |

When the list is finished the separate Insurance Suite code at the repository root is removed; its history stays in git.

## Findings from the permissions matrix

The Insurance Executive role is read-only by the access table in `src/permissions.js`, but the executive has UW authority 1,
so the older write routes that only check `authority >= 1` let an executive move a claim between stages, run the renewal
batch, approve level-1 underwriting issues and use the claim-level reserve and payment calls. The new claim exposure
routes refuse executives (`src/claimMoney.js`). Closing the older ones is a decision for the owner of the role design, so
the matrix pins today's behaviour for them; change the matrix row in the same commit as any fix.
