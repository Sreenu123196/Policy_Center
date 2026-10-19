# The database

The JSON file wrote the whole book on every change. That is fine to a few hundred policies and then it is the thing the
server spends its time doing (`docs/PERFORMANCE.md` measured it). The database back end replaces it with one row per
record, so a change costs what the change is, not what the book is.

Measured on this machine, the demo book of 153 policies (3.5 MB):

| A single change costs | JSON file | PostgreSQL |
|---|---|---|
| Time to make the change safe | 25 ms (writes all 3.5 MB) | 0.25 ms (writes one 6 KB log frame), then 3.4 ms to write the row |
| Grows with the size of the book | yes, linearly | no |

(The 3.4 ms is PGlite, PostgreSQL compiled to WebAssembly running in this process. A real server on the same machine is
faster; the point is that neither the log nor the row grows with the book.)

## Running on a database

```bash
# a real server
DATABASE_URL=postgres://user:password@localhost:5432/policycenter npm start

# the same engine inside the process: nothing to install, nothing kept after the process stops
DATABASE_URL=memory:// npm start

# a directory-backed PGlite database that survives restarts (a demo you can keep)
DATABASE_URL=pglite://./data/pg npm start

# copy an existing JSON file in, once
DATABASE_URL=postgres://... npm run migrate-to-pg
```

With no `DATABASE_URL` the JSON file is used, exactly as before. The tables are created (or repaired) at start; there is
no separate migration step. `WAL_FILE` moves the write-ahead log (default `<DATA_FILE>.wal`).

`memory://` needs `@electric-sql/pglite`, which is installed as a development dependency. A real server needs `pg`, which
is a normal dependency. Both speak the same SQL; `src/pg/runners.js` is the only place that knows which one is in use.

## How a change is saved

```
service code  ->  store.transaction(fn)
                    1. the proxies in src/pg/changeTracker.js note which records fn changed
                    2. COMMIT: one line is appended to the write-ahead log   <- the change is now safe
                    3. FLUSH (right after the response): the changed rows are written in one database transaction
```

Why a log at all: `store.transaction()` is **synchronous** — every service calls it and uses the result immediately, and
the 348 tests are written that way. A database write is not synchronous. Rather than make every service, route and test
async (a rewrite of the whole app), a commit appends a small frame to `src/pg/wal.js` and returns; the rows follow in one
database transaction immediately afterwards. If the process dies in between, `load()` replays the frames the database has
not seen (the watermark is `pc_meta.wal_seq`) and only then serves requests. The log is emptied after each successful
write, so it stays small.

What the log does not cover: a machine that loses power can lose the last frames, exactly as the JSON file could (it used
write + rename, no fsync). A database that disappears does not lose changes either — the frames stay in the log, the store
marks itself `degraded` and retries, and the next start replays them.

## The tables

| Shape | Collections | Table | Row |
|---|---|---|---|
| rows | accounts, policies, jobs, activities, invoices, payments, refunds, ledger, eventFailures, documents, events, claims, followUps, messages, tickets, staff, agentSuggestions | `pc_<name>` | `(id text primary key, doc jsonb, updated_at)` |
| rows, keyed by sequence | auditLog | `pc_audit_log` | the audit entry has a `seq` and no id (`src/audit.js`) |
| key/value | seq, producerRates, eventConsumers, idempotency, agentConfig, finance | `pc_kv_<name>` | `(key text primary key, doc jsonb, updated_at)` |
| documents | closings, dataRequests, and anything a newer version adds that has no table | `pc_docs` | `(key text primary key, doc jsonb, updated_at)` |

A record stays the JSON document the app already uses, so no mapping layer was needed; the searches the screens make are
indexed with expression indexes (`(doc->>'policyNumber')` and so on, listed in `src/pg/schema.js`).

## What changed in the code

- `src/pg/schema.js`: collection → table map, the DDL, the indexes.
- `src/pg/changeTracker.js`: wraps the data in proxies. Reads cost a map lookup; writes record the record that changed and
  how to undo it. It is invisible: the same object identity comes back, `Array.isArray` and `JSON.stringify` behave.
- `src/pg/wal.js`: append one frame per unit of work; replay after a crash; a half-written last line is dropped.
- `src/pg/postgresStore.js`: the same API as `src/store.js` (`next`, `id`, `number`, `isEmpty`, `reset`, `transaction`,
  `data`, `stats`), so nothing above it knows which store it has.
- `src/pg/open.js`: `DATABASE_URL` → the right driver.
- `server.js`: starts the chosen store, drains the log on Ctrl-C.
- `scripts/migrate-to-pg.js`: copies an existing JSON file into the database (refuses to overwrite a book unless `--force`).

Two behaviour changes worth knowing:

- The built-in staff is now written inside a unit of work (`PolicyCenter.seedStaff`), because a database store only learns
  about writes that are recorded.
- **Reset demo data** (`POST /api/admin/reset`) used to leave the app with no staff, so the seed failed with "Unknown user
  'agent'" and the book stayed empty. It now puts the team back first, and on a database the truncate is part of the same
  unit of work as the seed, so a failure puts the old book back.

## What is not done yet

- **Reads still come from memory.** The whole book is loaded at start, and searches run in JavaScript as before. That is
  the case only because it needed no change to the services. Before the book is larger than a few hundred MB, or before
  several servers run at once, reads should go to the database (one `select` per lookup, indexes already in place). This
  is the natural next step, and it is a larger change: every service method becomes async.
- **One writer.** The write-ahead log assumes a single process. More than one server needs the database as the only
  truth (no log, or a leader that owns it) — do that with the read-through work above.
- **Backups are still JSON snapshots** (`src/backup.js` copies `store.data`). With a database, `pg_dump` is the better
  backup; the existing backup and restore still work and are still useful.
- **Testing.** `npm test` runs the real PostgreSQL engine in the tests (`@electric-sql/pglite`), so the SQL is executed,
  not mocked. There is no PostgreSQL *server* on the development machine; the tests are the check, and a real server
  should be tried before go-live.
