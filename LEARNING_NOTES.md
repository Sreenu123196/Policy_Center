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

## C2. Accounts and producer codes (sections 5 and 13)
- An **Account** is the customer relationship: an account number, a status, the **producer of record** and contacts with roles (named insured, driver, financier, billing contact). Every account has exactly one named insured. The named insured can be a person or a company.
- A **producer** is an agent or broker. A **producer organisation** (an agency) can hold several **producer codes**. The code decides what an agent can see, and later who earns the commission. Producers belong to Platform because users will belong to them (C3). Accounts belong to Policy.
- **No foreign keys between modules.** The account stores a contact id and a producer code as plain values and checks them through the other module's public door. Foreign keys are used only inside one module.
- The **account number** comes from a database sequence (`AC-0000001`), so two accounts never share one.
- A **partial unique index** (`WHERE role = 'named_insured'`) makes a second named insured impossible. The code gives a friendly message; the index is the safety net.
- **Producer code security:** the visibility filter is part of the query. An account the viewer may not see is reported as "not found", so its existence is not revealed. `'all'` means head office. In C3 the visibility will be worked out from the signed-in user.
- Opening an account saves the account and its named insured in **one transaction**.
- `ValidationError` moved to Platform because a second module now needs it. A malformed id returns "not found" rather than a database error.

## C3. Users, roles, permissions and the audit log (sections 13 and 5)
- A **user** is a person or an AI **agent** with a username. Agents get their own login so their actions are audited like anyone's.
- A **role** is a named bundle of **permissions**. The list of permissions is fixed in code; roles are data an administrator can change without a code release. A user holds every permission of every role they have. A deactivated user holds none.
- `hasPermission` answers "may this user do this?" with one query. `requirePermission` throws a `PermissionError` and is meant for the API edge (step H1). Domain functions do not check permissions themselves.
- **Producer code security is now driven by users:** `visibilityFor` gives head office `'all'`, an agent their own producer codes, and anyone without the right permission nothing. It plugs straight into C2's `listAccounts`.
- The **audit log** records who (person or agent), what, which thing and when. It is **append-only**: database triggers refuse updates, deletes and truncates, so even our own code cannot rewrite history.
- An audit entry is written **in the same transaction** as the change, so they are saved together or not at all. A refused change records nothing. Details hold small facts only, never Aadhaar or PAN.
- Sign-in is not our job in this project: the document hands it to an identity provider (OpenID Connect with MFA). We model users and what they may do.
- **Testing lesson:** starting a database takes about 3 seconds, and several test files start one at once. A fresh database per test made setup time out. The fix is one database per test file plus a fast reset between tests. The reset must skip the audit log's protection triggers, which is acceptable only in test support code.

## C4. Typelists and versioned configuration (section 18)
- Things that change with the business live in **versioned configuration files**, not in code: typelists now, later the product model, rate books, rules and plans.
- A **typelist** is a managed list of codes. Each entry has a code, a name in English, Hindi and Telugu, a sort order and a **retired** flag. Codes are **never deleted or reused**: an old code is retired, because old records still use it.
- Files are **checked against a schema** (we use the zod library). The check reports **every** problem in **every** file together, and if any file is bad, nothing is loaded.
- Every file carries a **version** (such as 2026.10.1) and an `effective_from` date. A loaded version is history: loading the same version again does nothing, changed content under the same version is refused, and an older version is refused. To change a list, publish a higher version.
- The **version history** (`platform.config_version`) and the **audit log** record who loaded which version and when.
- Policy's account contact roles now come from the `account_contact_role` typelist. Retiring a role is a configuration release; no code or database change is needed. The role `named_insured` stays in code because "exactly one named insured per account" is a business rule, not configuration.
- **Bug lesson:** `new Date('2026-13-45')` is an invalid date, and calling `toISOString()` on it throws a `RangeError`. Our C1 date check had that flaw, hidden because its test used February 30th, which JavaScript quietly rolls over into March. The fix is one shared `isRealDate`. A new kind of test case (a month that does not exist) exposed it.
- Hindi and Telugu names written by the mentor should be reviewed by a native speaker before real use.

