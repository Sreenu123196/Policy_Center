'use strict';
// The accounting sub-ledger: business events become balanced journal entries, once each, and producers get commission
// statements. Money is in dollars like the rest of the app.
//
//   What is posted, from which event (src/consumers.js hands each event to postFromEvent):
//     PolicyIssued, PolicyRenewed      Dr Premium receivable   Cr Written premium, Cr Instalment fee income
//     PolicyChanged, PolicyReinstated   the same, for the change (a return of premium is the opposite)
//     PolicyCancelled                   the opposite of the above, for the return premium
//     Commission on each premium entry  Dr Producer commission expense   Cr Producer commission payable (the rate is kept)
//     PaymentReceived                   Dr Cash   Cr Premium receivable
//     RefundIssued                      Dr Premium receivable   Cr Cash
//     ClaimPaid                         Dr Claims paid   Cr Cash
//     (a commission payment)            Dr Producer commission payable   Cr Cash
//   Entries are never changed or deleted; a mistake is corrected by a new entry. The premium receivable always equals what
//   the customers' ledgers say (reconciliation). Closing a month locks it: a posting dated in a closed month goes into the
//   next open month and says so, and a closed month that is altered afterwards is reported.

const crypto = require('node:crypto');
const PDFDocument = require('pdfkit');
const { AppError } = require('./policyCenter');
const { PRODUCER_CODES } = require('./productModel');
const { canSeeBillingReport } = require('./permissions');
const { Billing } = require('./billing');
const { round2 } = require('./rating');
const D = require('./dates');

const ACCOUNTS = {
  cash: { code: '1000', name: 'Cash', type: 'asset' },
  receivable: { code: '1200', name: 'Premium receivable', type: 'asset' },
  commissionPayable: { code: '2300', name: 'Producer commission payable', type: 'liability' },
  writtenPremium: { code: '4000', name: 'Written premium', type: 'income' },
  feeIncome: { code: '4100', name: 'Instalment fee income', type: 'income' },
  claimsPaid: { code: '5000', name: 'Claims paid', type: 'expense' },
  commissionExpense: { code: '5100', name: 'Producer commission expense', type: 'expense' },
};
const BY_CODE = Object.fromEntries(Object.values(ACCOUNTS).map((a) => [a.code, a]));
const DEFAULT_PRODUCER_COMMISSION = 0.1;
const PAYOUT_METHODS = ['Bank transfer', 'Cheque', 'Cash'];
const PREMIUM_EVENTS = { PolicyIssued: 'totalCost', PolicyRenewed: 'totalCost', PolicyChanged: 'premiumChange', PolicyCancelled: 'returnPremium', PolicyReinstated: 'premiumRestored', PremiumAuditCompleted: 'premiumChange' };

const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
const isMonth = (m) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(m || ''));
const lastDayOf = (month) => D.addDays(D.addMonths(`${month}-01`, 1), -1);
const nextMonthStart = (month) => D.addMonths(`${month}-01`, 1);
// A signed amount as a debit or a credit line: positive is a debit, negative is a credit of the same size.
const dr = (account, amount) => ({ account: account.code, ...(amount >= 0 ? { debit: round2(amount) } : { credit: round2(-amount) }) });
const cr = (account, amount) => dr(account, -amount);

class Accounting {
  constructor(pc) {
    this.pc = pc;
  }

  get db() {
    return this.pc.db;
  }

  requireManager(user, what = 'see the accounts') {
    if (!canSeeBillingReport(user)) throw new AppError(403, `${user.role} does not have authority to ${what}`);
  }

  rateFor(producerCode) {
    const rate = this.db.producerRates[producerCode];
    return rate === undefined ? DEFAULT_PRODUCER_COMMISSION : rate;
  }

  setProducerRate(user, producerCode, percent) {
    this.requireManager(user, 'set commission rates');
    if (!PRODUCER_CODES.some((p) => p.code === producerCode)) throw new AppError(404, 'Producer not found');
    const value = Number(percent);
    if (!Number.isFinite(value) || value < 0 || value > 100) throw new AppError(422, 'Commission must be between 0 and 100 percent');
    this.db.producerRates[producerCode] = round2(value) / 100;
    return { producerCode, ratePercent: round2(value) };
  }

