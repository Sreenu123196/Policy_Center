# Handoff: PolicyCenter Simulator

For whoever (or whichever AI assistant) continues this project. Written 19 October 2026. Read this first, then `docs/GO-LIVE.md` and `docs/AGENTS.md`.

## What this is

A runnable, PolicyCenter-style policy administration app: plain JavaScript, Node 20 or newer, **no framework**, JSON-file storage, tests with `node --test`. Repository: `https://github.com/Sreenu123196/Policy_Center`, branch `main`. Local clone: `C:\Users\MucharlaSreenivasulu\OneDrive\Desktop\AI-FDE\PolicyCenter-Sim` (Windows 11, OneDrive).

It began as a separate "Insurance Suite" learning project (TypeScript). Everything useful was ported into this Sim; the old code is gone from the repo. The git tag `insurance-suite-final` and the two PDFs in `reference-docs/` are kept on purpose: do not delete them.

```
npm install        # once
npm start          # http://localhost:3000   (first start: create the first UW manager on the sign-in page)
npm test           # 320 tests, all passing at the last run
node scripts/load-test.js --check
```

## Layout

| Path | What |
|---|---|
| `server.js` | Builds store, services, event bus, API; schedules backups and the agent sweep; reads `.env` first (`src/loadEnv.js`) |
| `src/webServer.js`, `src/security.js` | The web edge: security headers, CSP, JSON-only writes, same-origin check, sign-in rate limit, static files |
| `src/api.js` | All REST routes (`route(method, pattern, handler, {readOnly, stream, raw, isPublic})`); `/api/...` |
| `src/policyCenter.js` | The main service class (accounts, jobs, policies, claims, tickets, staff) |
| `src/store.js` | JSON file store; `transaction(fn)` rolls back on error; atomic save |
| `src/eventBus.js`, `src/consumers.js` | Events with per-consumer offsets, retry, dead letter; consumers: collections, claims-queue, accounting, agents |
| `src/permissions.js` | Roles: agent, underwriter, executive, manager, and `AI Agent` |
| `src/agents.js`, `src/audit.js` | The AI agents (suggest-only) and the hash-chained audit log |
| `src/backup.js`, `scripts/backup.js`, `scripts/restore.js` | Backups with SHA-256 and restore |
| `src/dataProtection.js` | Personal data export and guarded erasure |
| `src/messaging.js`, `src/documents.js` | Email (Gmail SMTP) and WhatsApp sending; documents |
| `src/speech.js`, `scripts/whisper_server.py` | Voice input engines: `browser` (current), `whisper`, `google` |
| `src/chatbot.js` | The assistant (Claude when `ANTHROPIC_API_KEY` is set, otherwise offline mode) |
| `public/app.js`, `index.html`, `i18n.js`, `styles.css` | The browser UI (no build step) |
| `test/` | One file per area; `permissions-matrix.test.js` lists every route against every role |
| `docs/` | PERFORMANCE, ACCESSIBILITY, DATA-PROTECTION, GO-LIVE, AGENTS, INSURANCE-SUITE-PORT |

## What is done

