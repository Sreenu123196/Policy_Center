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
| 9 | Cancellation settlement as a ledger: refund = what was paid beyond the earned premium (never the bare return premium), arrears when short, unpaid future invoices voided, refunds issued once by a manager, withdrawn on reinstatement | **Done** | `src/ledger.js`, `bindCancellation`, Billing tab (settlement, refunds, ledger), `test/cancellation-ledger.test.js` |
| 10 | Screens for each of the above | **Done** | Billing tab (payments, refunds, ledger), Claims screens, Administration (event consumers), renewal claims banner |

The list is finished. The separate Insurance Suite code was removed from the repository; its history stays in git and its last state is the tag `insurance-suite-final`. Its two reference documents are in `reference-docs/`.

## Findings from the permissions matrix

The Insurance Executive role is read-only by the access table in `src/permissions.js`, but the executive has UW authority 1,
so the older write routes that only check `authority >= 1` let an executive move a claim between stages, run the renewal
batch, approve level-1 underwriting issues and use the claim-level reserve and payment calls. The new claim exposure
routes refuse executives (`src/claimMoney.js`). Closing the older ones is a decision for the owner of the role design, so
the matrix pins today's behaviour for them; change the matrix row in the same commit as any fix.

## Reports for the ported features

| Endpoint | Who | What it shows |
|---|---|---|
| `GET /api/reports/collections?asOf=` | UW managers | Policies with overdue invoices: days late, amount, step taken (notice, cancellation request), age buckets 1-30 / 31-60 / 61+ |
| `GET /api/reports/refunds` | UW managers | Refunds by status (Due, Issued, Withdrawn) and cancelled customers who still owe money |
| `GET /api/reports/claim-approvals` | Underwriters, UW managers | Claim payments waiting for a second person (oldest first, days waiting) and how many were approved |

Code in `src/reports.js`, tests in `test/reports-new.test.js`, screen at `#/reports` (the Reports menu item, shown to underwriters and managers).

## Tier 2 (screens, languages, queues)

- Tickets screens, Reports, Claims screens: done.
- Hindi and Telugu screens and accessibility: see `docs/ACCESSIBILITY.md`.
- Work queues (`#/queues`, API `GET /api/queues`): one place for underwriting referrals, claims handling and collections. Counts per queue (open, late, waiting for someone, mine), take an item from a shared queue, a UW manager assigns an item to a person, late items are flagged. Agents see only the referrals on their own accounts. The claims and collections queues are filled by event consumers (`src/consumers.js`).

## Tier 3, item 8: forms and documents

`src/documents.js`, `test/documents.test.js`, the Documents tab of a policy.

- **Languages:** any policy document can be produced in English, Hindi or Telugu (`GET /api/documents/:id/render?language=`; `/view` returns a page of its own to print or save as PDF from the browser, which has the Indic fonts). The fixed wording is translated; names, numbers, dates, money and the names of covers are not. Customer text is escaped.
- **Electronic signature:** `POST /api/documents/:id/sign`. The insured types their name (it must match the named insured) and agrees. The signed copy, the exact page the signer saw, is stored with its SHA-256 and is what the document is from then on. `GET /api/documents/:id/verify` checks the fingerprint. An agent can capture the signature on the customer's behalf (recorded as `capturedBy`). This is a typed-name signature, not a certified digital signature.
- **Delivery:** `POST /api/documents/:id/deliver`. Email sends the document itself (HTML). WhatsApp sends the template `document_ready` (WhatsApp only allows approved templates for business-initiated messages; the text to submit to Meta is `DOC_WHATSAPP` in `src/documents.js`, in the three languages). Every attempt, including a failure, is saved on the customer's messages.
- **Not done:** form inference (choosing the forms a policy needs from its coverages), PDF files with embedded Indic fonts, certified e-signature providers (Aadhaar eSign, DocuSign), and a WhatsApp document attachment.

## Tier 3, item 9: accounting sub-ledger, general ledger export, commission statements

`src/accounting.js`, `test/accounting.test.js`, the Accounting screen (UW managers) and the Commission screen (agents).

