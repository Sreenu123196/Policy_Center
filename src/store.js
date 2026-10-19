'use strict';
// JSON-file persistence. Stands in for the PolicyCenter database.
// Pass no file for an in-memory store (used by tests).

const fs = require('node:fs');
const path = require('node:path');

const empty = () => ({ seq: {}, accounts: [], policies: [], jobs: [], activities: [], invoices: [], payments: [], refunds: [], ledger: [], closings: [], producerRates: {}, eventConsumers: {}, eventFailures: [], idempotency: {}, documents: [], events: [], claims: [], followUps: [], messages: [], tickets: [], staff: [] });

// Claims saved before the stage workflow used "Open" and "Closed". Map them to the new stages.
function migrateClaims(claims) {
  for (const c of claims) {
    if (!c.history) c.history = [];
    if (!c.documents) c.documents = [];
    if (c.status === 'Open') c.status = c.payments && c.payments.length ? 'Approved' : 'Under Review';
    if (c.status === 'Closed') c.status = 'Settled';
  }
}

class Store {
  // options.reuseSnapshot: the server turns this on. Every unit of work needs a copy of the data to undo itself with, and saving needs
  // the data as text; with this on, the text saved at the last commit serves as the copy, so a unit of work serializes the data once
  // instead of twice. It assumes nothing changes the data outside a unit of work (true of the server; tests change it directly, so
  // it is off for them).
  constructor(file, options = {}) {
    this.reuseSnapshot = Boolean(options.reuseSnapshot);
    this.committed = null; // the data as text, as of the last commit
    this.file = file || null;
    this.data = empty();
    if (this.file && fs.existsSync(this.file)) this.data = { ...empty(), ...JSON.parse(fs.readFileSync(this.file, 'utf8')) };
    migrateClaims(this.data.claims);
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

  reset() {
    this.committed = null;
    this.data = empty();
  }

  // Runs fn as a unit of work: on error the in-memory data is rolled back and nothing is written.
  transaction(fn) {
    const snapshot = this.reuseSnapshot && this.committed !== null ? this.committed : JSON.stringify(this.data);
    try {
      const result = fn();
      this.save();
      return result;
    } catch (err) {
      this.data = JSON.parse(snapshot);
      this.committed = this.reuseSnapshot ? snapshot : null;
      throw err;
    }
  }

  // What saving costs, for the metrics endpoint and the load test: how many saves, how long the last and the slowest took, how big the file is.
  stats = { saves: 0, lastSaveMs: 0, maxSaveMs: 0, totalSaveMs: 0, lastSaveBytes: 0 };

  save() {
    if (!this.file) return;
    const started = process.hrtime.bigint();
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    const text = JSON.stringify(this.data);
    this.stats.lastSaveBytes = Buffer.byteLength(text);
    if (this.reuseSnapshot) this.committed = text;
    fs.writeFileSync(tmp, text);
    // Sync clients such as OneDrive can briefly lock the file; retry before giving up.
    for (let attempt = 1; ; attempt++) {
      try {
        fs.renameSync(tmp, this.file);
        const ms = Number(process.hrtime.bigint() - started) / 1e6;
        Object.assign(this.stats, { saves: this.stats.saves + 1, lastSaveMs: ms, maxSaveMs: Math.max(this.stats.maxSaveMs, ms), totalSaveMs: this.stats.totalSaveMs + ms });
        return;
      } catch (err) {
        if (!['EPERM', 'EBUSY', 'EACCES'].includes(err.code) || attempt >= 8) throw err;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * attempt);
      }
    }
  }
}

module.exports = { Store };