- **Tiers 1 to 3** of the old plan: real sign-in and the permissions matrix, accounting and ledger, billing and delinquency, documents (English, Hindi, Telugu), work queues, claims money, premium audit, multi-year terms, rewrite, two-wheeler and question sets, reports, Hindi and Telugu screens, accessibility work.
- **Tier 4, in code**: load test and the fixes it found; security hardening; backups and restore; personal-data export and erasure; Dockerfile (never built: no Docker on this machine).
- **AI agents (suggest-only)** from `PolicyCenter-Production-and-Agents-Plan.pdf` (a copy sits at `D:\RAG-IMP\data\document\`): audit log, agent accounts, modes and limits as data, five agents (renewal, keep-customers, billing, underwriting, compliance check), a backtest, and the screens (menu: AI agents). Seven more are planned and listed with what each waits for.
- **Email**: the Email button on renewal and lapse sends directly through Gmail from the server, after a confirm dialog inside the app; with no Gmail settings it opens Gmail's compose window. A mail-server refusal is saved as a Failed message and shown, and never crashes the server.
- **Voice**: input uses the browser's own recognition in the language picked in the chat; the assistant reads every answer aloud (speaker button in the chat header).

## Configuration (never commit secrets)

Put settings in `PolicyCenter-Sim\.env` (git-ignored; template: `env.example`). Values already in the environment win over the file.

| Setting | Purpose |
|---|---|
| `GMAIL_USER`, `GMAIL_APP_PASSWORD`, `EMAIL_FROM_NAME` | Direct email (a 16-character Google app password; spaces are ignored). `node scripts/test-email.js [address]` checks the login |
| `ANTHROPIC_API_KEY` | Assistant in Claude mode (otherwise offline mode) |
| `PORT`, `DATA_FILE`, `BACKUP_DIR`, `BACKUP_HOURS`, `BACKUP_KEEP` | Server, data file (default `data/policycenter.json`), backups |
| `AGENT_SWEEP_HOURS` | Daily agent sweep (default 24, 0 = off) |
| `TRUST_PROXY=1` | Behind a proxy, so the sign-in limit counts the caller |
| `chat.config.json` (git-ignored) | `speechEngine` (`browser` now), `workspaceId`, Google speech options |

The local data is in `data/` (git-ignored). Passwords are salted scrypt hashes; the first manager is created through the app. `npm run reset-manager` gives a new temporary password if one is lost.

## How we work (keep doing this)

- **Tests first**, then the code; run the full suite before every commit. Every new route is added to the `MATRIX` in `test/permissions-matrix.test.js`.
- **Match the surrounding code**: plain JS, small modules, comments that say why. Money is in dollars with 2 decimals, dates are `yyyy-mm-dd`, events carry `businessDate`.
- **Commit and push each finished item to `main`**, with the trailer `Co-Authored-By: ...` if an AI helped. **Stage specific paths only**: `docs/PolicyCenter-Project-Explanation.pdf` has an uncommitted local change that must NOT be committed.
- **Do not change the Insurance Executive role** (read-only by design; the matrix pins it). The user said no to closing that gap.
- Ask before: global installs, deleting data, branches or code, and anything with unclear scope. Otherwise carry on; the user prefers English and short confirmations.
- Test credentials only on throwaway local servers (a copy of the data on another port); never use real passwords or send real email while testing. A server started from this folder loads the real Gmail settings from `.env`, so do not click send in a test.

## Gotchas learned the hard way

- **Windows and OneDrive**: the store retries a locked rename; the data folder sits in OneDrive.
- **Text with Hindi or Telugu**: the machine's Python 3.9 cannot read such files or heredocs. Use Node scripts for edits that include Indic text.
- **Backslashes in shell heredocs can be lost** (regexes written through a heredoc came out broken). Write files with a file tool, or check the regex after writing.
- A **stale running process** is the usual reason a fix "does not work": the speech service and the web server keep old code until restarted. Check the process start time against the last change.
- `i18n.js`: a translation whose English text no longer appears in the source fails the "stale entry" test; text built from templates goes in `GENERATED` in `test/i18n.test.js`.
- Mail and other outside services are asynchronous: wait for them **outside** `store.transaction` (see `Messaging.dispatch`).

## Open items (suggested order)

1. **Database move** (PostgreSQL). The JSON file saves everything on every write; fine to a few hundred policies. Largest remaining job (`docs/PERFORMANCE.md`).
2. Agents: show suggestions on the Desktop and in the Work queues; a payment-reminder message template; then a trial period in `suggest` mode before any acting agent (`docs/AGENTS.md`). The planned agents wait on: incoming channels, data providers, online payments and e-signature, photo upload and OCR.
3. Screens for backup, personal-data export and erasure (API only now).
4. `docs/GO-LIVE.md` people tasks: penetration test, hosting in India, secrets handling, a restore drill, retention and consent decisions, native-speaker review of Hindi and Telugu (including the agent screens), screen-reader checks, monitoring.
5. Build and test the Dockerfile.
6. `npm audit`: two moderate `uuid` findings via `exceljs`, not reachable; recheck at go-live.

## Last state

`main` at commit `bb2c840` ("Chat: voice replies ..."), 320 tests passing, nothing uncommitted except the PDF noted above. The main server was running on port 3000 at the time of writing; restart it after pulling to load new code.
