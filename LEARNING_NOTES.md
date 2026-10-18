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

## Self-check list (A3, no quiz this time)
I can explain in my own words: policy period, job, branch, slice, out-of-sequence change.
