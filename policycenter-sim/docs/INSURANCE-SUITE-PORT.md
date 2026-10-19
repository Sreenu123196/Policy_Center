# Porting the Insurance Suite features into PolicyCenter-Sim

The Insurance Suite (a TypeScript system built step by step as a learning project) is being folded into this app. The
Sim already has accounts, jobs, rating, underwriting, claims stages, a simple outbox, sign-in and tickets, so only the
features the Sim lacks are ported, rewritten in the Sim's own plain JavaScript (no new dependencies, `node --test`).

| # | Feature | Status | Where |
|---|---|---|---|
| 1 | Payments, allocation (oldest invoice first), credit, Paid / Part paid / Overdue, missed-payment steps (notice, then a cancellation for non-payment) | **Done** | `src/billing.js`, `src/invoiceView.js`, Billing tab, `test/billing-*.test.js` |
| 2 | Reinstatement when a late payment clears what was owed on a policy cancelled for non-payment (30-day window) | **Done** | `reinstateIfCleared` in `src/billing.js` |
| 3 | Event consumers with retries, growing wait and a dead-letter list; redrive by a manager; a collections consumer turns missed payments into activities | **Done** | `src/eventBus.js`, `src/consumers.js`, Administration page, `test/event-bus*.test.js` |
| 4 | Claim exposures (one claimant against one cover), reserve lines, authority limits with second-person approval | To do | today a claim has one reserve and flat payments |
| 5 | Claim opens with the policy as it was on the loss date; late-report and unverified flags | To do | |
| 6 | Idempotency keys on every POST, ETag / If-Match on changes | To do | |
| 7 | A permissions matrix test for every route and every role | To do | |
| 8 | Claims history feeds renewal and the no-claim discount | To do | |
| 9 | Cancellation refund netting as a small ledger | To do | |
| 10 | Screens for each of the above | With each feature | `public/app.js` |

When the list is finished the separate Insurance Suite code at the repository root is removed; its history stays in git.
