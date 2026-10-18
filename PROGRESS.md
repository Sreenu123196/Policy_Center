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
| C4 | Typelists and loading versioned configuration | Next: C4 |
| D1 to D6 | Product model, policy tables, submission, rating, underwriting, bind | Not started |
| E1 to E4 | Policy change, out-of-sequence, cancellation, renewal | Not started |
| F1, F2 | Billing, simple version | Not started |
| G1, G2 | Claims, simple version | Not started |
| H1, H2 | REST API, React screens | Not started |
| I1, I2 | End-to-end test, review | Not started |

## Environment
Windows 11, 16 GB memory. Node.js v22 (LTS), npm 10, Git 2.55 installed. Docker is not installed.

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