  // ------------------------------------------------------------ posting

  // The first day postings may be dated: the day after the last closed month ends.
  openFrom() {
    const closed = this.db.closings.map((c) => c.month).sort();
    return closed.length ? nextMonthStart(closed[closed.length - 1]) : '0000-01-01';
  }

  post({ date, sourceEventId = null, type, reference, policyNumber = null, description, producerCode = null, commissionRate, premium, commission, lines }) {
    const debit = round2(lines.reduce((s, l) => s + (l.debit || 0), 0));
    const credit = round2(lines.reduce((s, l) => s + (l.credit || 0), 0));
    if (debit !== credit) throw new Error(`The entry for ${reference} does not balance (${debit} and ${credit})`);
    const open = this.openFrom();
    const late = date < open;
    const entry = {
      id: this.pc.store.id('je'), journalNumber: this.pc.store.number('JE-', 7), date: late ? open : date,
      ...(late ? { originalDate: date, latePosted: true } : {}),
      sourceEventId, type, reference, policyNumber, description, producerCode,
      ...(commissionRate !== undefined ? { commissionRate, premium, commission } : {}),
      lines, postedAt: this.pc.now(),
    };
    this.db.ledger.push(entry);
    return entry;
  }

  producerOf(policyNumber) {
    const policy = this.db.policies.find((p) => p.policyNumber === policyNumber);
    if (!policy) throw new Error(`Policy ${policyNumber} does not exist`);
    const account = this.db.accounts.find((a) => a.id === policy.accountId);
    return account ? account.producerCode : null;
  }

  // Posts the entry for one business event. Seeing an event twice posts nothing the second time.
  postFromEvent(event) {
    if (this.db.ledger.some((e) => e.sourceEventId === event.eventId)) return null;
    const p = event.payload;
    // Cash is dated by when the money moved (the payment's or the refund's own date), the rest by the business date of the event.
    const date = p.receivedOn || p.paidOn || event.businessDate || String(event.occurredAt).slice(0, 10);
    const base = { date, sourceEventId: event.eventId, policyNumber: p.policyNumber || null };
    if (PREMIUM_EVENTS[event.type]) {
      const amount = round2(p[PREMIUM_EVENTS[event.type]] || 0);
      // Events from before the fees were recorded: the fees are on the invoices of that job.
      const fees = round2(p.installmentFees !== undefined ? p.installmentFees : this.db.invoices.filter((i) => i.jobNumber === p.jobNumber && this.db.policies.some((x) => x.id === i.policyId && x.policyNumber === p.policyNumber)).reduce((sum, i) => sum + (i.fee || 0), 0));
      const producerCode = this.producerOf(p.policyNumber);
      const rate = this.rateFor(producerCode);
      const commission = round2(amount * rate);
      return this.post({
        ...base, type: 'premium', reference: p.policyNumber, description: `${event.type}: ${p.jobNumber || ''} ${p.jobType || ''}`.trim(), producerCode,
        commissionRate: rate, premium: amount, commission,
        lines: [dr(ACCOUNTS.receivable, amount + fees), cr(ACCOUNTS.writtenPremium, amount), ...(fees ? [cr(ACCOUNTS.feeIncome, fees)] : []), dr(ACCOUNTS.commissionExpense, commission), cr(ACCOUNTS.commissionPayable, commission)].filter((l) => (l.debit || l.credit)),
      });
    }
    if (event.type === 'PaymentReceived') {
      return this.post({ ...base, type: 'payment', reference: p.paymentNumber, description: `Payment received on ${p.policyNumber}`, producerCode: this.producerOf(p.policyNumber), lines: [dr(ACCOUNTS.cash, p.amount), cr(ACCOUNTS.receivable, p.amount)] });
    }
    if (event.type === 'RefundIssued') {
      return this.post({ ...base, type: 'refund', reference: p.refundNumber, description: `Refund issued on ${p.policyNumber}`, producerCode: this.producerOf(p.policyNumber), lines: [dr(ACCOUNTS.receivable, p.amount), cr(ACCOUNTS.cash, p.amount)] });
    }
    if (event.type === 'ClaimPaid') {
      const claim = this.db.claims.find((c) => c.claimNumber === p.claimNumber);
      const policy = claim && this.db.policies.find((x) => x.id === claim.policyId);
      return this.post({ ...base, policyNumber: policy ? policy.policyNumber : null, type: 'claim', reference: p.claimNumber, description: `Claim payment on ${p.claimNumber}`, lines: [dr(ACCOUNTS.claimsPaid, p.amount), cr(ACCOUNTS.cash, p.amount)] });
    }
    return null; // an event the accounts do not care about
  }

