# Learning notes

Concepts learned so far, in simple words. All customers here are made-up.

## A1. The big picture (document sections 1, 2, 4, Appendix E)

- An insurer must answer four questions: who is the customer, what contract exists on a given date, what money is owed and paid, and what happened after a loss. Insurance Suite has one module for each, plus a shared platform.
  - **Contacts**: one record per person or company, shared by every module.
  - **Policy**: the contract and every version of it.
  - **Billing**: charges, invoices, payments.
  - **Claims**: first notice of loss, exposures, reserves, payments.
  - **Platform**: users, roles, audit log, tasks, events, documents.
- The suite is a **modular monolith**: one application, but each module has its own data and API. A module never reads another module's tables. Modules talk through APIs and events (for example `PolicyBound` makes Billing create invoices).
- **Account**: the customer relationship. It holds an account number, a status and a producer of record, and links to contacts with roles (named insured, driver, financier, billing contact). Names, addresses and phone numbers live in the **Contact**, not in the Account.
- **Policy**: the contract across all its terms. The policy number never changes.
- **Policy period**: one **version** of one **term**. A renewal creates a new term. Every bound job creates a new version of a period.
- **Job**: a unit of work that changes a policy. Eight types: Submission, Issuance, Policy Change, Cancellation, Reinstatement, Renewal, Rewrite, Audit.
- **Branch**: a working copy of a policy period inside a job. A submission can have several branches (quote options); one is bound.
- **Coverable**: the thing insured (vehicle, driver, location). **Coverage and term**: a cover and its values (sum insured, deductible).
- **Effective-dated**: true only between two dates. **Slice**: a stretch of the period where nothing changes; each slice is rated separately.
- **Rate book**: versioned rate tables and steps. **UW issue and authority profile**: a risk question raised by a rule, and who may approve it up to what value.
- Words to know: bind (the policy becomes legally effective), endorsement (a mid-term change), FNOL (first notice of loss), IDV (insured declared value), NCB (no-claim bonus), reserve (money set aside for a claim), producer code (a selling agent's code), out of sequence, preemption.

### Correction from my own exercise
A policy change job does **not** update the old policy period. It copies the latest bound version into a branch, changes the branch from an effective date, and binding saves it as a **new version**. Version 1 stays exactly as it was.

## A2. The data model and effective dating (sections 5 and 6)

- Every effective-dated object has a **fixed id** (same in every slice and version) and a row id per slice.
- A new job **copies** the latest bound version. Bound versions are never edited.
- Money is stored as **whole paise** with a currency code.
- **Costs** say what a version charges. **Transactions** say what changed against the version it was based on; Billing receives transactions.
- Effective dating answers: what did the policy look like on a given date, and what does each stretch cost.
- Editing "from date D" splits any row that spans D and changes only the part from D to the end of the period.
- Rating cuts the period at every change date. Each slice is rated and prorated by days.
- **Out-of-sequence change**: effective earlier than a change already bound. Merge: start from the latest bound version, apply the change from its date, check each later change that touched the same field, let the later change win by default (the user confirms or overrides), re-rate all slices, compute transactions against the latest bound version.
- **Preemption**: when one open job binds, another open job on the same policy must rebase onto the new version before it can bind.
- **Optimistic locking**: a version number on the policy period stops two binds from colliding.
- PostgreSQL's exclusion constraint on date ranges makes overlapping slices impossible (Appendix A).
- This is the biggest technical risk in the whole project, so the scenario test matrix comes before policy-change code.

## B1. Project and Git
- A Git repository records every change as a commit, so we can see what changed and why, and go back.
- `.gitignore` keeps secrets (`.env`), downloaded packages (`node_modules`) and build output out of the repository. `.env.example` is allowed because it holds no real values.
- The repository is local only. No remote has been connected.

## B2. TypeScript, Vitest, linting, module folders
- **TypeScript** adds types to JavaScript so mistakes (for example mixing rupees and paise) are caught before the code runs. `strict` turns on the strictest checks.
- **Vitest** runs the tests. `npm test` runs them once; `npm run test:watch` re-runs them as files change.
- **ESLint** with typescript-eslint finds likely bugs and style problems without running the code.
- `npm run check` = type check, then lint, then tests. Run it before every commit.
- Tests come first: we wrote the test, watched it fail for the right reason (the module did not exist), then wrote the code until it passed.
- The five module folders (contacts, policy, billing, claims, platform) each have a public `index.ts`. Other modules may only use a module through that file.
- In ES modules, imports of our own files end in `.js` even though the source file is `.ts`. This is how Node's module system works.

## B4. Technical rules in CLAUDE.md
- CLAUDE.md is read at the start of every session, so rules written there apply every time.
- Rules we recorded: run `npm run check` before commits; each module is used only through its `index.ts`; money is whole paise; effective ranges are from-inclusive and to-exclusive; bound versions are never edited; every change is audited; tests first.

## B3. Local PostgreSQL and SQL migrations
- A **migration** is a numbered SQL file that changes the database one step at a time. A tracking table (`platform.schema_migrations`) records each file and a fingerprint (checksum) of its contents.
- Files run in name order, each exactly once. A file that has already run is history: if it changes, the runner stops. To change the database again, add a new file.
- Each file runs in a **transaction** with its own record. If anything fails, nothing is saved.
- **One schema per module** (contacts, policy, billing, claims, platform) makes "modules never read each other's tables" a database-level boundary.
- `btree_gist` lets PostgreSQL's exclusion constraint compare equality and date ranges together, which is how slices of one object are prevented from overlapping (Appendix A).
- **PGlite** is PostgreSQL running inside Node, used because Docker is not installed. The SQL is the same as for a normal server.

## C1. Contacts (section 16)
- A **Contact** is one record per person or company, shared by every module through its id. Names, addresses, phones and identifiers live here, not in the Account.
- Identifier formats: PIN is 6 digits, not starting with 0. PAN is `AAAAA9999A`, and its fourth letter is the holder type (P = person). GSTIN is 15 characters containing a state code, the company's PAN, an entity number, the letter Z and a check character. These checks are about the **format**; proving a number really exists needs an outside service behind an adapter.
- **Aadhaar is never stored in full.** It is masked to `XXXX XXXX 0123` the moment it arrives, and the full number goes no further. The PAN is kept in full for tax use but shown masked (`ABCPK****D`).
- **Two layers of defence:** the code validates, and the database `CHECK` rules validate again. A test bypasses the code and shows the database still refuses a full Aadhaar.
- Input is **tidied** first (trim spaces, capital letters for PAN and GSTIN), then **all** problems are returned together as a `ValidationError`, so a screen can show them at once.
- Phone numbers are saved in one standard form (`+91` and ten digits), so the same number is never stored several ways.
- Dates are read back as plain text `yyyy-mm-dd` so a time zone cannot shift a birth date.
- Tests use obviously made-up people and numbers only.

## Self-check list (A3, no quiz this time)
I can explain in my own words: policy period, job, branch, slice, out-of-sequence change.
