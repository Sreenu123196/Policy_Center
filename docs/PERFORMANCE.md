# Performance and scale

How to measure: `node scripts/load-test.js` (add `--check` to fail when a target is missed). It makes a book of generated policies,
starts the server on it, signs in as the UW manager and runs a number of people at once. `GET /api/admin/metrics` (UW managers)
shows memory, record counts and what saving the data costs; `GET /api/health` is for a load balancer.

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

## What is still the limit

The data lives in one JSON file that is copied and saved in full on every write. The cost grows with the size of the book. Measured on
one machine, 25 people, a pause of a second between requests (a normal load), reads and writes mixed 80/20:

| Policies | File | Reads p95 | Writes p95 | Save takes |
|---|---|---|---|---|
| 127 | 3 MB | 154 ms | 323 ms | 38 ms |
| 487 | 11 MB | 957 ms* | 1,336 ms* | 118 ms |
| 803 | 18 MB | 872 ms | 1,486 ms | 148 ms |

\* measured with the 600-policy book and a shorter pause.

So the simulator is comfortable up to a few hundred policies. Beyond that the single thread spends its time saving, and everyone
waits. This is a property of the storage, not a bug to tune away: **before real use, move the data to a database** (PostgreSQL), with
one row per record, a transaction per write and indexes for the searches. The modules already keep their data in plain lists with
fixed ids and talk to each other through functions and events, which is the shape that moves to tables most easily.

## Targets (the default profile: 150 policies, 25 people, a pause of a second)

| Measure | Target |
|---|---|
| Reads, 95th percentile | 300 ms |
| Writes, 95th percentile | 600 ms |
| Errors | under 0.1% |

For a real system the document's own targets (section 19) apply, on a real database, with several servers behind a load balancer.