  // ------------------------------------------------------------ reading

  journal(user, { from, to, account } = {}) {
    this.requireManager(user);
    return this.db.ledger
      .filter((e) => (!from || e.date >= from) && (!to || e.date <= to) && (!account || e.lines.some((l) => l.account === account)))
      .slice()
      .sort((a, b) => a.date.localeCompare(b.date) || a.journalNumber.localeCompare(b.journalNumber))
      .map((e) => JSON.parse(JSON.stringify(e)));
  }

  trialBalance(user, { asOf } = {}) {
    this.requireManager(user);
    const rows = Object.values(ACCOUNTS).map((a) => ({ code: a.code, name: a.name, type: a.type, debit: 0, credit: 0, balance: 0 }));
    for (const e of this.db.ledger) {
      if (asOf && e.date > asOf) continue;
      for (const l of e.lines) {
        const row = rows.find((r) => r.code === l.account);
        row.debit = round2(row.debit + (l.debit || 0));
        row.credit = round2(row.credit + (l.credit || 0));
      }
    }
    for (const r of rows) r.balance = round2(r.debit - r.credit);
    const totalDebit = round2(rows.reduce((s, r) => s + r.debit, 0));
    const totalCredit = round2(rows.reduce((s, r) => s + r.credit, 0));
    return { asOf: asOf || this.pc.today(), accounts: rows, totalDebit, totalCredit, balanced: totalDebit === totalCredit };
  }

  // The premium receivable in the books against what the customers' ledgers say. They must agree.
  reconciliation(user) {
    this.requireManager(user, 'see the reconciliation');
    const billing = new Billing(this.pc);
    const gl = new Map();
    for (const e of this.db.ledger) for (const l of e.lines) if (l.account === ACCOUNTS.receivable.code && e.policyNumber) gl.set(e.policyNumber, round2((gl.get(e.policyNumber) || 0) + (l.debit || 0) - (l.credit || 0)));
    const differences = [];
    let customerBalances = 0;
    for (const policy of this.db.policies) {
      const ledger = billing.ledgerFor(policy.id, user).balance;
      customerBalances = round2(customerBalances + ledger);
      const books = gl.get(policy.policyNumber) || 0;
      if (books !== ledger) differences.push({ policyNumber: policy.policyNumber, books, ledger, difference: round2(books - ledger) });
    }
    const glReceivable = round2([...gl.values()].reduce((s, v) => s + v, 0));
    return { glReceivable, customerBalances, difference: round2(glReceivable - customerBalances), differences };
  }

  // ------------------------------------------------------------ closing a month

  closeHash(month) {
    const entries = this.db.ledger.filter((e) => e.date.slice(0, 7) === month).sort((a, b) => a.journalNumber.localeCompare(b.journalNumber));
    return { hash: sha256(JSON.stringify(entries.map((e) => [e.journalNumber, e.date, e.lines]))), count: entries.length };
  }