## D1. The product model (section 7, Appendix C)
- A **product** is configuration, not code. A product file names the product and its **version**, the date it applies from (`effective_from`), the jurisdictions, the policy terms allowed, and a **line** with its coverables (Vehicle, Driver) and coverages. All amounts are whole paise, so Rs 50,000 is `5000000`.
- A **coverage** has a code, names in English, Hindi and Telugu, a category and an **existence**: `required` (always on when available), `electable` (the customer may choose it) or `suggested` (recommended).
- A **term** is one value of a coverage: an `option` from a list (a deductible of 0, 250000 or 500000, with a default) or a `direct` number between `min` and `max` (the insured value).
- **Availability rules** (`available_when`) such as `vehicle.ageYears <= 5` say when a coverage can be offered. **Dependencies**: `requires` ("zero depreciation requires own damage") and `excludes`.
- **New business uses the product version in force on the start date.** Two versions of private car (2026.04 and 2026.10) show this: the minimum insured value is Rs 30,000 in one and Rs 50,000 in the other.
- **Two kinds of validation.** (1) The file itself: the schema checks shape, and cross-checks verify that parts agree (a dependency points at a real coverage, two required coverages do not exclude each other, a rule parses, versions start on different dates). Every problem in every file is reported together. (2) A customer's choices against the product: a coverage must exist and be available, every available required one must be chosen, dependencies must hold, and each term needs a legal value or a default.
- **Why a tiny expression language and not `eval`:** running text from a file as code would let a product file do anything. The tokenizer and parser only understand comparisons, `and`, `or`, `not` and brackets. `and` binds tighter than `or`. A fact that is missing makes a comparison false, so an unknown fact never offers a cover by accident. Fact lookup uses `Object.hasOwn`, so it never reaches things built into JavaScript.
- The product catalogue is loaded from files into memory at start-up (as the document says), unlike typelists which live in the database. Old versions stay in the repository, so they remain available, and Git keeps their history.
- **Testing lesson:** when two tests failed I read the real messages first. The schema was right (a one-letter code is not allowed); my test data was wrong.

## D2. Policies, jobs, branches and effective-dated tables (sections 4, 5, 6, Appendix A)
- A **policy** is the contract with a number that never changes. A **job** is a unit of work on it (eight types), starting as a draft. A **branch** (a `policy_period` row) is a working copy of one term inside a job. When bound it gets a **version** number and is never edited again. A branch and a version are the same table; the version number is given at binding, and a CHECK rule says a row has a version if and only if it is bound.
- A branch records the **term number**, its start and end dates (the end is exclusive) and the **product version in force on the start date**.
- **Effective-dated rows** (coverables like a vehicle or driver, and coverages) are true only between `eff_from` and `eff_to`. Each object has a **fixed id** (the same in every slice and every version) and a **row id** per slice.
- The range is **half-open**: it includes its first day and excludes its last. So one slice can end on 1 October while the next begins on 1 October, and "what was true on 1 October" returns the later slice.
- **Slices of one object never overlap.** PostgreSQL's exclusion constraint on `daterange(eff_from, eff_to)` refuses it, but different objects may cover the same dates. The code checks first to give a clear message; the database remains the safety net if two requests race.
- **Rows must lie inside the policy period.** Checked in the code and again by a trigger.
- **A bound version is never edited.** Triggers refuse any insert, update or delete on its rows, and any change to the period itself, so even a raw SQL command is refused. Binding is the only way a branch becomes bound.
- "As of a date" is one simple query: `eff_from <= date and date < eff_to`.
- Policies obey **producer code security**: `getPolicy` hides a policy the viewer may not see as "not found".
- Every create writes an **audit entry** in the same transaction.

## D3. The submission: quoting with several options (section 8)
- A **submission** is the job that sells new business. `startSubmission` creates the policy, a submission job and the first branch (**Option A**) for one year. A policy that starts on 29 February ends on 1 March of the next year, because the end date is excluded.
- A job has a **life cycle**: only the arrows of the diagram are allowed (draft to quoted, a quoted job back to draft when edited, to withdrawn, declined or not taken ...). A test tries every pair of statuses for every job type, so a forbidden move cannot slip in. "Not taken" exists only for submissions and renewals, from quoted.
- **Quote options**: one job can hold several branches (Option A, B ...). A copy keeps the **fixed ids**, so the same vehicle is still the same vehicle in both options; after the copy, the options change independently.
- **Rating is a function we pass in** (a `Quoter`). The quote process does not care how the price is worked out, so we could test it now and plug in the real engine in D4.
- **A quote is a permanent record**: premium, tax and total in paise, 30 days of validity, the rate book and the worksheet. A trigger refuses any update or delete. Editing a quoted branch sends it (and the job) back to draft; quoting again makes a new quote and the old one stays as history.
- The **job is quoted only when every open option is quoted**. Withdrawn options do not count.
- Before quoting, the branch is checked against **its own product version**, and every problem is listed together. Facts about the risk (vehicle age, owner type) come from the branch and the named insured, so a company is never offered the owner-driver cover.
- Ending a submission (withdraw, decline with a mandatory reason, not taken) also withdraws its open branches in the same transaction, and everything is in the audit log.
- **Testing lesson:** my audit test said the job became quoted after only one of two options was quoted. That contradicted another test (and the rule), so I fixed the test, not the code.

