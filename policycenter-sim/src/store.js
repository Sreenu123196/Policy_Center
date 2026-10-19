'use strict';
// JSON-file persistence. Stands in for the PolicyCenter database.
// Pass no file for an in-memory store (used by tests).

const fs = require('node:fs');
const path = require('node:path');

const empty = () => ({ seq: {}, accounts: [], policies: [], jobs: [], activities: [], invoices: [], payments: [], documents: [], events: [], claims: [], followUps: [], messages: [], tickets: [], staff: [] });

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
  constructor(file) {
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
    this.data = empty();
  }

  // Runs fn as a unit of work: on error the in-memory data is rolled back and nothing is written.
  transaction(fn) {
    const snapshot = JSON.stringify(this.data);
    try {
      const result = fn();
      this.save();
      return result;
    } catch (err) {
      this.data = JSON.parse(snapshot);
      throw err;
    }
  }

  save() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data));
    // Sync clients such as OneDrive can briefly lock the file; retry before giving up.
    for (let attempt = 1; ; attempt++) {
      try {
        fs.renameSync(tmp, this.file);
        return;
      } catch (err) {
        if (!['EPERM', 'EBUSY', 'EACCES'].includes(err.code) || attempt >= 8) throw err;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * attempt);
      }
    }
  }
}

module.exports = { Store };