  closeMonth(user, month) {
    this.requireManager(user, 'close a month');
    if (!isMonth(month)) throw new AppError(422, 'The month must be like 2026-03');
    if (month > this.pc.today().slice(0, 7)) throw new AppError(422, 'A month that has not started cannot be closed');
    const closed = this.db.closings.map((c) => c.month).sort();
    if (closed.includes(month)) throw new AppError(409, `${month} is already closed`);
    if (closed.length && month < closed[closed.length - 1]) throw new AppError(409, 'Months are closed in order; a later month is already closed');
    const tb = this.trialBalance(user, { asOf: lastDayOf(month) });
    if (!tb.balanced) throw new AppError(422, 'The books do not balance; the month cannot be closed');
    const { hash, count } = this.closeHash(month);
    const closing = { month, closedAt: this.pc.now(), closedBy: user.id, entryCount: count, hash, totalDebit: tb.totalDebit, totalCredit: tb.totalCredit, balanced: tb.balanced };
    this.db.closings.push(closing);
    return { ...closing };
  }

  verifyClosings(user) {
    this.requireManager(user);
    return this.db.closings.map((c) => {
      const now = this.closeHash(c.month);
      const valid = now.hash === c.hash;
      return { month: c.month, closedAt: c.closedAt, closedBy: c.closedBy, entryCount: c.entryCount, valid, ...(valid ? {} : { problem: 'Entries in this month were changed or removed after it was closed' }) };
    });
  }

  // ------------------------------------------------------------ general ledger export

