# Deploying it

Two halves, because they have different needs:

- **The browser UI** is static files (`public/`) and goes on **Netlify**, which serves them from its CDN.
- **The API** is `server.js`, a long-running Node process that keeps sessions in memory, schedules backups and the agent
  sweep, and writes a write-ahead log. Netlify does not run such a process (functions are per-request and their disk is
  ephemeral), so the API goes on a host that does: **Render** in the example here (`render.yaml`), with **PostgreSQL** for
  the data. Railway, Fly.io or an Azure App Service work the same way.

Netlify proxies `/api/*` to the API (see `netlify.toml` and `scripts/netlify-build.js`), so the browser sees **one site**:
the session cookie stays same-site, the app's same-origin check passes, and no CORS is needed.

```
browser ──> https://policycenter.netlify.app  (pages)
             └── /api/*  ──proxy──>  https://policycenter-api.onrender.com  ──> PostgreSQL
```

## 1. A PostgreSQL database

Any managed PostgreSQL works. **Neon** and **Supabase** have free tiers; Render has a paid one. You need the connection
string, which looks like:

```
postgres://user:password@host/dbname?sslmode=require
```

## 2. Put the book in it

The application creates its own tables on start, so there is no migration step for the schema. To copy the demo book (or
the JSON file from an existing installation):

```bash
cd PolicyCenter-Sim
DATABASE_URL="postgres://...?sslmode=require" npm run migrate-to-pg
```

Start from an empty database. If it already holds policies, the script refuses unless `--force`.

## 3. The API (Render)

1. Push this repository to GitHub (it already is).
2. Render → **New → Blueprint** → pick the repository. It reads `render.yaml` and asks for:
   - `DATABASE_URL` — the string from step 1.
   - `ALLOWED_ORIGINS` — leave it for a moment; it is filled in after the Netlify site exists (step 5).
3. Deploy. When it is up, check `https://<api-host>/api/health` returns `{"ok":true,...}` and the log says
   `Data: PostgreSQL, N policies loaded`.

The first start creates the tables and reads the book. On a free plan the service sleeps when idle: the first request
after that takes a while (it loads the book into memory), which is fine for a demo and not for production.

## 4. The UI (Netlify)

1. Netlify → **Add new site → Import an existing project** → pick the repository.
2. Netlify reads `netlify.toml`: build `node scripts/netlify-build.js`, publish `public/`. Nothing else to configure.
3. **Site configuration → Build & deploy → Environment variables**, add:

   ```
   API_ORIGIN = https://<api-host>          (no trailing slash, no /api)
   ```

4. Deploy (or "Clear cache and deploy site" if it built before the variable was set). The build writes
   `public/_redirects`, which is what makes `/api/*` reach the API. If `API_ORIGIN` is missing the build **fails** with a
   message saying so — that is deliberate, because a site without it looks fine and does nothing.

## 5. Let the API accept the site

Copy the Netlify address (for example `https://policycenter.netlify.app`) into the Render service's `ALLOWED_ORIGINS` and
redeploy. The proxy forwards the browser's `Origin` header, and without this the API refuses every write with
"403 This request did not come from this site" (reads still work).

More than one site (a staging site, a custom domain) can be listed: `ALLOWED_ORIGINS=https://a.example,https://b.example`.

## 6. First run

Open the Netlify address. The sign-in page asks for the first UW manager's username and password (that is the app's
normal first start). Then check, in this order:

1. Sign in, reload the page — you are still signed in (the cookie survived the proxy).
2. Open a policy and make a change, then reload — the change is there.
3. **Administration → Reset demo data** still works.
4. Stop the API on Render and start it again: signed out (sessions are in memory), but the data is intact.

## Notes from the first deployment (learned the hard way)

- **A 401 on every path is Netlify's *project visibility*, not a missing file.** The deploy succeeds and every URL still
  answers 401 with a redirect to `app.netlify.com/edge-access`. Netlify makes new projects **private by default** on
  credit-based teams (teams created on or after 28 July 2026). The fix is per project: **Project configuration → General
  → Visitor access → Project visibility → Public**, then Save. There is also a **Make public** button once the project has
  a production deploy. Changing the team default (**Team settings → General → Visitor access**) only affects *new*
  projects — existing ones keep their visibility, which is why flipping the team setting first did nothing. The API's
  older `sso_login` / `sso_login_context` fields are not it, and writes to them are silently ignored. Docs:
  <https://docs.netlify.com/manage/security/secure-access-to-sites/project-visibility/>
- **`netlify deploy` runs the build in `netlify.toml` first.** In a fresh shell without `API_ORIGIN` the build script stops
  on purpose and the deploy fails with "Error while running build". Export `API_ORIGIN` in the same shell, or deploy the
  already-built directory with `--no-build`.
- **This project is deployed manually** (`netlify deploy --prod --dir=public`), because linking a Git repository needs the
  Netlify GitHub App authorization in a browser. To switch to deploys on every push: Netlify → *Project configuration →
  Build & deploy → Link repository*, and set `API_ORIGIN` as a **project environment variable** so the build on Netlify
  has it.
- **A proxy to a host that does not exist yet returns 404, not a build error.** `/api/health` answering 404 while the
  pages answer 200 is the useful check that the proxy is wired and only the API is missing.
- **The site name** can only be changed in the UI (*Site configuration → Site details → Change site name*); the API
  refuses it. After renaming, update `ALLOWED_ORIGINS` on the API and `API_ORIGIN` on the site, then redeploy both sides.

## What this deployment does not do, and why

- **No Netlify Functions.** The app is stateful by design (sessions, an in-memory book, a write-ahead log, timers). A
  per-request function would lose sessions at random and its disk — including the log — with every invocation.
- **Sessions end when the API restarts or sleeps.** They are held in memory. Multiple API instances need the session
  store and the read-through work in `docs/HANDOFF.md` first.
- **The backup timer writes to the host's disk, which is ephemeral.** `render.yaml` therefore sets `BACKUP_HOURS=0`; on a
  managed database use `pg_dump` (or the provider's own backups) instead.
- **The chat answer stream** (`POST /api/chat/stream`, Claude mode only) may be buffered by the proxy. Offline mode, which
  is the default without `ANTHROPIC_API_KEY`, does not stream.
- **Voice** uses the browser's speech recognition, so it works over https as usual. The local Whisper service is not part
  of this deployment.
- **Email** works if `GMAIL_USER` and `GMAIL_APP_PASSWORD` are set on the API host; a test send should be the first thing
  you try after deploying.
