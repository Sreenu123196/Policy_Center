# Personal data (DPDP-style)

What is built, and what is a decision for the company and its lawyers. This is not legal advice.

## What personal data is held

| Where | What |
|---|---|
| Account | name, date of birth, email, phone, address |
| Policies and jobs (every version) | insured name and address, drivers (name, date of birth, licence number and state), vehicles (VIN, garaging zip), dwelling address, the rated driver's name in rating worksheets |
| Claims | description of the loss, notes, reasons, a copy of the policy as at the loss date |
| Tickets, follow-ups, messages | free text, the address a message was sent to |
| Documents | data used to print them |
| Staff | name, username, password hash |
| Backups (`data/backups`) | all of the above, including password hashes |

## What the software does

- **A copy for the person** (`GET /api/accounts/:id/personal-data`, UW managers): everything held against the account as stored.
- **Erasure** (`POST /api/accounts/:id/erase` with `{ "confirm": true, "reason": "..." }`, UW managers): names, contact details, date of birth, licence and vehicle numbers, address lines and free text are replaced, in the account, its policies and jobs, claims (including the policy copy), tickets, follow-ups, messages, documents, events and remembered answers (the Idempotency-Key store). The account, policy and claim numbers, premiums, the ledger and the invoices stay, so the books still add up. It is one unit of work: it all happens or none of it does. It is done once per account.
- **Refused while** a policy is in force or scheduled, a claim, quote/submission or ticket is open, or a refund is due to the person.
- **A log of requests** (`GET /api/admin/data-requests`): type, account number, who, when and why, never the personal data itself.
- Sessions and passwords: passwords are stored as salted scrypt hashes; sessions are in memory only and end after 8 hours; five bad sign-ins lock an account for a while; sign-in attempts per address are limited.

## What the software does NOT do (decide these before go-live)

1. **Retention period.** Insurance and tax law usually require records to be kept for years after a policy ends. The software keeps the financial and policy records and removes the identity; it does not know your required period, and it does not delete the records at the end of it. Decide the period, then add a scheduled purge.
2. **Backups.** An erasure does not reach backups already taken. Decide how long backups are kept (the default keeps the newest 14) and say so in the privacy notice. A restore of an old backup brings erased people back: after any restore, repeat the erasures in `data-requests` that came later.
3. **Consent and notices.** The screens have no consent capture, privacy notice or purpose statement. Marketing messages (email, WhatsApp) need consent and an opt-out.
4. **Data of other people.** Policies can hold other drivers and children. Their data is covered by erasure of the account that holds the policy, but they cannot make a request themselves.
5. **Breach handling.** A breach has to be reported to the regulator and the people affected within the time the law sets. Write the procedure (who decides, who tells whom). There is an audit trail of who changed a record, not of who read it.
6. **Where the data lives.** Hosting in India, who the processors are (the cloud host, Anthropic for the assistant, Google for speech, the email and WhatsApp providers), and the contracts with them. The assistant and speech features send text and audio outside the system when their keys are set.
7. **Encryption at rest.** The data file and backups are plain files: use an encrypted disk or volume, and keep the backup folder as protected as the data.
8. **Screens.** Export and erasure are API only for now.
