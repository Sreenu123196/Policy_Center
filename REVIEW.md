# Insurance Suite: review against the implementation document (step I2)

Date of review: 18 October 2026. Built in 25 commits, 44 test files, 479 tests, 23 migrations, about 9,600 lines of code and about 7,400 lines of tests, plus configuration under `config/`.

This review compares what was built with the Insurance Suite implementation document (v1.0 draft), section by section, says honestly what is missing, and proposes what to extend next. The scope was agreed at the start: a **learning version** with one product (private car, India), and billing and claims in a simpler form.

## 1. The short answer

- **The learning roadmap is complete:** all 29 steps (parts A to I) are done. Every core idea of the document works end to end and is tested: effective-dated policy versions, the product model as data, rating with a worksheet, underwriting with authority, bind and issue, mid-term and out-of-sequence changes, preemption, cancellation, reinstatement, renewal, billing from events, claims on the policy as it was on the loss date, and a REST API with screens.
- **Against the whole document it is about 55% (an estimate).** I earlier said 40 to 50%; counting section by section (table below) gives about 55%. The core engines (sections 4 to 10, 14, 15, 17) are well covered. The parts that are mostly missing are those that make a system safe to run for real customers: sign-in and security hardening, screens, workflow and activities, forms and communication, non-functional targets, hosting and operations.
- **It is not production-ready and should not be used with real customers.** All rates, refund tables, authority limits and fees are illustrative. Hindi and Telugu texts were written by the mentor and need review by a native speaker. Real sign-in does not exist.

## 2. Scorecard by document section

"Coverage" is my judgement of how much of what the section describes exists in the learning version.

| Section | Coverage | What exists | Main gaps |
|---|---|---|---|
| 3 Technology stack | 75% | TypeScript on Node, PostgreSQL (tests pass on a real server and on PGlite), Fastify, React, Vitest, plain SQL migrations; Dockerfile, compose file and CI written (not yet run) | Running the container, deployment, hosting in India, secrets vault |
| 4 Core concepts | 95% | Account, policy, job, branch, version, fixed ids, money in paise, audit log | None of note |
| 5 Policy data model | 90% | Policy, term, versions, coverables, coverages, costs and transactions | Drivers and locations as full objects, questions and answers |
| 6 Effective dating | 90% | Slices, no-overlap rule in the database, as-of queries, out-of-sequence merge with conflicts, preemption and rebase, scenario matrix | Optimistic locking at bind (a single database and one transaction cover it today) |
| 7 Product model | 70% | Product as versioned JSON, availability rules in a safe expression language, dependencies, versions by date | Question sets, exclusions and conditions, multi-year terms (1Y_OD_3Y_TP), other products |
| 8 Jobs | 70% | Submission with options, policy change, cancellation (flat, pro rata, short rate), reinstatement, renewal with direction and non-renewal; state matrix tested for all job types | Bind-only submission and separate issuance job, rewrite, premium audit |
| 9 Rating | 65% | Rate books as data, routines, worksheet, golden tests, proration by slice, tax as its own item | Zones and fees, rate book approval life cycle, impact testing |
| 10 Underwriting | 80% | Rules, issue types with blocking points, authority profiles, referral queue, approve or reject with reasons, re-checking after edits | Question sets feeding rules, separation of duties for who writes rules |
| 11 Forms and documents | 35% | Policy and endorsement schedules, renewal and cancellation notices as PDFs, stored with checksum | Form patterns and inference, templates in three languages, e-signature, delivery by email or WhatsApp |
| 12 Activities and workflow | 10% | Referral queue only | Activity patterns, queues, assignment, escalation, timers, long-running workflow |
| 13 Security and administration | 55% | Roles and permissions, producer code security, financial and underwriting authority, audit log, separation of duties on non-renewal and payment approval | Single sign-on with MFA, group hierarchy, admin screens |
| 14 Billing | 60% | Charges from events, payment plans, invoices, payments with allocation, suspense, credits and payouts, delinquency steps and the cancellation request | Ledger and GL export, commissions, UPI AutoPay and e-NACH, minimum invoice and fees |
| 15 Claims | 55% | FNOL, policy as of the loss date, verification, exposures with a life cycle, reserves with history, payments with authority and payee checks, recoveries, incurred | Handling (segmentation, assignment, surveyors, garages, fraud, litigation), reinsurance |
| 16 Contact manager | 40% | People and companies, masked identifiers, PIN check | KYC and consent per channel, duplicate matching and merge |
| 17 APIs, events, integrations | 65% | REST with OpenAPI, idempotency keys, ETags, paging, outbox events, consumers with their own offsets | A publisher process, integration adapters (payment, KYC, SMS), contract tests |
| 18 Configuration | 60% | Versioned files, schemas, typelists in three languages, validation that lists every problem | Promotion pipeline with approvals, admin screens for business users |
| 19 Non-functional | 15% | Audit trail, Indian number and date formats | Availability, speed and scale targets, backup and recovery, security testing, privacy (DPDP), accessibility |
| 20 Screens | 10% | Quote wizard and policy file | Account file, search, FNOL, billing, UW, admin screens; Hindi and Telugu screens |
| 21 Testing strategy | 70% | Golden rating tests, effective-dating scenarios, job state matrix, end-to-end journey with invariants, architecture tests | Permissions matrix across every endpoint, contract tests, performance and security tests |

