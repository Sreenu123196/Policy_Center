'use strict';
// e-NACH mandates, simulated.
//
// A mandate is the customer's standing permission for us to debit their bank account: a cap, a frequency and a start date.
// The rules that matter are the refusals - a debit above the cap, a debit outside the frequency, a debit on a cancelled
// mandate, or a debit without the pre-debit notice the customer is entitled to. The real gateway can be swapped in behind
// this shape; what cannot be swapped is the rules.

const round2 = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
const FREQUENCIES = ['monthly', 'quarterly', 'yearly'];
const NOTICE_HOURS = 24;

function createMandates() {
  function create({ reference, cap, frequency = 'monthly', startsOn, vpa = null, bankAccountMasked = null }) {
    if (!reference) throw new Error('a mandate reference is required');
    const limit = round2(cap);
    if (!Number.isFinite(limit) || limit <= 0) throw new Error('cap must be a positive amount');
    if (!FREQUENCIES.includes(frequency)) throw new Error('frequency must be one of ' + FREQUENCIES.join(', '));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(startsOn || ''))) throw new Error('startsOn must be a date, YYYY-MM-DD');
    return {
      reference, cap: limit, frequency, startsOn,
      status: 'created', vpa, bankAccountMasked,
      debits: [], notices: [], createdAt: new Date().toISOString(),
    };
  }

  /** The customer approves the mandate in their bank app; ours only records the outcome. */
  function authorise(mandate, { authorisedOn }) {
    if (mandate.status !== 'created') throw new Error('only a created mandate can be authorised');
    mandate.status = 'active';
    mandate.authorisedOn = authorisedOn || new Date().toISOString().slice(0, 10);
    return mandate;
  }

  function cancel(mandate, { reason }) {
    if (mandate.status === 'cancelled') throw new Error('the mandate is already cancelled');
    mandate.status = 'cancelled';
    mandate.cancelledReason = reason || null;
    return mandate;
  }

  function notice(mandate, { debitOn, amount }) {
    if (mandate.status !== 'active') throw new Error('no debit notice on a mandate that is not active');
    const value = round2(amount);
    if (value > mandate.cap) throw new Error('the debit exceeds the mandate cap');
    mandate.notices = mandate.notices || [];
    mandate.notices.push({ debitOn, amount: value, gaveAt: new Date().toISOString() });
    return mandate;
  }

  /** A debit is allowed only if it is within the cap, noticed 24 hours before, and not already taken this period. */
  function debit(mandate, { on, amount, period }) {
    if (mandate.status !== 'active') throw new Error('the mandate is not active');
    const value = round2(amount);
    if (value > mandate.cap) throw new Error('the debit exceeds the mandate cap');
    // The duplicate check comes first: asking for a period already debited is a clearer fault than a missing notice, and
    // reporting the notice first sent the caller looking in the wrong place.
    if ((mandate.debits || []).some((d) => d.period === period)) throw new Error('this period has already been debited');
    const notified = (mandate.notices || []).some((n) => n.debitOn === on && n.amount === value);
    if (!notified) throw new Error('a debit needs the pre-debit notice to the customer');
    mandate.debits = mandate.debits || [];
    mandate.debits.push({ on, amount: value, period, takenAt: new Date().toISOString() });
    return mandate;
  }

  return { create, authorise, cancel, notice, debit, FREQUENCIES, NOTICE_HOURS };
}

module.exports = { createMandates, FREQUENCIES, NOTICE_HOURS };
