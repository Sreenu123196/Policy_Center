'use strict';
// The PostgreSQL back end: a record is a row, and a unit of work writes only the rows it changed.
//
// The app's services are synchronous — store.transaction() runs a function and hands the result back — while a database
// write is not. A transaction therefore does two things:
//   1. commit: appends the changed rows to a small write-ahead log, synchronously. That is the moment the change is safe
//      (src/pg/wal.js explains the one thing it does not cover).
//   2. flush: writes those rows to PostgreSQL in one database transaction, right after the response.
// If the process dies between the two, load() replays the log at the next start, so nothing is lost.
//
// The same API as src/store.js (next, id, number, isEmpty, reset, transaction, data, stats), so the services and the tests
// do not know which store they have.

const { empty } = require('../store');
const { ChangeTracker } = require('./changeTracker');
const { WriteAheadLog } = require('./wal');
const {
  ROW_COLLECTIONS, KV_COLLECTIONS, DOC_COLLECTIONS, KINDS,
  tableFor, kvTableFor, DOCS_TABLE, META_TABLE, schemaStatements,
} = require('./schema');

const CHUNK = 100; // rows per statement: large enough to be fast, small enough not to hit the parameter limit
const ms = (started) => Number(process.hrtime.bigint() - started) / 1e6;
const addTo = (map, key, value) => {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
};

class PostgresStore {
  constructor(runner, options = {}) {
    this.runner = runner;
    this.walFile = options.walFile || null;
    this.autoFlush = options.autoFlush !== false;
    this.onError = options.onError || null;
    this.tracker = new ChangeTracker(KINDS);
    this.wal = this.walFile ? new WriteAheadLog(this.walFile) : null;
    this.raw = empty();
    // The proxies that notice changes are only in place while a unit of work runs. A write must go through
    // store.transaction anyway (the whole app does), and reads outside one then cost nothing extra: a full scan of a
    // 409-policy book measured 0.037 ms plain against 0.525 ms through the proxies.
    this.tracked = this.tracker.track(this.raw);
    this.known = new Map(); // table -> Set of the keys the database holds
    this.pending = []; // frames logged but not yet in the database
    this.seq = 0; // the newest frame
    this.applied = 0; // the newest frame the database has
    this.flushing = null;
    this.retryTimer = null;
    this.degraded = null; // set while the database cannot be written: the log still holds the changes
    this.stats = { saves: 0, rowsWritten: 0, lastSaveMs: 0, maxSaveMs: 0, totalSaveMs: 0, lastSaveBytes: 0 };
  }

  // ---------------------------------------------------------------- start and stop

  async load() {
    await this.ensureSchema();
    if (this.wal) this.wal.open();
    this.applied = await this.readApplied();
    if (this.wal) {
      const frames = this.wal.read().filter((frame) => frame.seq > this.applied);
      if (frames.length) {
        await this.applyFrames(frames);
        this.applied = frames[frames.length - 1].seq;
      }
      this.wal.truncate();
    }
    this.seq = this.applied;
    await this.readAll();
    return this;
  }

  async ensureSchema() {
    const statements = schemaStatements();
    await this.runner.transaction(async (q) => {
      for (const statement of statements) await q(statement);
    });
  }

  async readApplied() {
    const { rows } = await this.runner.query(`select value from ${META_TABLE} where key = 'wal_seq'`);
    return rows.length ? Number(rows[0].value) : 0;
  }

  async readAll() {
    const data = empty();
    for (const name of Object.keys(ROW_COLLECTIONS)) {
      const { rows } = await this.runner.query(`select id, doc from ${tableFor(name)}`);
      data[name] = rows.map((row) => row.doc);
      this.known.set(name, new Set(rows.map((row) => String(row.id))));
    }
    for (const name of KV_COLLECTIONS) {
      const { rows } = await this.runner.query(`select key, doc from ${kvTableFor(name)}`);
      data[name] = Object.fromEntries(rows.map((row) => [row.key, row.doc]));
    }
    for (const name of DOC_COLLECTIONS) data[name] = [];
    for (const row of (await this.runner.query(`select key, doc from ${DOCS_TABLE}`)).rows) {
      const spec = KINDS[row.key];
      if (!spec || spec.kind === 'doc') data[row.key] = row.doc;
    }
    for (const [name, spec] of Object.entries(KINDS)) {
      if (data[name] === undefined) data[name] = spec.kind === 'rows' ? [] : spec.kind === 'kv' ? {} : [];
    }
    this.raw = data;
    this.tracked = this.tracker.track(data);
  }