Average of these 19 rows: about 55%. Weighted by effort the core is higher and the operational parts lower, so 55% is a fair single figure. Sections 1, 2, 22 to 25 describe scope, plan and background and are not scored.

## 3. Did we follow the design rules?

The rules in `CLAUDE.md` came from the document. Checked at the end:

| Rule | Held? | Evidence |
|---|---|---|
| Money is whole paise, never floating point | Yes | Rounding is explicit at each step; tests of odd amounts; `float8` only for reading |
| Bound versions are never edited | Yes | Database triggers; a test tries raw SQL |
| Effective-dated rows never overlap | Yes | Exclusion constraint; tests |
| Modules never read each other's tables | Yes | `architecture.test.ts` reads the source; the API layer is checked too |
| Every change is audited, in the same transaction | Yes | `recordAudit(tx, ...)` everywhere; the end-to-end test names who did what |
| No personal numbers in the audit log or events | Yes | Phone and bank account checked in the end-to-end test |
| Business rules are configuration, not code | Mostly | Products, rates, rules, plans, reasons, limits are files. A few numbers are still in code (30 days of quote validity, Policy's notice wording) |
| Tests first | Mostly | Written first throughout; in a few steps the first run was already green, and I said so |

## 4. What the end-to-end test taught us

The scenario test (step I1) found a bug that no unit test caught: after a cancellation for non-payment and a reinstatement, the cancelled instalment stayed cancelled, so Billing would never have asked for it. It was fixed. The lesson, and the reason the test stays: **modules can each be right and still be wrong together**, so rules that cross modules (money, dates, events) need invariants over the whole story.

## 5. Known weaknesses and risks (honest list)

1. **Sign-in is trusted.** The API believes the `X-User` header. Without a gateway and an identity provider in front, anyone who reaches the API can claim to be anyone.
2. **Cancellation netting is simplified.** The refund credit is what Policy computed, not what the customer actually overpaid. Cash is capped, but the logic is not a ledger.
3. **Renewal ignores claims for the no-claim bonus.** The test sets the claim-free years by hand. Who owns the claims history must be decided.
4. **Concurrency is thin.** One database and transactions keep it safe in tests; two people binding at the same instant, or two requests with the same idempotency key at once, need a lock or version check in production.
5. **No publisher or retry for events.** Consumers are run by calling a function. A bad event stops the consumer (no dead-letter table).
6. **PGlite instead of PostgreSQL in Docker.** The SQL is standard, so the switch is one file, but performance and scale were never measured.
7. **Illustrative numbers.** Rates, refund tables, limits and fees are not from a filed tariff.
8. **Translations are unreviewed**, and screens are English only.
9. **One run printed an unhandled test error** that could not be reproduced (see `PROGRESS.md`). Watch for it.
10. **The document itself warns** (section 24) that matching a commercial product's breadth is not a 15-month goal. The narrow product scope was the right call.

## 6. What to extend next

Ordered by what makes the biggest difference to being usable, not by size.

**Tier 1: make it safe to run (about 4 to 6 weeks for a small team)**
1. Run on real PostgreSQL in Docker, with CI that runs `npm run check` and a deployment to a test environment. **Update: the code and the whole test suite now run on real PostgreSQL; the Dockerfile, compose file and CI workflow are written but not yet run (no Docker or Git remote on this machine); deployment waits for a chosen host.**
2. Real sign-in: put the API behind an identity provider (OpenID Connect with MFA); replace `X-User` with a verified token; add a permissions matrix test for every endpoint.
3. An event publisher with retries and a dead-letter table; locks for idempotency keys and optimistic locking at bind.
4. Connect claims history to renewal and to the no-claim bonus; replace the simplified cancellation netting with a small ledger.

**Tier 2: make it usable (about 6 to 8 weeks)**
5. The rest of the screens: account and search, FNOL and claim summary with exposures and payments, billing and delinquency, underwriting referrals, policy change, cancellation, reinstatement and renewal, admin for users and authority.
6. Hindi and Telugu screens and documents with reviewed translations; accessibility checks (WCAG 2.2 AA).
7. Activities and queues for referrals, claims handling and delinquency.

**Tier 3: broaden the business (each about 2 to 3 months)**
8. Forms and documents: templates per language, form inference, e-signature, delivery by email and WhatsApp.
9. The accounting sub-ledger with GL export, commissions and statements.
10. More products (two-wheeler first, as the document plans), question sets, multi-year terms, rewrite and premium audit.

**Tier 4: go-live readiness**
11. Performance and scale tests against section 19, security scan and penetration test, backup and restore drills, data protection (DPDP) review, hosting in India, data migration and a parallel run if replacing a system.

## 7. What was learned (for the student)

The concepts to be able to explain in your own words, each with the step where it was built:

- Policy, term, version, job and branch, and why a bound version is never edited (D2, D6).
- Fixed id versus row id, and slices with from-inclusive, to-exclusive dates (D2, E1).
- Out-of-sequence change, conflict, preemption and rebase (E2).
- Product, rate book and rules as versioned data, and golden tests (D1, D4, D5).
- Why modules talk through events and never read each other's tables, and what idempotent means (D6, F1, F2).
- Reserves, incurred, and financial authority (G2).
- Why an API takes an idempotency key and an ETag (H1).
- Why a cross-module invariant test exists (I1).

A good final exercise: pick one deferred item above, write its test first, and implement it.
