# Progress

Learning project: Insurance Suite (private car, India), following `docs/Insurance-Suite-Implementation-Document.pdf`.

## Working agreement (updated 18 Oct 2026)
- Student level: intermediate. Explanations in English only. Code, names and comments in English.
- Sessions of about 1 hour.
- The student asked for no questions between steps: the mentor explains each step as it goes and continues. The mentor still stops for anything that needs a decision (for example installing software globally).
- Git commits stay local until the student asks for a remote.

## Roadmap status

| Step | What | Status |
|---|---|---|
| A1 | Big picture and glossary | Done |
| A2 | Data model and effective dating | Done |
| A3 | Quiz | Replaced by the self-check list in LEARNING_NOTES.md |
| B1 | Tools check, project, Git repository | Done |
| B2 | TypeScript, Vitest, linting, module folders | Done (`npm run check` passes) |
| B3 | PostgreSQL and SQL migrations | Done, using PGlite instead of Docker (see Decisions) |
| B4 | Technical rules in CLAUDE.md, notes files | Done (done before B3, which needs a decision) |
| C1 | Contacts: people and companies, PIN code, masked identifiers | Done (27 tests pass) |
| C2 | Accounts and producer codes | Done (40 tests pass) |
| C3 | Users, roles, permissions and the audit log | Done (58 tests pass) |
| C4 | Typelists and loading versioned configuration | Done (73 tests pass). Part C is complete. |
| D1 | Product model for private car as JSON, with validation | Done (102 tests pass) |
| D2 | Policy, job and branch tables; effective-dated tables with the no-overlap rule | Done (119 tests pass) |
| D3 | Submission job from Draft to Quoted, with several quote options | Done (153 tests pass) |
| D4 | Rating engine: rate books, routines, worksheet, golden tests | Done (174 tests pass) |
| D5 | Underwriting rules, issue types, authority and referral | Done (196 tests pass) |
| D6 | Bind and issue, policy schedule PDF, outbox | Done (216 tests pass) |
| E1 | Policy change in sequence: slices, prorating, transactions | Done (239 tests pass) |
| E2 | Out-of-sequence changes and preemption, with a scenario matrix | Done (253 tests pass) |
| E3 | Cancellation (flat, pro rata, short rate) and reinstatement | Done (283 tests pass) |
| E4 | Renewal: window, direction, offer, non-renewal | Done (302 tests pass) |
| F1 | Billing: charges from events, payment plans, invoices | Done (340 tests pass) |
| F2 | Payments, allocation, suspense, credits, missed payments and the cancellation request | Done (369 tests pass) |
| G1 | First notice of loss and the policy as of the loss date | Done (389 tests pass) |
| G2 | Exposures, reserves, payments, recoveries and the financial view | Done (417 tests pass) |
| H1 | REST API with an OpenAPI description for the main flows | Done (435 tests pass) |
| H2 | React screens: quote wizard and policy file, with a dev server | Done (462 tests pass) |
| I1 to I2 | End-to-end test from quote to claim to renewal, review against the document | Next: I1 |
| E1 to E4 | Policy change, out-of-sequence, cancellation, renewal | Not started |
| F1, F2 | Billing, simple version | Not started |
| G1, G2 | Claims, simple version | Not started |
| H1, H2 | REST API, React screens | Not started |
| I1, I2 | End-to-end test, review | Not started |

## Environment
Windows 11, 16 GB memory. Node.js v22 (LTS), npm 10, Git 2.55 installed. Docker is not installed.

