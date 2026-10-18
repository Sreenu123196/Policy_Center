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
| D4 to D6 | Rating, underwriting, bind | Next: D4 |
| E1 to E4 | Policy change, out-of-sequence, cancellation, renewal | Not started |
| F1, F2 | Billing, simple version | Not started |
| G1, G2 | Claims, simple version | Not started |
| H1, H2 | REST API, React screens | Not started |
| I1, I2 | End-to-end test, review | Not started |

## Environment
Windows 11, 16 GB memory. Node.js v22 (LTS), npm 10, Git 2.55 installed. Docker is not installed.

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
