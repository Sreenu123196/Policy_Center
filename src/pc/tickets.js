'use strict';
// Tickets: the customer-service queue, service deadlines and notes. Mixed into PolicyCenter's prototype at the end of
// src/policyCenter.js, so these methods run with `this` pointing at the service exactly as before.

const { AppError } = require('../appError');
const { round2 } = require('../rating');
const { str } = require('../text');
const { USERS } = require('../productModel');
const { salesScope } = require('../permissions');

// Ticket response deadlines in hours, and ticket stages.
const TICKET_HOURS = { Urgent: 4, High: 24, Normal: 48, Low: 120 };
const TICKET_CATEGORIES = ['Claim', 'Billing', 'Policy change', 'Other'];
const TICKET_TRANSITIONS = {
  Open: [],
  Assigned: ['In Progress'],
  'In Progress': ['Resolved'],
  Resolved: ['Closed', 'In Progress'],
  Closed: [],
};
const PREMIUM_THRESHOLD = 3000; // total current term premium (with tax) that makes a customer a premium customer

class Tickets {
  // ------------------------------------------------------------------ tickets
  // Customer and staff issues. Each ticket has a priority with a response deadline (SLA):
  //   Urgent 4 hours, High 1 day, Normal 2 days, Low 5 days (calendar hours from creation).
  // Customers who hold a premium policy (total current term premium of PREMIUM_THRESHOLD or more) go first
  // in the queue, then by priority, then by the earliest deadline.

  premiumCustomer(accountId) {
    const today = this.today();
    const total = this.db.policies
      .filter((p) => p.accountId === accountId && !p.cancellation)
      .reduce((sum, p) => {
        const term = this.termContaining(p, today);
        return term ? sum + term.latest.quote.premium + term.latest.quote.taxes : sum;
      }, 0);
    return round2(total) >= PREMIUM_THRESHOLD;
  }

  createTicket(input, user) {
    const account = this.account(str(input.accountId), user);
    const priority = input.priority || 'Normal';
    if (!TICKET_HOURS[priority]) throw new AppError(422, `Priority must be one of ${Object.keys(TICKET_HOURS).join(', ')}`);
    const subject = str(input.subject);
    if (subject.length < 3) throw new AppError(422, 'Give the ticket a short subject');
    const category = input.category || 'Other';
    if (!TICKET_CATEGORIES.includes(category)) throw new AppError(422, `Category must be one of ${TICKET_CATEGORIES.join(', ')}`);
    const policy = input.policyId ? this.policy(input.policyId, user) : null;
    const claim = input.claimId ? this.claim(input.claimId, user) : null;
    const createdMs = this.nowMs();
    const ticket = {
      id: this.store.id('tkt'),
      ticketNumber: this.store.number('TKT-', 7),
      accountId: account.id,
      policyId: policy ? policy.id : null,
      claimId: claim ? claim.id : null,
      category, subject, description: str(input.description), priority,
      status: 'Open', assignedTo: null,
      source: input.source || 'staff',
      createdBy: user.id, createdByName: user.name, createdAt: new Date(createdMs).toISOString(),
      slaDueAt: new Date(createdMs + TICKET_HOURS[priority] * 3600 * 1000).toISOString(),
      firstResponseAt: null, resolvedAt: null, closedAt: null,
      notes: [],
      history: [{ at: new Date(createdMs).toISOString(), by: user.id, action: 'Created', detail: `${priority} priority, ${category}` }],
    };
    this.db.tickets.push(ticket);
    this.publish('TicketOpened', { ticketNumber: ticket.ticketNumber, priority, category });
    return ticket;
  }

  ticket(id, user) {
    const t = this.db.tickets.find((x) => x.id === id || x.ticketNumber === id);
    if (!t) throw new AppError(404, 'Ticket not found');
    const account = this.db.accounts.find((a) => a.id === t.accountId);
    if (user && (!account || !this.canSee(user, account))) throw new AppError(404, 'Ticket not found');
    return t;
  }