## Deferred from H1
- Sign-in: the API trusts the `X-User` header, which in production is set by an identity provider or gateway after OpenID Connect sign-in with MFA (document sections 13 and 17). Without such a gateway, anyone who can reach the API could claim to be any user. Tokens, sessions and MFA are not built.
- There is no server runner yet. `createApp(db, config)` builds the API and the tests drive it with `app.inject`; a `start` script (a build step that turns the TypeScript into JavaScript, loads a persistent database, runs migrations and listens on a port) is needed for the React screens and arrives with H2. PGlite is in memory today, so a real run also needs a database path.
- The API covers the main flows only: contacts and accounts, a submission through quote, bind and issue, the policy as of a date, cancellation, billing view, payments, and claims through exposure, reserve and payment. Missing: policy change, reinstatement and renewal endpoints, underwriting referral and decisions, rebase and merge conflicts, credits and refunds, delinquency run, recoveries, FNOL attachments upload, document download, audit log reading, user and role administration, and configuration administration.
- Rate limiting, request size limits, CORS, TLS, structured request logging with a request id, and audit of failed sign-ins are not built.
- The OpenAPI description lists request bodies and parameters; the response bodies are described only as objects. Response schemas, examples and error examples are not yet written, and there is no generated client.
- Idempotency keys are kept without an expiry. Two requests with the same key at the same moment could both run before the first answer is stored; a lock or a unique "in progress" row is the production answer.
- ETag/If-Match is on the one edit endpoint (change a cover). Quote, bind and the other actions rely on job and branch status checks; they do not use ETags.
- Lists are paged with `limit` and `offset` read into memory and cut. Cursors, sorting and more filters, and a database-level page, come when the data grows.
- Read endpoints are scoped by producer code through the account, but the claims and billing endpoints for staff roles (`account.view_all`) show everything. Field-level security (hiding premium from a producer, for example) is not built.
- Added the dependency `fastify` and the permissions `billing.pay`, `claim.report` and `claim.handle`.
- Dates for "today" come from a clock that tests can set; the API uses the server's date.

