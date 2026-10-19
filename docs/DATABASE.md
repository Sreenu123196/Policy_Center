# The database

The JSON file wrote the whole book on every change. That is fine to a few hundred policies and then it is the thing the
server spends its time doing (`docs/PERFORMANCE.md` measured it). The database back end replaces it with one row per
record, so a change costs what the change is, not what the book is.

Measured on this machine with the project's own load test (`node scripts/load-test.js --check`: 25 people at once for
20 s, a pause of a second between requests, reads and writes mixed 80/20), against PostgreSQL 16.9 running locally:

| Book | Store | Reads p95 | Writes p95 | Saving takes | Targets |
|---|---|---|---|---|---|
| 127 policies (3 MB) | JSON file | 45 ms | 85 ms | 21 ms | met |
| 127 policies | PostgreSQL | 43 ms | 108 ms | 7 ms | met |
| 409 policies (9.5 MB) | JSON file | 405 ms | 689 ms | 78 ms | **missed: both** |
| 409 policies | PostgreSQL | **69 ms** | **34 ms** | 13 ms | met |

So at a hundred-odd policies the file is fine and the database is a little slower on writes (an extra hop; the file save
is still cheap at that size). The difference is what happens as the book grows: the file's save cost grows with the book
and takes the whole server down with it, while the row write does not. At 409 policies the file misses both targets and
the database meets both with room to spare.

A change itself costs, on the demo book of 153 policies: **25 ms** to rewrite the whole 3.5 MB file, against **0.25 ms**
to append a 6 KB frame to the log plus one row written afterwards.

## Reads are not slowed down

The proxies that notice changes are only in place **while a unit of work runs**. Outside one, the store hands out the
plain data, so a page that only reads costs what it did before. A full scan of the 409-policy book measured 0.029 ms on
plain data and 0.525 ms through the proxies — an 18-fold difference on the most common thing the server does — which is
why the proxies are not kept on all the time.

The rule that follows: **a record fetched outside a unit of work and changed inside one would not be saved.** Every write
in the app already runs inside `store.transaction` (the routes, the event bus, messaging, documents, the agents), and a
record is looked up inside the same unit of work that changes it. Keep doing that. `src/resetManager.js` is written that
way, for example.

## Verified against a real server

`npm test` runs the real PostgreSQL engine in-process (PGlite), which executes the SQL but is not a server. The back end
was also run against **PostgreSQL 16.9** on this machine (the portable Windows build, unpacked under `C:\Users\Public`,
no installation and no administrator rights):

- `npm run migrate-to-pg` copied the whole book: 132 accounts, 153 policies, 590 invoices, and the rest.
- The app started on it, signed in, read the book, created an account; the row was checked directly with `psql`.
- The server was stopped and started again: the account and the login were still there.
- The reset button truncated and reseeded the book in one transaction (6 accounts, 5 policies, 7 staff).
- `npm run reset-manager` gave a new temporary password, and signing in with it worked.
- The load-test numbers above are from that server.

A real server needs `pg_dump` for backups rather than the JSON snapshot (see below).

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
the tests are written that way. A database write is not synchronous. Rather than make every service, route and test
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
- `src/pg/changeTracker.js`: wraps the data in proxies **while a unit of work runs**. Writes record the record that
  changed and how to undo it; reads outside a unit of work see the plain data. It is invisible: the same object identity
  comes back, `Array.isArray` and `JSON.stringify` behave.
- `src/pg/wal.js`: append one frame per unit of work; replay after a crash; a half-written last line is dropped.
- `src/pg/postgresStore.js`: the same API as `src/store.js` (`next`, `id`, `number`, `isEmpty`, `reset`, `transaction`,
  `data`, `stats`), so nothing above it knows which store it has.
- `src/pg/open.js`: `DATABASE_URL` → the right driver.
- `server.js`: starts the chosen store, drains the log on Ctrl-C.
- `scripts/migrate-to-pg.js`: copies an existing JSON file into the database (refuses to overwrite a book unless `--force`).
- `src/resetManager.js`, `npm run reset-manager`: a new temporary manager password, on either store (a database
  installation used to have no way back in).

Two behaviour changes worth knowing:

- The built-in staff is now written inside a unit of work (`PolicyCenter.seedStaff`), because a database store only learns
  about writes that are recorded.
- **Reset demo data** (`POST /api/admin/reset`) used to leave the app with no staff, so the seed failed with "Unknown user
  'agent'" and the book stayed empty. It now puts the team back first, and on a database the truncate is part of the same
  unit of work as the seed, so a failure puts the old book back.

## What is not done yet

- **Reads still come from memory.** The whole book is loaded at start, and searches run in JavaScript as before. That is
  the case only because it needed no change to the services. The load test now meets its read target at 409 policies, so
  this is no longer urgent; it becomes necessary when the book is larger than a few hundred MB, or when several servers
  run at once. Then reads should go to the database (one `select` per lookup, indexes already in place). It is a larger
  change: every service method becomes async.
- **One writer.** The write-ahead log assumes a single process. More than one server needs the database as the only
  truth (no log, or a leader that owns it) — do that with the read-through work above.
- **Backups are still JSON snapshots** (`src/backup.js` copies `store.data`). With a database, `pg_dump` is the better
  backup; the existing backup and restore still work and are still useful.
- **The worst write batch is still slow.** The load test showed one flush taking 0.9 s while the average was 13 ms; it
  happens when a large batch (a reset, a seed, a busy second) is written at once. It does not block a request — the log
  already holds the change — but it delays when the database catches up. Batching is the knob if it matters.
