# Deploying

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
- Optional flags: `SSO_ENFORCE_MFA=1`, `ESIGN_REQUIRED=1`, `SOVEREIGN_MODE=1`.

Never commit `.env`; the app reads it locally and the platform supplies the same names.

## App

Netlify serves `public/` and proxies `/api/*` to the API host. Set the API origin in `netlify.toml` (or the dashboard) before the first deploy.

## After deploying, check these, in this order

1. `GET /health` returns 200 - a deploy that is running but unhealthy is the failure this file exists to prevent.
2. Sign in works, which proves the session cookie crosses the proxy with `SameSite=Strict`.
3. A policy list loads, which proves the database is reached rather than an empty file being created.
4. `npm run gate:policy` passes locally at the current baseline before the deploy is announced.