## D4. The rating engine (section 9, Appendix D)
- A **rate book** is a versioned file with lookup **tables**, constants, a **routine** per coverage, and a tax rate. It prices one product version. Only books with status `active` are used, and the book is chosen by product and the policy start date.
- A **routine** is a list of declarative steps (input, constant, lookup, multiply, discount, subtract, minimum, round to rupee). There is no free-form code, the same safety idea as the expression language of D1. The loader checks that every name is defined before use, tables and constants exist, and a lookup's keys match its table.
- **Lookup tables** match exact values or ranges (engine size, vehicle age). Exactly one row must match; none or two is an error, never a guess.
- **Rates are in basis points** (320 bps = 3.20%) and amounts in paise, rounded at each step. So the arithmetic is whole numbers and the result is the same every time.
- **Rating is a pure function** (`createQuoter(rateBooks)` returns the `Quoter` that D3 expects). Same request, same book, same price; the request is not changed.
- **The worksheet** records every step with its inputs, the table used, the factor found and the amount, plus one `cost` line per coverage and a separate GST line. It is stored with the quote, so any price can be explained later.
- **Golden tests** are fixed risks with the exact premium worked out by hand from the rate book: a basic policy, a voluntary deductible, the minimum premium, rounding, add-ons, other rows of the base-rate table, and the older book. If someone changes a rate, a golden test fails and the change must be confirmed on purpose.
- Missing facts are reported (no engine size) and a missing claim history means no discount; the engine never invents an input.
- **Testing lesson:** my first failure was a one-letter table name in the test data, rejected by the schema (the same lesson as D1). Read the real message first.

## D5. Underwriting: rules, issues, authority and referral (section 10)
- A **rule** is a condition on the facts of the risk, written in the same safe expression language as the product model (`idv > 300000000`). When it is true it raises an **issue** of an **issue type**, carrying the **value** that caused it (an insured value in paise, a driver age in years).
- An **issue type** says which step it **blocks**: the quote, the bind, the issuance, or nothing (information only). Rules are checked at fixed points (quote, bind, issuance). One rule gives at most one issue per branch; it is reopened, never repeated.
- **Authority profiles** say who may approve which issue types, up to which value. A person holds a profile through a role or by name. Approving needs a grant whose limit reaches the **approval ceiling** (a junior may approve a Rs 35,00,000 insured value up to Rs 40,00,000, but not up to Rs 45,00,000). Rejecting needs only a grant for that issue type.
- **Referral**: anyone can press "Request approval". The issue becomes `referred` and a task with the context (policy, job, issue type, value) goes into the underwriter queue.
- **Decisions are history**: approve, reject or approve with conditions, always with a reason, and kept with who and when. A trigger refuses any change to them. An approval has a ceiling and a last valid day.
- **Re-checking**: after an edit, the rules run again. An approval still counts if the new value is inside what was approved, otherwise the issue reopens. For insured value (`max`) "inside" means at or below the ceiling; for driver age (`min`) it means at or above the floor. An issue whose rule stops firing is cleared. An approval also runs out after its last day.
- A blocked quote is refused, but its issues are saved first, so the underwriter can see them. The audit log records raising, referring, deciding, reopening and clearing.
- **Design choice:** the point where a rule is checked and the point an issue blocks are separate, because a young driver can be noticed at quote time but only matter at bind.

## D6. Bind, issue, the schedule and the outbox (sections 8, 11, 17)
- **Bind** accepts the risk. The chosen quoted option becomes **version 1** of the policy term: `status = bound` with a version number, which the database allows only together (the CHECK rule from D2). From then on triggers refuse any change to it, even raw SQL. The next bound version of the same term gets the next number.
- The job walks **quoted, binding, bound** inside one transaction, so it can never be left half way. The other options are withdrawn.
- Bind has gates: only a quoted job; the option must belong to the job; the **quote must still be valid** (the last valid day still counts); and **underwriting issues that block the bind** must be approved first (`checkUnderwriting` with the point `bind`). A refused bind changes nothing.
- **Issue** moves bound to issued and produces the **policy schedule**. Issuance is a separate underwriting point, so a block there stops it.
- **The schedule is built in two steps**: first plain text lines (tested exactly), then drawn into a PDF with `pdf-lib`. Money is shown in rupees with Indian grouping (Rs 12,34,567.89), dates as DD-MM-YYYY; the database still keeps paise and yyyy-mm-dd.
- A **stored document** has its content, a **SHA-256 checksum**, and metadata (policy number, job, version, form codes, conditions). It is never changed; a trigger refuses it. A correction would be a new document.
- **The outbox**: the event `PolicyBound` or `PolicyIssued` is written in the same transaction as the change. If the change rolls back, the event never existed. A publisher later reads unpublished events in order and consumers (billing) must handle a repeat. This is how modules talk without reading each other's tables.
- Underwriting conditions that were approved with conditions are printed on the schedule.

