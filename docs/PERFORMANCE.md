# Performance and scale

How to measure: `node scripts/load-test.js` (add `--check` to fail when a target is missed). It makes a book of generated policies,
starts the server on it, signs in as the UW manager and runs a number of people at once. `GET /api/admin/metrics` (UW managers)
shows memory, record counts and what saving the data costs; `GET /api/health` is for a load balancer.

Measure on a quiet machine. The load test writes the whole book on every change, so a file sync tool or a busy disk changes
the result more than the code does: a run on this laptop while OneDrive was syncing reported saves at 95 ms and missed both
targets, and an isolated save measured on the same machine at the same moment still cost 27 ms. The numbers below were taken
with the machine otherwise idle. For a real measurement, keep the clone outside the synced folder (or pause the sync) and
run the load test on the server that will host it.

## What was found, and fixed

1. **A write could freeze the server for 22 seconds** (a book of 300 policies). Every write woke the event consumers, which worked
   through a backlog of events one at a time, and every one of those was a unit of work that copies and saves ALL the data (about
   70 ms). Now a backlog goes through in batches inside one unit of work, and all consumers catch up in one unit of work per write.
   If anything in a batch fails, the batch is undone and the failing event is retried, waited for and dead-lettered as before.
2. **The consumers ran inside the request**, so a person who saved something waited for the queues to be filled. They now run right
   after the response has gone (`setImmediate`), and several writes in a row ask once.
3. **A unit of work serialized the data twice** (a copy to undo with, and the text to save). On the server the text saved at the last
   commit now serves as the copy (`reuseSnapshot`), so it is serialized once. Tests keep the old behaviour, because they change the
   data directly.
4. **Start-up works off a backlog** of events before listening, in batches, so it takes seconds.

Result on the same book: 44 requests a second with 43% errors and 22 s stalls became 76 a second, no errors, a median of 0.3 s with
25 people hammering with no pause.

## What the JSON file cost, and what replaced it

The data lived in one JSON file that was copied and saved in full on every write. The cost grew with the size of the book. Measured on
one machine, 25 people, a pause of a second between requests (a normal load), reads and writes mixed 80/20:

| Policies | File | Reads p95 | Writes p95 | Save takes |
|---|---|---|---|---|
| 127 | 3 MB | 154 ms | 323 ms | 38 ms |
| 487 | 11 MB | 957 ms* | 1,336 ms* | 118 ms |
| 803 | 18 MB | 872 ms | 1,486 ms | 148 ms |

\* measured with the 600-policy book and a shorter pause.

So the simulator was comfortable up to a few hundred policies; beyond that the single thread spent its time saving and
everyone waited. That was a property of the storage, not a bug to tune away.

**The database back end** (`docs/DATABASE.md`) now writes one row per record, in one database transaction per change. The
same load test, on the same machine, against PostgreSQL 16.9:

| Book | Store | Reads p95 | Writes p95 | Saving takes | Targets |
|---|---|---|---|---|---|
| 127 policies | JSON file | 45 ms | 85 ms | 21 ms | met |
| 127 policies | PostgreSQL | 43 ms | 108 ms | 7 ms | met |
| 409 policies | JSON file | 405 ms | 689 ms | 78 ms | **missed: both** |
| 409 policies | PostgreSQL | **69 ms** | **34 ms** | 13 ms | met |

At a hundred-odd policies the file is fine and the database is slightly slower on writes. The difference is growth: at 409
policies the file misses both targets, and the database meets both. A single change on the demo book costs 25 ms to
rewrite the whole 3.5 MB file, against 0.25 ms to append a 6 KB frame to the log plus one row written afterwards.

Reads still come from memory (the whole book is loaded at start), but they are not slowed down by the change tracking: the
proxies that notice changes are only in place while a unit of work runs (`docs/DATABASE.md`). Read-through to the database
is the next step if the book grows past a few hundred MB, or when more than one server runs.

The modules keep their data in plain lists with fixed ids and talk to each other through functions and events, which is the
shape that moved to tables most easily — and the reason the change touched no service.

## Targets (the default profile: 150 policies, 25 people, a pause of a second)

| Measure | Target |
|---|---|
| Reads, 95th percentile | 300 ms |
| Writes, 95th percentile | 600 ms |
| Errors | under 0.1% |

For a real system the document's own targets (section 19) apply, on a real database, with several servers behind a load balancer.