  // SLA state: Met or Missed once resolved or closed; otherwise Responded, On time, or Breached.
  slaOf(t) {
    const due = Date.parse(t.slaDueAt);
    const hoursLeft = Math.round(((due - this.nowMs()) / 3600000) * 10) / 10;
    if (t.resolvedAt || t.closedAt) return { state: Date.parse(t.resolvedAt || t.closedAt) <= due ? 'Met' : 'Missed', hoursLeft: null };
    if (t.firstResponseAt) return { state: 'Responded', hoursLeft: null };
    return { state: hoursLeft < 0 ? 'Breached' : 'On time', hoursLeft };
  }

  ticketView(t, user) {
    const account = this.db.accounts.find((a) => a.id === t.accountId);
    const { notes, ...rest } = t;
    return {
      ...rest,
      customer: account ? this.accountName(account) : '',
      accountNumber: account ? account.accountNumber : null,
      premiumCustomer: this.premiumCustomer(t.accountId),
      assignedToName: t.assignedTo ? (USERS.find((u) => u.id === t.assignedTo) || { name: t.assignedTo }).name : null,
      sla: this.slaOf(t),
      nextStatuses: TICKET_TRANSITIONS[t.status] || [],
      notes: notes.map((n) => ({ ...n })),
    };
  }

  listTickets(user, { status } = {}) {
    return this.db.tickets
      .filter((t) => {
        const account = this.db.accounts.find((a) => a.id === t.accountId);
        return account && this.canSee(user, account);
      })
      .filter((t) => !status || (status === 'open' ? !['Resolved', 'Closed'].includes(t.status) : t.status === status))
      .map((t) => this.ticketView(t, user))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  // The staff queue: open tickets, premium customers first, then priority, then the earliest deadline.
  ticketQueue(user) {
    return this.listTickets(user, { status: 'open' })
      .sort((a, b) => (Number(b.premiumCustomer) - Number(a.premiumCustomer))
        || (TICKET_HOURS[a.priority] - TICKET_HOURS[b.priority])
        || a.slaDueAt.localeCompare(b.slaDueAt));
  }

  assignTicket(id, assigneeId, user) {
    this.requireAuthority(user, 1, 'assign tickets');
    const t = this.ticket(id, user);
    if (!['Open', 'Assigned'].includes(t.status)) throw new AppError(409, `A ${t.status} ticket cannot be assigned`);
    const assignee = USERS.find((u) => u.id === assigneeId && u.authority >= 1);
    if (!assignee) throw new AppError(422, 'Assign to an underwriter, insurance executive or manager');
    t.assignedTo = assignee.id;
    t.status = 'Assigned';
    t.history.push({ at: this.now(), by: user.id, action: 'Assigned', detail: assignee.name });
    return this.ticketView(t, user);
  }

  // Ticket stages: Open > Assigned > In Progress > Resolved > Closed (a resolved ticket can be reopened).
  moveTicket(id, { to }, user) {
    this.requireAuthority(user, 1, 'change ticket status');
    const t = this.ticket(id, user);
    const allowed = TICKET_TRANSITIONS[t.status] || [];
    if (!allowed.includes(to)) throw new AppError(409, `A ${t.status} ticket cannot move to ${to}. Allowed: ${allowed.join(', ') || 'none'}`);
    const at = this.now();
    if (to === 'In Progress' && !t.firstResponseAt) t.firstResponseAt = at;
    if (to === 'Resolved') t.resolvedAt = at;
    if (to === 'Closed') t.closedAt = at;
    if (to === 'In Progress') t.resolvedAt = null;
    t.history.push({ at, by: user.id, action: 'Status', detail: `${t.status} to ${to}` });
    t.status = to;
    return this.ticketView(t, user);
  }

  addTicketNote(id, { text, internal }, user) {
    const t = this.ticket(id, user);
    const body = str(text);
    if (!body) throw new AppError(422, 'Write a note before saving');
    const staff = salesScope(user) === 'all';
    const at = this.now();
    if (staff && !t.firstResponseAt) t.firstResponseAt = at;
    t.notes.push({ at, by: user.id, byName: user.name, text: body, internal: Boolean(internal && staff) });
    t.history.push({ at, by: user.id, action: 'Note', detail: staff ? 'staff note' : 'customer note' });
    return this.ticketView(t, user);
  }
}

module.exports = { Tickets };