## E1. Policy change in sequence (sections 5, 6 and 9)
- A **policy change job** copies the **latest bound version** into a new branch. The copy keeps every **fixed id** and records `based_on` (the version it came from). Version 1 is never touched.
- Every edit has an **effective date** (the job's date unless given). The edit **splits** the slice that spans the date: the days before keep the old values, and from the date to the end of the period (the window) the new values apply. Slices that start later are changed whole. A removal ends the cover from the date. The no-overlap rule of the database still holds after every edit.
- **Rating by slices**: the period is cut at every date where anything changes. Each slice is priced as a whole year, then **prorated** by `slice days / term days`. Each cost is prorated and rounded to a paise, and the premium is the sum of those costs, so the numbers add up exactly. A change that alters nothing prices to exactly the old premium.
- Every slice is checked against the product, and a problem is reported with its date ("From 01-01-2027: ...").
- On bind, the **transaction** is the new premium minus the premium of the version it was based on: a charge when positive, a **refund when negative**. Version 1 has a `new_business` transaction. Billing will receive only the difference, in the `PolicyBound` event. Transactions cannot be changed.
- **Another job may bind first.** If the policy has a newer version than the one this job started from, binding is refused until the job is rebased (E2). This is the beginning of **preemption**.
- The change is **issued** with an **endorsement schedule** that shows the effective date and the premium change.
- Worked example: zero depreciation added from 1 January, 78 of 365 days after the start. Old cover costs 1,574,600 for the year; zero depreciation costs 240,000 for the year, so for 287 days it costs 188,712. The transaction is +188,712 premium and +33,968 tax.

## E2. Out-of-sequence changes and preemption (section 6, Appendix B)
- A change is **out of sequence** when its effective date is earlier than a change that is already bound. The new job still starts from the **latest bound version** (so nothing later is lost), and the edit is applied from its date to the end of the period.
- **Carry forward.** If the later change did not touch the field being edited, the new value simply runs on through the later slices. Example: version 2 adds zero depreciation from 1 January; version 3 raises the insured value from 1 December; the result keeps zero depreciation and rates it on the new insured value.
- **Conflict.** If the later change set the same field, then from the later change's own date the **later change wins by default**, and a **merge conflict** is recorded with both values. A person must **keep later** (confirm it) or **override** (apply the new value from the later date). A reason is always required, it is audited, and the quote cannot be made while a conflict is open.
- **Which changes count.** Only **bound** changes dated **after** the edit. Another open draft never causes a conflict. A change dated on the same day or earlier is simply in sequence.
- **Transactions** are taken against the version the new one was based on, with the effective date of the new change, so billing sees a charge or a refund on the right date. Rounding example: prorating third-party premium in three slices gave 341,601 for the term, one paisa more than 341,600. Each cost is rounded on its own so everything adds up.
- **Preemption.** Two jobs can be open on one policy. When one binds, every other open change job is moved to **preempted**, with the reason in the audit log. A preempted job cannot be edited, quoted or bound.
- **Rebase.** `rebaseJob` makes a new copy of the newest version, applies the preempted job's own edits again (same merge rules, so conflicts are recorded if the new version touched the same field), withdraws the old copy and returns the job to draft. It runs in one transaction: if an edit no longer fits, nothing changes.
- Scenario matrix tested: carry forward, conflict, keep later, override, different field, same day, later date, removed cover, unbound rivals, preempt, blocked actions, rebase with and without conflict, and a rebase that cannot be reapplied.

## E3. Cancellation and reinstatement (section 8)
- A **cancellation job** makes a new version in which the cover **ends on the effective date** (`cancelled_on`). Days before it stay covered. The refund is worked out when the job starts and kept as a permanent record (the **cover adjustment**) with a worksheet; the job is "quoted" until someone binds it.
- **Three refund methods.** *Flat*: everything comes back, only possible from the first day of the period. *Pro rata*: premium x unexpired days / days in the term. *Short rate*: premium x (1 - the share a table keeps for the days in force), so the customer gets less back when they cancel on their own.
- **Reasons decide the rules.** A reason code (a typelist, with names in three languages) says who asks (insured or insurer), which methods are allowed, and how many days of notice an insurer must give. Example: non-payment needs 15 days notice and refunds pro rata; a customer request has no notice and refunds short rate.
- **Minimum retained premium.** The insurer never keeps less than the product's minimum (or the whole premium if that is smaller). Tax is refunded in the same proportion as the premium.
- **Binding** saves the version, makes a **negative premium transaction** (a refund), sends `PolicyCancelled` to billing, and **preempts** open change jobs. A cancelled policy cannot be changed or cancelled again.
- **Reinstatement** brings the cover back. The new version is a **copy of the version before the cancellation**. *Without a gap* the premium that was refunded is charged back exactly. *With a gap* the days between the cancellation date and the reinstatement date stay uncovered, the rows are cut there, rating skips the uncovered slice, and the charge is the new premium less the part the insurer kept. A request must come within 30 days of the cancellation date.
- Reinstatement is quoted and bound like any other job, so rating and underwriting apply. Later changes to a reinstated policy are priced from the reinstated premium.
- Worked example (the golden policy): cancel from 1 January (78 days in force). Short rate keeps 40%, so 944,760 of 1,574,600 premium is refunded, with 170,057 tax. Pro rata would refund 1,238,110. Reinstating without a gap charges back 944,760.
- **Testing lesson:** my gap test expected 255 covered days after the gap, but 1 February to 15 October is 256. The code was right and my arithmetic was wrong, so I fixed the test after checking by hand.

## E4. Renewal (section 8)
- A **renewal** creates the next **term** of the same policy (`term_number + 1`), not a new policy. Its first version is version 1 of term 2.
- **When it may start.** The product says how many days before expiry (60 here). Too early is refused, and so is a term that has already ended.
- **What the new term contains.** The cover as it stands on the **last day of the old term**, so every change made during the term is carried over. The vehicle keeps its fixed id. With no claim recorded, the vehicle gains a claim-free year, so the no-claim bonus grows (35% instead of 25% in the example).
- **Re-rated for the new term.** The product version and rate book are the ones in force on the **new start date**, so a policy sold under version 2026.04 renews under 2026.10, and old choices are checked against the new rules (the insured value of Rs 40,000 is below the new minimum of Rs 50,000 and must be raised before the renewal can be quoted).
- **Offer, then accept or not take.** The renewal is quoted like any other job. A **renewal notice** document shows the expiring and the new premium and how long the offer lasts. Binding accepts it; if the customer does not reply the job ends as **not taken**, and the branch is withdrawn so a new renewal can start.
- **Transaction.** A renewal is a **new term**, so its transaction is the whole premium of the term (kind `renewal`), not a difference from the old term. Billing hears `PolicyRenewed`.
- **A different term does not clash.** Binding a renewal does not preempt open changes to the ending term, and a change dated inside the old term is still made against the old term.
- **Pre-renewal direction.** The insurer sets `renew` (the default), `review` (holds the renewal) or `non_renew`, always with a reason. Every direction is kept as history.
- **Non-renewal** needs **approval by a different person** (separation of duties) and a **notice document sent in time** (45 days before expiry here). A policy marked for non-renewal cannot be renewed. Each step is audited.
- Worked example: term 1 premium 1,574,600; term 2 premium 1,414,600 (own damage 1,040,000 after the 35% bonus, third party 341,600, owner-driver cover 33,000), tax 254,628.

## F1. Billing: charges, payment plans, invoices (sections 14 and 17)
- **Billing learns about policies only through events.** Policy writes `PolicyBound`, `PolicyRenewed`, `PolicyReinstated` and `PolicyCancelled` into the outbox, each with the transaction (premium, tax) and the policy account id. Billing reads them and never touches Policy's tables. A test reads the source files to keep it that way.
- **A consumer keeps its own offset**: the id of the last event it handled. The batch and the new offset are saved in one transaction, so a failing batch changes nothing. Charges are unique per event, so **seeing an event twice changes nothing** (idempotent), even if the offset is lost.
- **Charges**: one row for premium and one for tax per event, negative for a refund. They say what happened; they are not payments.
- **Payment plans** are configuration (full pay, two-pay, quarterly, monthly): a down payment share, a number of instalments, days between them, an instalment fee, invoice lead days and grace days. Only new business and renewal use the plan; a **change or reinstatement is billed in one payment** on its effective date. A negative transaction becomes a **credit** to pay out or apply (F2).
- **Splitting by the plan**: the down payment is a percentage of the total, the rest is shared equally, and the **rounding left over goes into the last instalment**, so items add up exactly. Premium and tax are split by running totals, so each item shows its own tax (a tax invoice needs that) and nothing goes negative. Example: 1,858,028 quarterly = 464,507 down + three of 464,507, each later one plus a Rs 50 fee.
- **Invoices** are made by a batch on the invoice date: an item is invoiced when its due date is within the plan's lead days (15 days before for quarterly). Items of one account due on the same day share an invoice. An invoice number is `INV-0000001`. An item is never invoiced twice. Each line shows premium, tax and fee.
- Billing raises its own event, `ChargesCreated`, in the same transaction.
- **Architecture test**: modules import each other only through their public door and never read each other's tables.

## F2. Payments, allocation and missed payments (section 14)
- A **payment** is money received: amount in paise, a method (UPI, e-NACH, card, bank transfer), a **reference**, and a date. The **same reference is the same payment**, so a gateway calling twice counts once; the same reference with another amount is refused.
- **Allocation, oldest first.** A payment goes against the open invoice lines with the oldest due date first. A payment can be meant for one **policy**; then only that policy's lines are paid. Each rupee is recorded as an **allocation** (never changed). A line is paid when its allocations reach its amount; an invoice is paid when every line is.
- **Unapplied cash.** What cannot be allocated (an overpayment, or paying ahead) waits, and is put against the next invoices when they are made.
- **Suspense.** A payment that cannot be matched to an account is stored with no billing account. Someone **matches** it later and it is allocated then. It is announced as `PaymentReceived` once it belongs to an account.
- **Credits** (return premium) are **applied** to what the customer owes, or **paid out**. Cash goes out only up to what the customer **paid for the policy beyond what the insurer keeps**; for a customer who paid one quarterly instalment and cancels, nothing goes out in cash and the credit is applied instead. A cancelled policy's future unbilled instalments are **voided**.
- **Missed payments.** After the invoice due date plus the plan's grace days, timed steps run: a **reminder** (announced as `DelinquencyStarted`), a **final notice** after 10 more days, and a **cancellation request** after 20. Each step happens **once** per invoice, in order, even if the batch runs late.
- **Policy listens.** On `CancellationRequested`, Policy starts a **non-payment cancellation** with the notice the product requires (15 days). On `ReinstatementRequested` (sent once when an invoice that led to a cancellation request is finally paid), Policy starts a **reinstatement** if the policy was cancelled for non-payment and the 30-day limit has not passed. A person still quotes and binds these jobs. Requests that cannot be done are skipped with a reason in the audit log.
- Everything between the two modules goes through the **outbox**, and each side keeps its own offset, so each can restart or see an event twice safely.

## G1. First notice of loss and the policy as of the loss date (section 15)
- **FNOL** is the first report of a loss: when and where it happened, the cause, a description, who reported it and by which channel (staff, portal, phone, WhatsApp, partner), incidents (damage or injury) and references to photos. A claim gets a number (`CL-0000001`).
- **The policy as of the loss date.** Claims asks Policy a question: what was this policy on that day? Policy answers from effective dating: the newest *bound* version of the *term that contains the date*, read *as of that date*. The answer is **in force** (with the vehicle, the covers and their terms, such as the insured value) or **not in force** with a reason: outside any term, cancelled from a date, or a gap in cover. An open job never counts. A change takes effect from its own date, so the day before it shows the old value.
- **Verification.** The cause needs a cover (a collision needs own damage, an injury to a third party needs third-party liability). If the policy was in force and had that cover, the claim is **verified**; otherwise it is **not verified**, with the reasons. The report is **still recorded**: a handler decides. Only a report that cannot be understood (unknown policy, impossible dates) is refused, and then nothing is saved.
- **The claim keeps its own copy** of the policy as it was on the loss date. If the policy is cancelled later, the claim is not changed.
- **Flags, not refusals.** A report more than 7 days after the loss is a **late report**; the same policy, date and cause as an earlier claim is a **possible duplicate**. Both are accepted and shown.
- **Finding the policy.** A caller who knows only the car's number can be matched through the vehicle's registration number (spaces and capitals do not matter), among the policies in force that day.
- **Personal data.** The reporter's phone number is stored on the claim but never goes into the audit log or the `ClaimOpened` event.
- Claims never reads Policy's tables; it uses only Policy's public door, and the architecture test checks it.

## G2. Exposures, reserves, payments, recoveries (section 15)
- An **exposure** is one claimant against one cover of the policy within a claim. A collision can have two: the insured's own-damage exposure and a third-party exposure against the third-party cover. It is numbered within the claim, has a handler, and carries the **limit** and **deductible** from the policy as it was on the loss date (own damage: the insured value). A cover that was not on the policy needs a handler's reason; so does any exposure on a claim that could not be verified. The reason goes into the audit log.
- **Statuses** are the stages of the simulator: submitted, under review, documents pending, approved, settled, rejected, closed. Only the moves in the diagram are allowed (rejecting needs a reason; a rejected or closed exposure can be reopened), and every move is tested. The **claim's status follows its exposures**: open work shows first, then approved, then the final states.
- **Reserves** are the amount still expected to be paid, by line: a **cost type** (claim cost or expense) and a **category** (repair, medical ...). Every change is kept in a history that cannot be changed: who, why, from what to what. A reserve is limited by the person's **financial authority** (a handler up to Rs 50,000 on an exposure, a manager up to Rs 10 lakh); more is refused. Each change is announced as `ReserveChanged`.
- **Payments** need an approved exposure and a reserve to pay from: you cannot pay more than the line has outstanding ("raise the reserve first"), nor more than the **limit of the cover**. A payment **partial** reduces the line; a **final** payment also releases what is left of the exposure's reserves, settles the exposure and, when all exposures are settled, the claim.
- **Authority and approval.** A payment inside the requester's limit is issued at once. A bigger one waits as *pending approval*, and a **different person** with a limit that covers it approves with a reason; only then does money move and `ClaimPaymentIssued` go out.
- **Payee checks.** A payment to a claimant must name the claimant; to a garage or hospital it needs an invoice reference. A bank transfer needs a valid IFSC code and account number, a UPI payment a valid UPI address. Only a **masked** instrument is kept (`XXXXXXXXXX6789`), so account numbers never reach the database, the event or the audit log. The same reference is the same payment.
- **Recoveries** (subrogation, salvage, deductible) bring money back and can never be more than was paid.
- **The financial view:** incurred = paid + outstanding reserves - recoveries, for each exposure, the whole claim and each cost type. Example: reserve 3,000,000 repair and 100,000 survey, pay 1,000,000, recover 200,000 salvage: incurred = 1,000,000 + 2,100,000 - 200,000 = 2,900,000.

## H1. The REST API with an OpenAPI description (section 17)
- The API is the **edge of the system**, not a module. It uses each module only through its public door and never touches a table (a test checks it). **Fastify** is the web framework: it receives the HTTP request and calls our functions.
- **One list of routes, used twice.** Each route is described once (method, path, permission, request body, answer code). The API is built from that list *and* the **OpenAPI description** (`GET /openapi.json`) is written from it, so the description can never drift from what the API does. A test checks that every route has a summary, its path parameters, an Idempotency-Key on every POST, and the error answers.
- **Who is asking.** An identity provider in front of the API signs the person in and sets `X-User`. The API checks the user is known and active (401), then that their roles give the **permission** the route needs (403). Reads are limited by **producer code security**: an account, job, claim or policy the user may not see is answered **404**, so its existence is not revealed.
- **Idempotency keys.** Every POST needs an `Idempotency-Key`. The first successful answer is stored under the key; repeating the request returns the same answer (marked `Idempotency-Replayed`) and does the work once. The same key with a different request is refused (422). A failed request is not stored, so the client can correct it and try again with the same key.
- **Lost updates: ETag and If-Match.** Reading a working copy returns an **ETag**, a fingerprint of all its rows. Changing it requires `If-Match` with that ETag: missing gives 428, a stale one 412. Two people editing the same quote cannot overwrite each other without noticing.
- **One shape for mistakes.** 400 for a request that is not shaped right (with each problem), 401, 403, 404, 412, 428, and **422 with every business problem** the module found. A server fault is a plain 500 with no details.
- **Lists are paged** (`limit`, `offset`) and filtered; the answer says the total.
- **Sensitive data stays out.** The claim payment answer shows only the masked account (`XXXXXXXXXX6789`).
- The whole customer journey was run through the API in a test: contact, account, submission, vehicle and covers, quote (an agent), bind and issue (an underwriter; an agent is refused), policy as of a date, a claim with exposure, reserve and payment, then billing events, invoice and a payment.

## H2. The screens: quote wizard and policy file (section 20)
- **React** builds the screen from small functions called components; when data changes, React redraws only what changed. **Vite** serves the screens while developing and builds them for release. The screens are plain: forms, tables and messages.
- **The screen holds no business rule.** It offers choices from the product (covers, the limits of the insured value, the deductible options), and the API checks every rule. When the API refuses, the screen shows the **server's reasons** exactly: a refusal (422) lists every problem, a missing permission (403) says "You are not allowed to do this", and nothing technical is shown.
- **The quote wizard** has five steps: customer, vehicle, covers, quote, bind and issue. Each step calls the API when it is complete, so what is saved on the server stays saved. An agent can quote but not bind; the screen says so and leaves the quote on screen, so an underwriter can bind it.
- **Pressing a button twice does no harm.** Each call has an **idempotency key**, kept until the call succeeds. If the second step fails after the first worked, the retry repeats the same calls with the same keys, so the customer is not created twice. A button is disabled while its work runs.
- **The policy file** shows what a service person needs when a customer calls: the policy and whether it is in force or cancelled, the **timeline of versions**, the **premium transactions** (the whole premium of version 1, only the difference of a change), the documents and the claims. A date picker shows **the policy as it was on any date**, using the same effective-dating answer that claims use.
- **Documents need the sign-in.** A plain link cannot send the `X-User` header, so the screen downloads the file with the header and opens it in a new tab.
- **Testing the screens.** A test draws the screen in a simulated browser, with a stand-in for the API, fills in the fields, presses the buttons and checks what is on screen and what was sent. A separate test checks the API client: headers, idempotency keys and how errors are read. I also ran the real wizard and policy file in a browser against the real API.

## I1. The end-to-end test (document section 21)
- A **scenario test** runs one customer's whole life through Policy, Billing and Claims, step after step: two quote options compared and one bound, four instalments billed, a mid-term change billed as a difference, a claim paid within a handler's authority, a missed payment that ends in a cancellation for non-payment, a late payment that brings a reinstatement, and a renewal into the next term. Each step checks what the step proves.
- **Invariants are the real value.** After the story, the test checks things that must be true whatever happened: every premium Policy recorded is a charge in Billing to the paisa; Billing asks the customer for exactly what Policy charged; claim figures add up; the vehicle keeps one fixed id in every version and term; bound versions and every record of money refuse changes even from a direct database command; every stored document matches its checksum; the events and the audit log exist and name who did what; and no phone number or bank account reached the audit log or the events.
- **It found a bug.** After a reinstatement the cancelled last instalment stayed cancelled, so Billing was short by one instalment. Unit tests of each module had all passed: the fault was in how two modules work together. The fix is in Billing (payment items come back on `PolicyReinstated`), with its own small test.
- **It also shows a gap honestly.** The renewal ignores the claim in the no-claim bonus, so the test sets the claim-free years by hand and says why.

## I2. The review (REVIEW.md)
- A review compares **what was asked** (the document) with **what was built**, section by section, and says plainly what is missing. A scorecard with a short reason for each score is more useful than one big percentage.
- **Check the rules, not only the features.** The design rules (money in paise, bound versions never edited, modules never read each other's tables, everything audited) were each checked against evidence: a test or a database rule that enforces them.
- **List the weaknesses yourself.** Trusted sign-in, simplified refund netting, thin concurrency handling, illustrative numbers and unreviewed translations are written down, so nobody mistakes the learning version for a product.
- **Plan the next work by value.** First make it safe to run (real database, real sign-in, event publisher), then make it usable (screens, languages, queues), then broaden the business, then prove it at scale.

## Tier 1, item 1. Two databases behind one interface
- **Why an interface.** The code never names a driver. It uses a small `Database` (query, exec, transaction, close). PGlite and a real PostgreSQL server both fit it, so switching is a setting (`DATABASE_URL`), not a rewrite. This is the old rule "keep all connection code in one file" paying off.
- **Run the tests on the real thing.** PGlite is real PostgreSQL compiled for Node, but a real server has several connections, an encoding chosen when the database is created, and a limit on connections. Running all 480 tests on a real server found three such differences, none of which PGlite showed.
- **Code that depends on the connection must say so.** Setting a value for "this connection" (here, skipping triggers while resetting test data) only works if the next command uses the same connection. Put them in one transaction.
- **UTF8.** Hindi and Telugu names need a UTF8 database. The server's default on Windows was not UTF8.
- **Do not create and drop dozens of databases at once.** Each create and drop makes the server write a checkpoint, and doing it in parallel stalled the run. Drop them together at the end.
- **Say what was not run.** The Dockerfile, compose file and CI workflow were written carefully but never executed here. A file that has not been run is a draft.

## Tier 1, item 2. Sign-in and the permissions matrix
- **Authentication and authorisation are different.** Authentication: who are you? (a signed token from the identity provider). Authorisation: what may you do? (our roles and permissions). The API keeps the second in its own database.
- **A signed token.** The provider signs it with a private key; we hold only the public key, so we can check it but never make one. We also check who issued it, who it is for (audience) and when it expires.
- **Refuse weak tokens.** A token can claim any algorithm in its header, including "none" (no signature). We list the algorithms we accept and never trust the header's choice.
- **One plain answer.** Every bad token gets the same 401, so an attacker learns nothing about why.
- **A matrix test.** A table of every role against every route is too long to write and check by hand, so the test builds it from the route list and the role definitions, and a new route is covered the day it is added. It found a permission that nothing uses.

## Tier 2, item 5. Read-only screens first
- **Start with what only reads.** A list and a detail page need no new business rules and cannot damage data, so they are the safest screens to build first and still useful to a person on the phone.
- **The screen adds nothing of its own.** It shows the server's figures (outstanding, incurred). It sums only to display a total of numbers the server already gave.
- **Partial failure.** One page makes two calls (the account and its billing). If the second fails (no permission, nothing billed yet), the first still shows, with the reason. Show an unknown number as "-", never as 0: zero looks like a fact.
- **Links are the navigation.** Every policy, claim and account number is a link to its page, so a person follows the story instead of retyping numbers.
- **Missing API means missing screen.** Several wanted screens (policy change, renewal, approval of referrals) cannot be built until the API has the route. The screens list shows what the API lacks.

## Self-check list (A3, no quiz this time)
I can explain in my own words: policy period, job, branch, slice, out-of-sequence change.