  glCsv(user, { from, to } = {}) {
    this.requireManager(user, 'export the general ledger');
    const cell = (value) => {
      let text = String(value == null ? '' : value);
      if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`; // a text that a spreadsheet would run as a formula is made plain text
      return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };
    const rows = [['Date', 'Journal', 'Account', 'Account name', 'Debit', 'Credit', 'Description', 'Reference', 'Producer'].join(',')];
    for (const e of this.journal(user, { from, to })) {
      for (const l of e.lines) {
        rows.push([e.date, e.journalNumber, l.account, BY_CODE[l.account].name, l.debit ? l.debit.toFixed(2) : '', l.credit ? l.credit.toFixed(2) : '', e.description, e.reference, e.producerCode || ''].map(cell).join(','));
      }
    }
    return rows.join('\r\n') + '\r\n';
  }

  // ------------------------------------------------------------ producers and commission

  producers(user) {
    this.requireManager(user, 'see producers and commission');
    return PRODUCER_CODES.map((p) => {
      const s = this.statementData(p.code, {});
      return { code: p.code, name: p.name, ratePercent: round2(this.rateFor(p.code) * 100), earned: s.earned, paid: s.paid, payable: s.payable };
    });
  }

  statementData(code, { from, to } = {}) {
    const inRange = (e) => (!from || e.date >= from) && (!to || e.date <= to);
    const mine = this.db.ledger.filter((e) => e.producerCode === code);
    const lines = mine.filter((e) => e.type === 'premium' && inRange(e)).sort((a, b) => a.date.localeCompare(b.date) || a.journalNumber.localeCompare(b.journalNumber))
      .map((e) => ({ date: e.date, policyNumber: e.policyNumber, transaction: e.description, premium: e.premium, rate: e.commissionRate, commission: e.commission }));
    const payments = mine.filter((e) => e.type === 'commission_payment' && inRange(e)).map((e) => ({ date: e.date, reference: e.reference, amount: e.paid, method: e.method }));
    const allEarned = round2(mine.filter((e) => e.type === 'premium' && (!to || e.date <= to)).reduce((s, e) => s + e.commission, 0));
    const allPaid = round2(mine.filter((e) => e.type === 'commission_payment' && (!to || e.date <= to)).reduce((s, e) => s + e.paid, 0));
    return {
      earned: round2(lines.reduce((s, l) => s + l.commission, 0)), paid: round2(payments.reduce((s, p) => s + p.amount, 0)),
      payable: round2(allEarned - allPaid), lines, payments,
    };
  }

  // Managers see any producer; a producer sees their own. Anyone else is refused.
  statement(user, code, range = {}) {
    const producer = PRODUCER_CODES.find((p) => p.code === code);
    if (user.role === 'Agent') {
      if (!producer || user.producerCode !== code) throw new AppError(404, 'Producer not found');
    } else {
      this.requireManager(user, 'see commission statements');
      if (!producer) throw new AppError(404, 'Producer not found');
    }
    for (const d of [range.from, range.to]) if (d && !D.isDate(d)) throw new AppError(422, 'Dates must be yyyy-mm-dd');
    return { producerCode: code, producerName: producer.name, from: range.from || null, to: range.to || null, ratePercent: round2(this.rateFor(code) * 100), ...this.statementData(code, range) };
  }

  payCommission(user, { producerCode, amount, method, reference, paidOn }) {
    this.requireManager(user, 'pay commission');
    if (!PRODUCER_CODES.some((p) => p.code === producerCode)) throw new AppError(404, 'Producer not found');
    const errors = [];
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) errors.push('The amount must be more than zero');
    if (!PAYOUT_METHODS.includes(method)) errors.push(`The method must be one of ${PAYOUT_METHODS.join(', ')}`);
    if (!D.isDate(paidOn)) errors.push('The date paid must be yyyy-mm-dd');
    if (!String(reference || '').trim()) errors.push('A reference is required');
    if (errors.length) throw new AppError(422, errors.join('; '), { errors: errors.map((message) => ({ message })) });
    const payable = this.statementData(producerCode, {}).payable;
    if (round2(value) > payable) throw new AppError(422, `Only ${payable} is payable to ${producerCode}; a larger payment is refused`);
    const entry = this.post({
      date: paidOn, type: 'commission_payment', reference: String(reference).trim(), description: `Commission paid to ${producerCode}`, producerCode,
      lines: [dr(ACCOUNTS.commissionPayable, round2(value)), cr(ACCOUNTS.cash, round2(value))],
    });
    entry.paid = round2(value);
    entry.method = method;
    this.pc.publish('CommissionPaid', { producerCode, reference: entry.reference, amount: entry.paid });
    return { journalNumber: entry.journalNumber, amount: entry.paid, payable: round2(payable - entry.paid) };
  }

  statementCsv(user, code, range) {
    const s = this.statement(user, code, range);
    const rows = [['Date', 'Policy', 'Transaction', 'Premium', 'Rate', 'Commission'].join(',')];
    for (const l of s.lines) rows.push([l.date, l.policyNumber, `"${String(l.transaction).replace(/"/g, '""')}"`, l.premium.toFixed(2), `${round2(l.rate * 100)}%`, l.commission.toFixed(2)].join(','));
    return rows.join('\r\n') + '\r\n';
  }

  statementPdf(user, code, range) {
    const s = this.statement(user, code, range);
    const money = (n) => Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ size: 'A4', margin: 40 });
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
      doc.font('Helvetica-Bold').fontSize(16).text('Commission statement');
      doc.font('Helvetica').fontSize(10).text(`${s.producerName} (${s.producerCode}) · rate ${s.ratePercent}% · ${s.from || 'start'} to ${s.to || 'today'}`);
      doc.moveDown();
      const row = (cells, bold = false) => {
        doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9);
        const y = doc.y;
        [[40, 60, 'left'], [100, 80, 'left'], [180, 190, 'left'], [370, 70, 'right'], [440, 50, 'right'], [490, 65, 'right']].forEach(([x, w, align], i) => doc.text(String(cells[i]), x, y, { width: w - 4, align }));
        doc.moveDown(0.5);
      };
      row(['Date', 'Policy', 'Transaction', 'Premium', 'Rate', 'Commission'], true);
      for (const l of s.lines) row([l.date, l.policyNumber, l.transaction, money(l.premium), `${round2(l.rate * 100)}%`, money(l.commission)]);
      doc.moveDown();
      doc.font('Helvetica-Bold').fontSize(10).text(`Earned ${money(s.earned)} · Paid ${money(s.paid)} · Payable ${money(s.payable)}`);
      doc.end();
    });
  }
}

module.exports = { Accounting, ACCOUNTS, DEFAULT_PRODUCER_COMMISSION, PAYOUT_METHODS };
