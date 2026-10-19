'use strict';
// Watches the in-memory data so a unit of work can say what it changed — and undo itself if it fails.
//
// The services read and write plain objects in place (policy.status = 'Active', claim.payments.push(...)), so a store
// cannot learn what changed by comparing before and after without serializing the whole book, which is exactly the cost
// the database move removes (docs/PERFORMANCE.md). Instead the data is wrapped once in proxies: a read costs a map
// lookup, a write records the record that changed.
//
// The wrapper has to be invisible, because the code was written against plain objects:
//   - the same raw object always comes back as the same proxy (code compares records with ===)
//   - Array.isArray, JSON.stringify, spread and the array methods all behave as before
//   - reads are not recorded; only writes are

const INDEX = /^(?:0|[1-9]\d*)$/;

// JSON round-trip rather than structuredClone: the data is JSON by definition (it was a JSON file), and a value plucked
// from a proxy cannot be structuredClone'd.
const copy = (value) => JSON.parse(JSON.stringify(value));

const normalise = (spec) => (typeof spec === 'string' ? { kind: spec, key: 'id' } : spec);

class ChangeTracker {
  constructor(kinds) {
    this.kinds = new Map(Object.entries(kinds).map(([name, spec]) => [name, normalise(spec)]));
    this.cache = new WeakMap(); // raw object -> proxy, so identity is stable
    this.root = null;
    this.active = false;
    this.resetChanges();
  }

  resetChanges() {
    this.undo = [];
    this.snapshots = new WeakSet();
    this.rows = new Map(); // table -> Map(key -> record as it is now)
    this.structural = new Set(); // tables where records were added or removed
    this.kvKeys = new Map(); // table -> Set(key)
    this.docs = new Set(); // collections written whole
    this.resetRequested = false;
  }

  begin() {
    this.resetChanges();
    this.active = true;
  }

  // Everything is replaced (the reset-demo-data button). Part of the unit of work like any other change: if what comes
  // after fails, the copy in undo puts the old book back and no reset is written.
  resetAll(makeEmpty) {
    if (this.active && !this.snapshots.has(this.root)) {
      this.snapshots.add(this.root);
      this.undo.push({ type: 'obj', target: this.root, copy: copy(this.root) });
    }
    for (const key of Object.keys(this.root)) delete this.root[key];
    Object.assign(this.root, makeEmpty());
    this.resetRequested = true;
  }

  // What changed, for the store to write. Object values are resolved now, so the store does not have to know the data.
  end() {
    this.active = false;
    const kv = new Map();
    for (const [table, keys] of this.kvKeys) {
      const container = this.root[table] || {};
      const values = new Map();
      for (const key of keys) values.set(key, container[key]);
      kv.set(table, values);
    }
    const docs = new Map();
    for (const table of this.docs) docs.set(table, this.root[table]);
    return { rows: this.rows, structural: new Set(this.structural), kv, docs, reset: this.resetRequested };
  }

  // Undo every change of the unit of work, newest first, so the in-memory data is exactly as it was before it began.
  rollback() {
    for (let i = this.undo.length - 1; i >= 0; i--) {
      const entry = this.undo[i];
      if (entry.type === 'array') {
        entry.target.length = 0;
        for (const value of entry.copy) entry.target.push(value);
      } else {
        for (const key of Object.keys(entry.target)) delete entry.target[key];
        Object.assign(entry.target, entry.copy);
      }
    }
    this.resetChanges();
    this.active = false;
  }

  track(raw) {
    this.root = raw;
    return this.wrap(raw, { kind: 'root' });
  }

  // ---------------------------------------------------------------- the proxies

  wrap(raw, meta) {
    const cached = this.cache.get(raw);
    if (cached) return cached;
    const tracker = this;
    const proxy = new Proxy(raw, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target);
        if (value === null || typeof value !== 'object') return value;
        return tracker.wrap(value, tracker.metaFor(value, meta, prop));
      },
      set(target, prop, value) {
        tracker.touched(meta, target, prop, value);
        return Reflect.set(target, prop, value);
      },
      deleteProperty(target, prop) {
        tracker.touched(meta, target, prop, undefined);
        return Reflect.deleteProperty(target, prop);
      },
    });
    this.cache.set(raw, proxy);
    return proxy;
  }

  // The metadata of a child tells touched() what a write underneath it belongs to.
  metaFor(value, parent, prop) {
    switch (parent.kind) {
      case 'root': {
        const spec = this.kinds.get(prop) || { kind: 'doc', key: 'id' };
        if (!this.kinds.has(prop)) this.kinds.set(prop, spec); // a collection newer than this file: keep it whole
        if (spec.kind === 'rows') return { kind: 'rows', table: prop, key: spec.key };
        if (spec.kind === 'kv') return { kind: 'kv', table: prop };
        return { kind: 'doc', table: prop };
      }
      case 'rows':
        return { kind: 'row', table: parent.table, key: parent.key, root: value };
      case 'kv':
        return { kind: 'kvValue', table: parent.table, key: String(prop) };
      default:
        return parent; // inside a record, a key/value value or a document: the same record changes
    }
  }

  // ---------------------------------------------------------------- recording

  touched(meta, target, prop, value) {
    if (!this.active) return;
    switch (meta.kind) {
      case 'root':
        this.snapshotObject(this.root);
        this.docs.add(String(prop));
        break;
      case 'rows':
        this.snapshotArray(target);
        this.structural.add(meta.table);
        if (INDEX.test(String(prop)) && value && typeof value === 'object') this.markRow(value, meta);
        break;
      case 'row':
        this.snapshotObject(meta.root || target);
        this.markRow(meta.root || target, meta);
        break;
      case 'kv':
      case 'kvValue': {
        const key = meta.kind === 'kv' ? String(prop) : meta.key;
        this.snapshotObject(target);
        if (!this.kvKeys.has(meta.table)) this.kvKeys.set(meta.table, new Set());
        this.kvKeys.get(meta.table).add(key);
        if (meta.kind === 'kvValue') {
          const container = this.root[meta.table];
          this.snapshotObject(container);
        }
        break;
      }
      case 'doc':
        this.docs.add(meta.table);
        break;
      default:
        break;
    }
  }

  markRow(record, meta) {
    const key = record[meta.key];
    if (key === undefined || key === null) return;
    this.snapshotObject(record);
    if (!this.rows.has(meta.table)) this.rows.set(meta.table, new Map());
    this.rows.get(meta.table).set(String(key), record);
  }

  snapshotObject(target) {
    if (!target || typeof target !== 'object' || this.snapshots.has(target)) return;
    this.snapshots.add(target);
    // A copy of the values, not of the references: a record usually holds lists that were changed through the same proxy.
    this.undo.push({ type: Array.isArray(target) ? 'array' : 'obj', target, copy: copy(target) });
  }

  snapshotArray(target) {
    if (this.snapshots.has(target)) return;
    this.snapshots.add(target);
    this.undo.push({ type: 'array', target, copy: target.slice() });
  }
}

module.exports = { ChangeTracker, copy };