## Deferred from H2
- Only two screens exist: the quote wizard and the policy file. Not built: account and contact screens, the claims screens (FNOL wizard, claim summary, exposures, reserves, payments, recoveries), billing screens (invoices, payments, suspense), underwriting referral and approval screens, policy change, cancellation, reinstatement and renewal screens, and admin screens for users, roles, authority and configuration (document section 20).
- Screens are in English only. The product, typelists and documents have Hindi and Telugu names, but there is no language switch and no translation of screen text. Screens are not tested for accessibility beyond using labels and headings, and the layout is not tested on a phone.
- Sign-in is a choice of demo user in a drop-down (the API's `X-User` header). A real sign-in with the identity provider replaces it.
- The wizard keeps its work in the page: reloading the page loses the draft, although what was already saved on the server (a customer, a submission) remains. A list of "my open quotes" to come back to is not built, and the wizard has no way to change a step after the quote except "Start again".
- The wizard creates a new customer each time unless an existing one is chosen; there is no search or duplicate check, and a new customer is always a person, not a company.
- "Today" in the browser is the browser's date, in UTC; the server uses its own date for quote validity.
- Documents open in a new tab from a download that carries the sign-in; pop-up blockers may stop it.
- Running: `npm run api` (build and start on port 3000 with a data folder in `.data/`), `npm run web` (Vite on port 5173, passing `/v1` to the API; set `API_URL` when port 3000 is taken), `npm run build:web` (a static build into `dist-web/`, ignored by Git). The API server keeps its database in `.data/insurance-suite` and adds the demo users on every start. Nothing serves the built screens yet.
- Added the dependencies `react`, `react-dom` and, for development, `vite`, `@vitejs/plugin-react`, `jsdom` and the Testing Library. The screen tests run in a simulated browser (jsdom), not a real one. I also checked the wizard and the policy file by hand in a real browser against the real API.

## Deferred from G2
- Part G is complete. Handling features of document section 15 are not built: segmentation (fast track or complex), assignment rules and work queues, activities, surveyor appointment where rules require it, the cashless garage network, fraud indicators beyond the two flags, litigation, and reopening a closed claim as a whole. A handler is a name on an exposure.
- Reserves are set by a person. Automatic initial reserves from the cause or the insured value, and reserve review dates, are not built.
- Payment approval is one second person with enough payment limit. Approval chains, dual limits per cover or per cost type, and rules by claim size are not built. Reserve changes above a person's limit are refused (no approval queue).
- Payments are records with a masked instrument. Real payment through a bank or UPI adapter, payee verification against a bank (name match), TDS and GST on claim payments, and returned (failed) payments are not built. A payment cannot be reversed.
- Own damage is paid up to the insured value on the loss date; the deductible (voluntary or compulsory) and depreciation are recorded or deduced by hand, not worked out. The deductible recovery is a manual entry. Third-party payments have no limit.
- A claim is not linked to billing: unpaid premium does not stop a claim (the policy was in force that day), and a settled claim does not change the no-claim bonus at renewal. Renewal still adds one claim-free year; claims should reset it (an open point from E4).
- Recoveries are booked only against the claim cost, and a recovery cannot be more than was paid. A recovery before payment (an expected one), and recovering expenses, are not modelled.
- The financial figures are read from the tables on request; there is no month-end snapshot, and no reinsurance or ledger entries (document section 14, accounting).
- Claims-side permissions (`claim.pay`) are checked at the API edge in H1; the financial authority limits are checked in the domain.

## Deferred from G1
- Exposures (one claimant against one cover), reserves, payments, recoveries and the financial view (incurred = paid + outstanding reserves - recoveries): step G2.
- Claim statuses (submitted, under review, documents pending, approved, settled, rejected, closed) exist in the table but only `submitted` is set; the life cycle and its allowed moves come with exposures in G2.
- Handling (document section 15): segmentation into fast track or complex, assignment to a handler, activities, surveyor appointment, cashless garage network, fraud indicators and litigation are not built. A late report and a possible duplicate are the only flags.
- The reporter (name and phone) is kept as text on the claim. A claimant or witness should be a contact in the Contacts module with consent rules; that link is not built. Phone numbers are kept out of the audit log and events.
- Attachments are references (a file name or id) only. The file store is an adapter that is not built (document section 17).
- Coverage verification checks that a cover the cause needs was on the policy that day. It does not yet check the exclusions, the driver's licence, the vehicle's registration against the one reported, a deductible calculation or a limit. The policy snapshot (insured value, deductible term) is kept so those checks can be added.
- The policy as of the loss date uses the newest bound version of the term containing the date, as known now. A version bound after the report (an out-of-sequence change) would show on a later lookup but the claim keeps the snapshot of the moment it was reported.
- Added the Policy public API `getPolicyAsOf` and `findPolicyNumbersByRegistration`. Visibility by producer code (who may see a claim) is checked at the API edge (H1).
- The Hindi and Telugu names in `loss_cause.json` were written by the mentor and need review.
- Shared test setup moved to `src/testing/golden-policy.ts` for all modules.

## Deferred from F2
- Part F is complete. The double-entry sub-ledger, the daily export to the general ledger, commissions, payment gateway adapters, UPI AutoPay / e-NACH mandates and automatic matching of bank statements are not built. Payments are entered by a person or a script.
- Netting a cancellation against what was really billed and paid is simplified: payment items not yet invoiced and falling due on or after the cancellation date are voided, the refund credit is the amount Policy computed, and cash is paid out only up to what the customer paid for the policy beyond what the insurer keeps. Invoices already issued for dates after the cancellation are not voided; the credit can be applied to them.
- Delinquency steps are recorded and announced as events (`DelinquencyStarted`, `FinalNoticeDue`, `CancellationRequested`), but no reminder or notice document is made or sent (SMS, email, WhatsApp adapters, document section 17).
- Policy handles `CancellationRequested` and `ReinstatementRequested` by starting jobs; a person still quotes and binds them. Whether a cancellation for non-payment may bind itself automatically after a final notice is a business decision left open.
- A late payment for an invoice asks for reinstatement only if a cancellation was requested for that invoice. If the invoice was paid in part before the request, the request still fires on the whole invoice; partial-payment arrangements are not modelled.
- Refunds of unapplied cash (an overpayment the customer wants back) and bank-reversal of payments (a bounced cheque or failed UPI) are not built. A payment cannot be reversed.
- `done_on` of the reinstatement-requested step uses the database date (`current_date`), not a date passed in.
- The consumers (Billing reading Policy, Policy reading Billing) are run by calling the function; a scheduler and a dead-letter table for poison messages come with operations.
- Policy reads Billing's events by type and policy number only; it trusts Billing's policy numbers. Event signing is not built.

## Deferred from F1
- Payments, allocation, the status of invoices (paid or overdue), delinquency steps and the cancellation request: step F2. Invoices are made but nothing marks them paid yet.
- Credits (return premium) are recorded but not paid out or applied: F2. Unbilled payment items of a policy that is cancelled are not voided yet; F2 must net them against the refund.
- A minimum invoice amount, invoice fees, and merging a small item into the next invoice (document section 14) are not built. Items of one account due on the same day in the same batch share an invoice; an item that appears after the invoice for its day was made gets its own invoice.
- The double-entry sub-ledger and the daily export to the general ledger, commissions and producer statements, UPI AutoPay / e-NACH mandates, tax-invoice fields beyond the premium, tax and fee split (seller and buyer GSTIN, place of supply, HSN/SAC code) and a PDF invoice are not built.
- One billing account per policy account. Billing accounts per policy, per payer or for a fleet are not.
- The consumer treats a bad event as a poison message: it stops and reports, and nothing moves on until someone fixes it. A dead-letter table and alerting come with operations.
- A publisher process, the `markPublished` flag, and running `processPolicyEvents` on a timer are not built: a scheduler arrives with the API step (H1) or later.
- Billing configuration is one file per version, chosen by date; plans are not per product or per producer.
- The Hindi and Telugu names of the payment plans were written by the mentor and need review.
- Added `src/architecture.test.ts`, which checks that modules import each other only through `index.js` and never touch each other's tables.

## Deferred from E4
- Part E is complete. A claims check for the no-claim bonus: renewal adds one claim-free year to the vehicle on the assumption that no claim was made. Claims (Part G) must reduce or reset it, and the renewal should read the claims record.
- The insured value is carried into the new term unchanged. Reducing it for vehicle depreciation, or asking the customer to confirm it, is a business decision not made here.
- "Renewals move to the newest product version under rules per product": every renewal moves to the version in force on the new start date. Per-product rules to stay on an old version are not built.
- The renewal job is started by a person (or later by a scheduler). The batch that finds policies inside the renewal window and starts renewals automatically, and the pre-renewal workflow with timers, are not built (document section 12).
- The renewal offer is a PDF in English; sending it by email or WhatsApp and recording acceptance by the customer (an e-signature or payment) are not built. Acceptance is the bind.
- The non-renewal approval is separation of duties only (a different person). Which role may approve it is left to the API edge (H1) or an authority profile later.
- A policy that was non-renewed or whose renewal was "not taken" simply stays at its last term and expires; there is no "expired" state or lapse handling.
- Term length stays one year (`addYears`). The `1Y_OD_3Y_TP` terms of the product are not built.
- Renewal uses the newest bound version of the ending term, not a fresh look at the account (address, driver changes).

## Deferred from E3
- Fees: the cancellation fee and the reinstatement fee (document section 8: "may need underwriting and a fee") are not charged. A fee would be its own cost item next to premium and tax in the transaction.
- Refund of premium to the customer is only a negative transaction; paying it out is billing (F2). A cancellation for non-payment is started by billing (F2), which will call `startCancellation` with the reason `non_payment`.
- The refund is on the premium of the newest version. Cancelling a policy that had many changes uses that version's whole-term premium, which is correct because each version prices the full term; a refund of only the unpaid part is a billing decision.
- Notice days apply only to insurer-initiated reasons with notice above zero, counted from today. Notice by jurisdiction (document) is one table per product version, not per state. A cancellation date in the past is allowed for the insured and for 0-notice reasons: a business rule on back-dating is not decided.
- Short-rate and minimum-retained values are illustrative, not from a filed tariff. Tax is refunded in proportion to the premium.
- Reinstatement is only for the same term; there is no "rewrite" (a new policy after a long lapse). The reinstatement window is 30 days after the cancellation date. A reinstatement date is a whole day.
- The Hindi and Telugu names in `cancellation_reason.json` were written by the mentor and need review by a native speaker.
- Cancelling or reinstating while another job is open: change jobs are preempted; other cancellation or reinstatement jobs are not, and the "newer version was bound" check stops them at bind.
- Underwriting applies to a reinstatement through the normal quote (when `underwriting` is given to `quoteBranch`); there is no special reinstatement rule set.

## Deferred from E2
- Conflicts are found per field of a coverage's terms or a coverable's attributes. A conflict is only recorded when a slice of the object exists at or after the later change's date. A later change that added or removed a whole cover is respected (nothing is left to overwrite) but is not shown as a conflict.
- "Touched" is decided by comparing the field in the later version with the version it was based on, on the later change's effective date. A later change that touched the field twice, or in a way that the comparison on one date does not show, is not detected.
- Rebase extracts the old copy's edits field by field (set a value from a date, remove a cover from a date) and copies covers that are new in the old copy. It cannot reapply: removing a field (setting it back to "absent"), removing a whole coverable, or re-adding a cover. If an edit no longer fits, the whole rebase is refused with a message and nothing changes.
- Only policy change jobs are preempted. Renewal, cancellation and reinstatement jobs on the same policy (E3, E4) will join the same rule.
- Conflicts ask for a reason but not for authority: who may override a later change is a business decision (an authority grant in D5 style) that is left for later.
- Optimistic locking (a version number on the policy period) is not added; the bind in one transaction plus the "newer version bound" check covers the single-database learning case. Two binds at the very same moment could still race; a row lock or version check at bind is the fix for production.
- Forms and customer notices that tell the customer about a back-dated change are not built.

## Deferred from E1
- Out-of-sequence changes, merging, conflicts and rebasing a job onto a newer version: step E2. E1 only refuses to bind a change that started from an older version, with a message that points to E2.
- Underwriting rules look at the risk on the period start date only; a high insured value that starts mid-term is not seen yet. Checking every slice is a small extension.
- Rating tax is prorated per slice from the whole-term tax of each slice; a rate book with fees or minimum total premium would need a rule for prorating them (section 9).
- Edits available: change terms of a coverage, change attributes of a coverable, remove a coverage, add a coverage or coverable from a date (D2 functions). Removing a coverable (for example replacing the car), changing the term length and edits to the account (address) are not built.
- The change job has one effective date; separate edits may use other dates. The transaction uses the job's date as its effective date.
- Billing does not exist yet: transactions are saved and sent in the `PolicyBound` event; invoices come in F1.
- A bound change can be followed by another change job; the `based_on` chain is kept, and a policy can have only one term (renewal is E4).

## Deferred from D6
- The roadmap's Part D is complete. A submission is bound and issued in two calls; a separate "bind-only, issue later" Issuance job type (document section 8) is not built, because the same submission job is issued.
- Payment is not taken at bind. Billing (F1) will react to the `PolicyBound` event; an unpaid policy and its cancellation come in F2/E3.
- The schedule is English only: standard PDF fonts have no Hindi or Telugu letters. Translated templates need embedded fonts and reviewed text. Other documents (proposal, motor certificate of insurance, renewal notice ...), form patterns with inference rules (`formCodes` is always empty) and e-signature are not built.
- Documents are stored in the database as bytea. A file store with the database holding only metadata would suit large volumes.
- The outbox has a table, `recordEvent`, `listUnpublishedEvents` and `markPublished`. There is no publisher process or consumer yet (F1), and no per-account ordering guarantee beyond the event id.
- `PolicyBound` and `PolicyIssued` payloads hold small facts (policy number, version, amounts), no personal data.
- Concurrency: two people binding at once, and another job binding first on the same policy (preemption): E2. Optimistic locking is not in yet.
- Permission checks (`policy.bind`) belong to the API edge (H1).
- Library added: `pdf-lib` (pure JavaScript, no native code) to draw the schedule.

## Deferred from D5
- Editing and removing coverables and coverages (the underwriting tests change values with plain SQL to stand in for an edit): arrives with policy change, step E1. Re-checking the rules after every edit is therefore explicit (`evaluateRules`), not automatic yet.
- Binding and issuance call `checkUnderwriting` with the points `bind` and `issuance`: step D6.
- The referral is a row in the underwriter queue. The general activity and workflow system (assignment to groups, due dates, escalation) is not built.
- Authority profiles are in the rules file (by role or user name). Admin screens and a database copy for changing them without a release: H2. Authority is checked in the domain function because the limit depends on the issue; the API edge (H1) still checks the `uw.approve` permission.
- Rule conditions use facts we have: vehicle age and engine size, insured value, youngest driver age, claim-free years, owner type. Question sets (answers feeding rules and rating) are not built.
- Separation of duties (the person who writes a rule cannot approve it) and the approval of rules themselves.
- Re-evaluation of rules before renewal (the fourth point in the document): step E4.

## Deferred from D4
- Proration by slice days (document section 9, step 4) and comparing with the previous version to create transactions: step E1. D4 prices one whole period.
- Rate book life cycle (Draft, In review, Approved, Active, Retired) with approval by a second person, and impact testing against policies in force: the file has a `status` and only `active` books are used, but no approval workflow yet (needs separation of duties, with D5/H1).
- Rating zone and city factors, own-damage cover for other vehicle types, loadings, fees and minimum total premium.
- `engineCc` and `claimFreeYears` are read from vehicle attributes. A real claims history lookup and vehicle master data (make, model, variant gives cc) are future work. A missing `claimFreeYears` means 0 (no discount).
- All rates are illustrative, not from a filed tariff. The 2026.04 book is the 2026.10 base rates reduced by 10%.
- Rate books are loaded from `config/ratebooks/` into memory like products, not into the database; `loadRateBooks` is called at start-up (wiring comes with the API, H1).

## Deferred from D3
- The real rating engine: D3 takes the price from an injected `Quoter`; tests use a stand-in price labelled TEST-PRICE. Real rate books, golden tests and the worksheet arrive in D4.
- Underwriting issues that block a quote (section 10): D5. Today a quote is refused only for product-model problems (missing or unavailable coverage, bad term values, not exactly one vehicle, no model year).
- The policy term code (1Y or 1Y_OD_3Y_TP) is still not stored: D3 always quotes one year. Choosing a term comes with E4/renewal or a later extension.
- Quote validity is a fixed 30 days in code; it should become configuration. An expired quote cannot be bound: that check belongs to D6.
- Only the submission job type has a life cycle in use. The matrix allows the moves for all eight types; their work arrives in D6 and Part E.
- `startSubmission` creates the policy, job and branch in three steps after checking everything first. A crash between steps could leave an empty policy; a single transaction across the three needs repository functions that accept a transaction.
- Permission checks (who may quote, decline) belong to the API edge (H1).

## Deferred from D2
- Copying the latest bound version into a new branch (`copyBranch`), which keeps fixed ids, and editing "from a date" by splitting a slice: step E1.
- Job and branch status changes (draft to quoted and so on) and the rules for each job type: step D3. Binding, which sets `version` and `status = 'bound'`: step D6. Tests now mark a branch as bound with plain SQL in the way binding will.
- Costs, transactions and modifiers (no-claim bonus, discounts): steps D4 and E1.
- A coverage's dates must lie inside its coverable's dates: not checked yet (E1).
- Optimistic locking and preemption (a version number on the policy period): step E2.
- The policy term code (1Y, 1Y_OD_3Y_TP) is not stored on the branch yet: step D3.
- Questions, forms and documents on a branch: later.

## Deferred from D1
- Term kinds and clauses in section 7 that D1 leaves out: "package" terms (linked values), exclusions and conditions, question sets, and coverage terms of different lengths inside one policy.
- Availability by jurisdiction or date range on a single coverage (a whole version already has jurisdictions and a start date). Which fact names exist (`vehicle.ageYears`, `ownerType`) is not checked yet; D3 will define the facts.
- `terms_allowed` is stored and checked for shape but not used until quotes pick a policy term (D3).
- Renewals moving to the newest product version under per-product rules (E4).
- Hindi and Telugu coverage names were written by the mentor and need review, as with the typelists.
- Two-wheeler, home and small-business products (document section 7) are outside the learning scope.

## Deferred from C4
- The `state` on a contact is still free text. It should become an `indian_state` typelist (the full official list of states and union territories, in three languages). Translations for that list should be reviewed.
- Hindi and Telugu names in `account_contact_role.json` were written by the mentor and should be reviewed by a native speaker or the insurer's terminology team before real use.
- More typelists are added when a step needs them (cancellation reasons in E3, loss causes in Part G).
- `effective_from` is validated and stored, but not applied yet: it starts to matter for rate books and product models (D1, D4).
- Promoting configuration from development to test to production with approvals, and admin screens for configuration (H2).

## Deferred from C3
- Making the audit log tamper-evident (each entry carrying a hash of the previous one) so changes made outside the database's protections could be detected.
- Separation of duties (the person who writes a rate book, limit or rule cannot approve it): arrives with rating (D4) and underwriting (D5).
- Groups in a hierarchy (region, branch, team), underwriting authority profiles (D5) and claim financial limits (G2).
- Sign-in: the document delegates it to an identity provider (OpenID Connect with MFA). We model users and their access, not passwords.
- Permission checks at the API edge (step H1) and the admin screens (H2). Domain functions do not check permissions themselves.

## Decisions
- **PGlite instead of Docker (18 Oct 2026).** Docker is not installed, and installing it is a global change that needs the student's say-so. PGlite is real PostgreSQL (version 18.6) running inside Node as a normal npm package. It was tested with the effective-dating rules: it accepts adjacent slices, rejects overlapping ones, and answers "as of a date" queries. Migrations are plain SQL files, so they run unchanged on PostgreSQL in Docker later; only `src/platform/database.ts` would change. The student can ask to switch at any time.
- **One test database per test file (C3).** Starting PGlite takes about 3 seconds and several test files start at once, so a fresh database per test hit the 10-second hook limit. Test files now call `createTestDatabase()` once and `resetDatabase()` before each test (`src/testing/database.ts`), and `vitest.config.ts` allows 60 seconds for setup. `migrate.test.ts` still uses a fresh database per test because it tests the migration history itself.
- No migration command-line script yet. Running TypeScript files directly conflicts with our `.js` import convention, so a script waits until the API step (H1), which needs a build.

## Deferred from C1 (in document section 16, not in the roadmap step)
- KYC status and evidence, consent per channel (call, SMS, email, WhatsApp) with dates.
- Duplicate matching (name, date of birth, phone, identifiers) and a merge process.
- Roles on accounts and claims (named insured, driver, financier, claimant...). These arrive with accounts (C2) and claims (Part G).
- Checks that go beyond format: the Aadhaar check digit (Verhoeff), the GSTIN check character, and a real PIN code directory.
- The `state` field is free text until typelists exist (C4). `ValidationError` lives in Contacts for now; it moves to Platform when a second module needs it.
