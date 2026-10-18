# Insurance Suite

A learning project: a policy, billing and claims system for private car insurance in India, built step by step from `docs/Insurance-Suite-Implementation-Document.pdf`. See `PROGRESS.md` for what is built, `REVIEW.md` for how it compares with the document and what to do next, and `LEARNING_NOTES.md` for the concepts.

## Commands

| Command | What it does |
|---|---|
| `npm run check` | Type check (server and screens), lint and every test. Run it before every commit. |
| `npm test` | Only the tests, on PGlite (PostgreSQL inside Node; nothing to install). |
| `TEST_DATABASE=postgres npm test` | The same tests on a real PostgreSQL server that is started just for the run (no Docker needed). |
| `TEST_DATABASE_URL=postgres://... npm test` | The same tests on a PostgreSQL server you already have. Each test file makes its own `test_...` database, and they are dropped at the end. |
| `npm run api` | Builds and starts the API on port 3000, keeping its data in `.data/`. Demo users are added. |
| `npm run web` | Starts the screens on port 5173 and passes `/v1` to the API (set `API_URL` if the API is elsewhere). |

On Windows the shell syntax for the variables is `$env:TEST_DATABASE='postgres'; npm test` in PowerShell.

## Running with PostgreSQL in Docker

```bash
cp .env.example .env        # then set POSTGRES_PASSWORD
docker compose up --build
```

The API is at http://localhost:3000 and its description at http://localhost:3000/openapi.json. The server reads `DATABASE_URL` (see `.env.example`); without it, it uses PGlite and keeps files in `.data/`. Add `SEED_DEMO=true` in `.env` to create the demo users (`asha.agent`, `uma.underwriter`, `carl.claims`, `bina.billing`, `root.admin`); never in a real environment.

The database must be created with **UTF8** encoding (the Hindi and Telugu names need it). The official `postgres` image does this by default.

## How the project is laid out

- `src/<module>/`: `contacts`, `policy`, `billing`, `claims`, `platform`. A module is used by others only through its `index.ts`. `src/api/` is the REST API, the edge of the system. `src/testing/` is support for tests.
- `db/migrations/`: numbered plain SQL files, applied once each.
- `config/`: everything that changes with the business, as versioned files: products, rate books, underwriting rules, cancellation, renewal, billing plans, claims limits, typelists.
- `web/`: the React screens (quote wizard, policy file).
- `CLAUDE.md`: the rules every change must follow.
