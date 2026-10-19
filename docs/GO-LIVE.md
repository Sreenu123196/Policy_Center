# Go-live checklist

What the code now does, and what is left for people. Work through the second list before real customers use the system.

## Done in the code (Tier 4)

| Area | What | Where |
|---|---|---|
| Load | `node scripts/load-test.js --check` builds a book, runs 25 people for 20 s, and fails when reads p95 > 300 ms, writes p95 > 600 ms or errors > 0.1% | `docs/PERFORMANCE.md` |
| Health | `GET /api/health` (public, for the load balancer); `GET /api/admin/metrics` (managers) | `src/api.js` |
| Security headers | CSP (no inline script), `nosniff`, no framing, no referrer, Permissions-Policy; HSTS and a `Secure` cookie when the proxy says `X-Forwarded-Proto: https` | `src/security.js`, `src/webServer.js` |
| Requests | writes must be JSON from this site (415 / 403), 1 MB limit (413), bad JSON (400), prototype-pollution keys dropped, path traversal refused | `test/security.test.js` |
| Sign-in | per-address limit (30 per minute by default), lockout, scrypt hashes, 8 h sessions | `src/auth.js`, `src/webServer.js` |
| Errors | the browser sees "Something went wrong"; the detail goes to the server log | `src/api.js` |
| Access | every route is in the permissions matrix, one check per role | `test/permissions-matrix.test.js` |
| Backup | `POST /api/admin/backup`, a scheduled backup (`BACKUP_HOURS`, default 24; `BACKUP_KEEP`, default 14), `node scripts/backup.js`, SHA-256 per file | `src/backup.js` |
| Restore | `node scripts/restore.js [file]` with the server stopped: verifies, keeps what was there as `.before-restore-<time>` | `test/backup.test.js` |
| Personal data | export and guarded erasure, request log | `docs/DATA-PROTECTION.md` |
| Container | `Dockerfile` with a health check, a non-root user, data in `/data` | **not built or run: there is no Docker on the development machine** |
| Database | PostgreSQL back end: a row per record, one transaction per change, indexes, a write-ahead log so a synchronous commit stays safe, `npm run migrate-to-pg` | `src/pg/`, `docs/DATABASE.md` |

Behind a proxy: set `TRUST_PROXY=1` so the sign-in limit counts the caller, not the proxy. The proxy must end https and set `X-Forwarded-Proto`.

Dependency scan: `npm audit` is clean. It used to report two moderate `uuid` findings through `exceljs`; `package.json` now
overrides `uuid` to 11.1.1 (the API `exceljs` uses is unchanged, and the Excel export test still downloads a real file).
Re-run `npm audit` at go-live.

## Needs people (the code cannot do these)

1. **Run it on PostgreSQL.** The back end has been run against a real PostgreSQL 16.9 server on a development machine — the book was copied in, the app served it, a restart kept it, the reset button worked and the load test met its targets (`docs/DATABASE.md`). What is left is the hosted system at real volume: provision the server, set `DATABASE_URL`, copy the book with `npm run migrate-to-pg`, and run the load test there. Decide the backup too (`pg_dump` is better than the JSON snapshot). Reads still come from memory, so more than one server needs the read-through step first.
2. **Penetration test** by an outside party, on the deployed system. The checks here are the ones a developer can write; they are not a substitute.
3. **Hosting.** In India if your rules or the regulator require it; https with a real certificate; a proxy or load balancer. Run more than one server only after reads go to the database: sessions, and the write-ahead log, belong to one process (`docs/DATABASE.md`).
4. **Secrets.** `ANTHROPIC_API_KEY`, Google credentials, email and WhatsApp keys go in the host's secret store, never in the repository. Create the first manager yourself on the real server and keep the password in a password manager.
5. **Backups off the machine.** Copy `BACKUP_DIR` to separate, encrypted storage, and do a **restore drill**: restore into an empty folder, start the server, open a few policies. A backup that has never been restored is a hope.
6. **Data protection decisions** listed in `docs/DATA-PROTECTION.md` (retention period, consent, breach procedure, processors, encryption at rest).
7. **Hindi and Telugu** wording reviewed by native speakers, especially customer documents and notices.
8. **Accessibility** checked with a screen reader and with the keyboard only (`docs/ACCESSIBILITY.md` says what was and was not checked).
9. **Monitoring.** Something that calls `/api/health` and pages a person; log collection; an alert when `/api/admin/metrics` shows saves slowing.
10. **Regulatory fit.** Rate filings, product approvals, tax and document wording belong to the insurer's compliance team; the rate books and tax here are the simulator's own.
11. **Business continuity.** Who runs it, who is called at night, how long it may be down and how much data may be lost (with a daily backup, up to a day).
