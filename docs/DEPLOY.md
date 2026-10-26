# Deploying

## Live now (26 October 2026)

| Piece | Address |
|---|---|
| API | https://policycenter-api.onrender.com |
| App | https://tangerine-daffodil-1ca625.netlify.app |
| Database | Render PostgreSQL `policycenter-db` (oregon, free plan) |

Verified by request, not by assumption: `/health` 200 on Render; `/api/health` 200 through the Netlify proxy; `/api/auth/status` reports
`setupNeeded: false`, so the database carries the staff; and a wrong password through the proxy returns 401 "Wrong username or password", which proves the
POST reached the API, passed the origin check, and queried the database.

Not verified: signing in with real credentials (that is for the owner), and the knowledge index answering - `VOYAGE_API_KEY` was added to the service after
the last check, and the assistant reports its state in the service log at start-up.

Two pieces: the API (Render, or any Node host) and the browser app (Netlify). Both are separate settings; the app cannot guess the API's address.

## API

| Setting | Value |
|---|---|
| Build | `npm ci` |
| Start | `npm start` (runs `node server.js`) |
| Health check | `/health` - answers `{"ok":true}`; the root path is also accepted for a probe that asks `/` |
| Node | 22 (`engines` and `.nvmrc` both pin it) |

Environment:

- `DATABASE_URL` - `pglite://data/pgdata` for the in-process database, or a `postgres://` URL for a real server.
  **Import the existing book first**: `node scripts/pg-import.js data/policycenter.json`. The importer exits by itself when it is done.
- `ANTHROPIC_API_KEY`, `VOYAGE_API_KEY` - the assistant and the knowledge index.
- `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` - billing and the verified webhook.
- `BOLNA_API_KEY`, `BOLNA_AGENT_ID` - outbound voice calls for claims. Without them the voice routes answer 503 and name the missing variable.
- `KNOWLEDGE_DB` - where the knowledge index lives; defaults to `data/knowledge.db` beside the JSON store.
- Optional flags: `SSO_ENFORCE_MFA=1`, `ESIGN_REQUIRED=1`, `SOVEREIGN_MODE=1`.

Never commit `.env`; the app reads it locally and the platform supplies the same names.

## App

Netlify needs **`API_ORIGIN`** as an environment variable (for example `https://policycenter-api.onrender.com`): the build script writes
`public/_redirects` from it, proxying `/api/*` to that host. Without it the build stops with that instruction rather than deploying a site whose
every request 404s. The file is generated and gitignored; do not commit it.

Netlify serves `public/` and proxies `/api/*` to the API host. Set the API origin in `netlify.toml` (or the dashboard) before the first deploy.

## After deploying, check these, in this order

1. `GET /health` returns 200 - a deploy that is running but unhealthy is the failure this file exists to prevent.
2. Sign in works, which proves the session cookie crosses the proxy with `SameSite=Strict`.
3. A policy list loads, which proves the database is reached rather than an empty file being created.
4. `npm run gate:policy` passes locally at the current baseline before the deploy is announced.

## The live database holds the demo seed, not the imported book (26 October)

The service log says `Data: PostgreSQL, 6 policies loaded`. The database is real and reachable by the app, but it contains the seeded demo rather than the
153-policy book in `data/policycenter.json`, because the import has not run on the host.

It could not run from here: Render's API for this database returns no external connection string, so a laptop cannot reach it, and the free plan gives no
shell to run `node scripts/pg-import.js` inside the service.

Two ways to finish it, both honest:

1. **Enable external connections** on the Render database (dashboard), copy the external URL, then run from a checkout:
   `DATABASE_URL=<external-url> node scripts/pg-import.js data/policycenter.json`, and restart the service afterwards so it reloads the data into memory.
2. **Seed on boot** with `src/pg/seed.js`, which is written and tested: `SEED_FROM_JSON=1` seeds only when the database is empty. It is not wired into
   `server.js` yet, because the server builds its API synchronously and seeding has to happen before that - a small refactor, not a one-line change.

Until one of them is done, the deployed app is a working demo with six policies rather than the real book.
