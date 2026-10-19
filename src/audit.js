'use strict';
// The audit log: a permanent record of who (a person or an agent) did what, when and why. Entries are only ever added. Each holds
// the hash of the one before it, so changing or removing an old entry breaks the chain and verify() says where.
const crypto = require('node:crypto');
const { AppError } = require('./policyCenter');

const GENESIS = '0'.repeat(64);
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

// The part of an entry the hash covers.
const body = (e) => JSON.stringify([e.seq, e.at, e.actor, e.action, e.subject, e.reasons, e.data, e.prevHash]);

class AuditLog {
  constructor(pc) {
    this.pc = pc;
  }

  get entries() {
    if (!this.pc.db.auditLog) this.pc.db.auditLog = [];
    return this.pc.db.auditLog;
  }

  // actor: a staff record (a person or an agent account). reasons: why, in words a person can read.
  record({ actor, action, subject = null, reasons = [], data = null }) {
    const last = this.entries[this.entries.length - 1];
    const entry = {
      seq: last ? last.seq + 1 : 1,
      at: this.pc.now(),
      actor: { id: actor.id, name: actor.name, kind: actor.role === 'AI Agent' ? 'agent' : 'person' },
      action,
      subject,
      reasons,
      data,
      prevHash: last ? last.hash : GENESIS,
    };
    entry.hash = sha256(body(entry));
    this.entries.push(entry);
    return entry;
  }

  verify() {
    let prev = GENESIS;
    for (const e of this.entries) {
      if (e.prevHash !== prev || e.hash !== sha256(body(e))) return { ok: false, brokenAt: e.seq, entries: this.entries.length };
      prev = e.hash;
    }
    return { ok: true, entries: this.entries.length };
  }

  // Newest first. UW managers only.
  list(user, { limit = 200, action, actor } = {}) {
    this.pc.requireManager(user, 'read the audit log');
    return [...this.entries]
      .reverse()
      .filter((e) => (!action || e.action.startsWith(action)) && (!actor || e.actor.id === actor))
      .slice(0, Math.min(Number(limit) || 200, 1000));
  }
}

module.exports = { AuditLog, AppError };