  async drain() {
    if (!this.autoFlush) return;
    for (;;) {
      if (!this.pending.length) return;
      if (this.flushing) {
        await this.flushing.catch(() => {});
        continue;
      }
      if (this.degraded) return;
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  async close() {
    await this.drain();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (this.wal) this.wal.close();
  }

  // ---------------------------------------------------------------- the API src/store.js also offers

  // Watched only while a unit of work runs (see the constructor): the services read through this getter every time.
  get data() {
    return this.tracker.active ? this.tracked : this.raw;
  }

  set data(value) {
    this.raw = value;
    this.tracked = this.tracker.track(value);
  }

  next(name) {
    this.data.seq[name] = (this.data.seq[name] || 0) + 1;
    return this.data.seq[name];
  }

  id(prefix) {
    return `${prefix}${this.next(`id:${prefix}`)}`;
  }

  number(prefix, width) {
    return prefix + String(this.next(`num:${prefix}`)).padStart(width, '0');
  }

  isEmpty() {
    return this.data.accounts.length === 0;
  }

  // The reset-demo-data button. Inside a unit of work it is part of that unit: everything that follows (the seed) is
  // written in the same frame as the truncate, and a failure puts the old book back.
  reset() {
    if (this.tracker.active) {
      this.tracker.resetAll(empty);
      this.known.clear();
      return;
    }
    this.tracker.resetAll(empty);
    this.known.clear();
    this.commit([{ k: 'reset' }]);
  }

  // A unit of work: everything inside either stands together or is undone together.
  transaction(fn) {
    this.tracker.begin();
    let result;
    try {
      result = fn();
    } catch (err) {
      this.tracker.rollback();
      this.reconcileKnown(); // an undone reset had cleared it
      throw err;
    }
    this.commit(this.opsFor(this.tracker.end()));
    return result;
  }

  // What the database holds, taken from the data in memory. Only used after an undo.
  reconcileKnown() {
    for (const name of Object.keys(ROW_COLLECTIONS)) {
      const key = KINDS[name].key;
      this.known.set(name, new Set(this.data[name].map((record) => String(record[key]))));
    }
  }

  // ---------------------------------------------------------------- what changed -> rows

  opsFor(changes) {
    const ops = [];
    // The truncate comes first in the frame, then what was written after it.
    if (changes.reset) ops.push({ k: 'reset' });
    for (const [table, records] of changes.rows) {
      for (const [id, doc] of records) ops.push({ k: 'row', table, id, doc });
    }
    // Records that left a collection: the database still has them, so they are deleted. Only tables whose shape changed
    // are compared — one pass over the keys, not over the records.
    for (const table of changes.structural) {
      const key = (KINDS[table] && KINDS[table].key) || 'id';
      const current = new Set(this.data[table].map((record) => String(record[key])));
      for (const id of this.known.get(table) || []) if (!current.has(id)) ops.push({ k: 'del', table, id });
      this.known.set(table, current);
    }
    for (const [table, values] of changes.kv) {
      for (const [key, value] of values) ops.push(value === undefined ? { k: 'kvdel', table, key } : { k: 'kv', table, key, doc: value });
    }
    for (const [table, doc] of changes.docs) ops.push({ k: 'doc', table, doc });
    return ops;
  }

  commit(ops) {
    if (!ops.length) return;
    const frame = { seq: this.seq + 1, ops };
    this.seq = frame.seq;
    const started = process.hrtime.bigint();
    this.stats.lastSaveBytes = this.wal ? this.wal.append(frame) : Buffer.byteLength(JSON.stringify(frame));
    this.stats.lastSaveMs = ms(started);
    this.stats.saves += 1;
    this.stats.rowsWritten += ops.filter((op) => op.k === 'row' || op.k === 'del').length;
    this.pending.push(frame);
    this.schedule();
  }

  // ---------------------------------------------------------------- writing the rows

  schedule() {
    if (!this.autoFlush || this.flushing || !this.pending.length) return;
    this.flushing = this.flush()
      .catch((err) => { this.degraded = err.message; })
      .finally(() => { this.flushing = null; });
  }

  retry() {
    if (this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.schedule();
    }, 1000);
    if (this.retryTimer.unref) this.retryTimer.unref();
  }

  async flush() {
    while (this.pending.length) {
      const batch = this.pending.slice();
      const started = process.hrtime.bigint();
      try {
        await this.applyFrames(batch);
      } catch (err) {
        this.degraded = err.message;
        if (this.onError) this.onError(err);
        this.retry(); // the frames stay in the log; the next attempt (or the next start) writes them
        return;
      }
      const duration = ms(started);
      this.stats.lastSaveMs = duration;
      this.stats.maxSaveMs = Math.max(this.stats.maxSaveMs, duration);
      this.stats.totalSaveMs += duration;
      this.pending.splice(0, batch.length);
      this.degraded = null;
      if (this.wal && !this.pending.length) this.wal.truncate();
    }
  }

  async applyFrames(frames) {
    const top = frames[frames.length - 1];
    await this.runner.transaction(async (q) => {
      for (const frame of frames) await this.applyOps(q, frame.ops);
      await q(
        `insert into ${META_TABLE} (key, value) values ('wal_seq', $1::jsonb)
         on conflict (key) do update set value = excluded.value`,
        [JSON.stringify(top.seq)],
      );
    });
    this.applied = top.seq;
  }

  async applyOps(q, ops) {
    const upserts = new Map();
    const deletes = new Map();
    const kvUpserts = new Map();
    const kvDeletes = new Map();
    const docs = new Map();
    let reset = false;

    for (const op of ops) {
      if (op.k === 'row') addTo(upserts, op.table, { id: String(op.id), doc: op.doc });
      else if (op.k === 'del') addTo(deletes, op.table, String(op.id));
      else if (op.k === 'kv') addTo(kvUpserts, op.table, { key: op.key, doc: op.doc });
      else if (op.k === 'kvdel') addTo(kvDeletes, op.table, op.key);
      else if (op.k === 'doc') docs.set(op.table, op.doc);
      else if (op.k === 'reset') reset = true;
    }

    if (reset) {
      const tables = [...Object.keys(ROW_COLLECTIONS).map(tableFor), ...KV_COLLECTIONS.map(kvTableFor), DOCS_TABLE];
      await q(`truncate table ${tables.join(', ')}`);
    }
    for (const [table, records] of upserts) await this.upsertRows(q, tableFor(table), records);
    for (const [table, ids] of deletes) await this.deleteBy(q, tableFor(table), 'id', ids);
    for (const [table, records] of kvUpserts) await this.upsertKv(q, kvTableFor(table), records);
    for (const [table, keys] of kvDeletes) await this.deleteBy(q, kvTableFor(table), 'key', keys);
    for (const [table, doc] of docs) {
      await q(
        `insert into ${DOCS_TABLE} (key, doc) values ($1, $2::jsonb)
         on conflict (key) do update set doc = excluded.doc, updated_at = now()`,
        [table, JSON.stringify(doc)],
      );
    }
  }

  async upsertRows(q, table, records) {
    for (let i = 0; i < records.length; i += CHUNK) {
      const chunk = records.slice(i, i + CHUNK);
      const values = chunk.map((_, j) => `($${j * 2 + 1}, $${j * 2 + 2}::jsonb)`).join(', ');
      await q(
        `insert into ${table} (id, doc) values ${values}
         on conflict (id) do update set doc = excluded.doc, updated_at = now()`,
        chunk.flatMap((record) => [record.id, JSON.stringify(record.doc)]),
      );
    }
  }

  async upsertKv(q, table, records) {
    for (let i = 0; i < records.length; i += CHUNK) {
      const chunk = records.slice(i, i + CHUNK);
      const values = chunk.map((_, j) => `($${j * 2 + 1}, $${j * 2 + 2}::jsonb)`).join(', ');
      await q(
        `insert into ${table} (key, doc) values ${values}
         on conflict (key) do update set doc = excluded.doc, updated_at = now()`,
        chunk.flatMap((record) => [record.key, JSON.stringify(record.doc)]),
      );
    }
  }

  async deleteBy(q, table, column, values) {
    for (let i = 0; i < values.length; i += CHUNK) {
      const chunk = values.slice(i, i + CHUNK);
      const placeholders = chunk.map((_, j) => `$${j + 1}`).join(', ');
      await q(`delete from ${table} where ${column} in (${placeholders})`, chunk);
    }
  }
}

module.exports = { PostgresStore };