- **Sub-ledger:** the event consumer `accounting` turns each business event into one balanced journal entry (policy issued, renewed, changed, cancelled, reinstated; payment received; refund issued; claim paid), once each. Accounts: Cash 1000, Premium receivable 1200, Producer commission payable 2300, Written premium 4000, Instalment fee income 4100, Claims paid 5000, Producer commission expense 5100. Entries are never edited; a mistake is a new entry.
- **Controls:** the trial balance always balances; the **reconciliation** checks that the premium receivable in the books equals the sum of the customers' ledgers (zero difference on the demo data); **closing a month** locks it (a posting dated in a closed month goes into the next open month, marked Late) and a closed month that is altered afterwards is reported.
- **General ledger export:** `GET /api/accounting/gl.csv?from=&to=`, one line per journal line (Date, Journal, Account, Account name, Debit, Credit, Description, Reference, Producer); text that a spreadsheet could run as a formula is made plain text.
- **Commission:** a rate for each producer (default 10%, kept on each entry so a new rate never restates history); statements per producer (`GET /api/producers/:code/statement`, `.csv`, `.pdf`) showing premium, rate, commission, what was paid and what is still payable; a manager pays commission (never more than is payable). A producer sees only their own statement.
- **Not done:** tax (the written premium includes taxes; a tax payable account is not split out), accrual of unearned premium and claim reserves, multiple currencies, an export in a specific ERP format, and a payment run for several producers.
- **Note:** the commission here is what the insurer pays its producers. The older Finance screens treat commission as income of the agency; they are separate.

## Tier 3, item 10 (a): Two-Wheeler product and question sets

`TwoWheeler` in `src/productModel.js`, `src/rateBooks.js` (TW-STD), `src/rating.js` (`rateTwoWheeler`), `src/validation.js`, `src/uwRules.js`, `test/two-wheeler.test.js`.

- **Product:** riders and bikes. Priced per bike from the rider (age, experience, accidents, violations, rider course discount), engine size, bike type, use, mileage, value and age, with third-party liability, rider personal accident, collision, comprehensive and accessories cover. Discounts: multi-bike, paid in full, claim-free renewal. US states and dollars, like the rest of the Sim.
- **Question sets:** a product can define `questions` (yes or no). Every question must be answered to quote, and an answer equal to the question's `trigger` raises that question's underwriting issue (level 1, level 2, or not approvable). Two-Wheeler: modified bike, racing or stunts (not approvable), a lapse in prior cover, a licence suspension. "Kept outdoors" feeds the rating instead. The mechanism is generic: add `questions` to another product and call the same pattern in its UW rules.
- **Screens:** Riders, Two-wheelers and Questions steps; the policy summary shows riders, bikes and answers.
- **Still to do for item 10:** multi-year terms, premium audit, rewrite.

## Tier 3, item 10 (b): multi-year terms

`termOptions` in `src/productModel.js` (Two-Wheeler and Homeowners: 12, 24 or 36 months), `period.termMonths`, `test/multi-year.test.js`.

- The customer chooses the term on the Policy info step of a submission (not after binding). A product with a fixed term (Personal Auto, the business lines) refuses another length.
- The term sets the expiration date, the price (the term factor on every product; Two-Wheeler adds a 3% discount at 2 years and 5% at 3 years, kept in the rate book), the instalments (a quarterly plan on three years is twelve instalments), the pro rata refund on cancellation (over the whole term), and the renewal (the same length again).
- Homeowners rating was an annual rate with no term factor; a 12-month worksheet is unchanged, a longer term multiplies by its years and says so in the rate-level line.

## Tier 3, item 10 (c): premium audit

`startPremiumAudit`, `recordAuditActuals`, `bindAudit` in `src/policyCenter.js`; `test/premium-audit.test.js`.

- For policies priced on an estimate (Workers' Compensation payroll, General Liability receipts or payroll). After the term ends an underwriter starts the audit, records the actual figures, quotes and binds the audit job. The premium is worked out again on the actuals for the **whole term**, and the difference against the estimated premium is billed as additional premium (due in 15 days) or credited as a return. One audit per term.
- An audit changes only the audited figures, never the rest of the policy, and underwriting rules about the risk do not hold it up. No new policy version is added (an audit is an adjustment to the term, not a change of cover), so the policy as of a loss date is unaffected.
- It posts to the books through the event `PremiumAuditCompleted`; a statement document (`Premium Audit Statement`, in English, Hindi and Telugu) is produced. Screens: a Premium audit button on a policy whose term has ended, an Audit figures step, and a Premium audits table in the policy history.
- Not done: audits for Businessowners, adding a class that the business turned out to have, audit reminders and non-compliance charges.
