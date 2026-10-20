'use strict';
// The agent layer (docs/AGENTS.md), following PolicyCenter-Production-and-Agents-Plan.pdf.
//
//   - Each agent has its own staff account (role 'AI Agent') that cannot sign in, a MODE (off or suggest) and LIMITS, both kept as data
//     that a UW manager changes without a code change. 'off' is the kill switch.
//   - An agent only READS the books and writes SUGGESTIONS, each with its reasons. It never changes a policy, sends a message or cancels
//     anything. A person accepts or dismisses; accepting runs the action with the PERSON's authority, and the audit log records both.
//   - Today the agents are rule-based and deterministic. The model named for each is the one the plan recommends for a later,
//     language-model version (Haiku for routine work, Opus for judgment); the rules are what that version is tested against.
//   - Customer text is never read by an agent: they work from structured fields only, so there is nothing to inject instructions into.

const D = require('./dates');
const { AppError } = require('./policyCenter');
const { balanceOf } = require('./invoiceView');

const OPEN_JOB = ['Draft', 'Quoted'];

const AGENTS = {
  intake: { name: 'Intake agent', status: 'planned', model: 'claude-haiku-5-5', freedom: 'Acts alone', does: 'Reads applications from email, WhatsApp, web forms and PDFs; creates the customer account and a draft submission.', needs: 'Incoming email, WhatsApp and web-form channels and a document reader (OCR). None exist yet.' },
  'data-lookup': { name: 'Data lookup agent', status: 'planned', model: 'claude-haiku-5-5', freedom: 'Acts alone', does: 'Pulls VIN, driving record and property data to complete a submission.', needs: 'Contracts and integrations with data providers.' },
  quote: { name: 'Quote agent', status: 'planned', model: 'claude-haiku-5-5', freedom: 'Acts alone', does: 'Runs pricing and explains the price to the customer.', needs: 'The intake and data lookup agents, and a customer channel. The assistant already explains a price from its worksheet.' },
  'issue-policy': { name: 'Issue policy agent', status: 'planned', model: 'claude-haiku-5-5', freedom: 'Alone for clean cases', does: 'Binds the policy once payment and e-signature are complete.', needs: 'Online payments and e-signature (plan phase 2).' },
  'claims-intake': { name: 'Claims intake agent', status: 'planned', model: 'claude-opus-5-5', freedom: 'Opens and suggests; a person decides payment or denial', does: 'Collects claim details and photos, opens the claim, suggests the reserve, scores fraud risk.', needs: 'Photo and document upload with OCR, and fraud data. A person must decide every payment and denial.' },
  'customer-service': { name: 'Customer service agent', status: 'planned', model: 'claude-haiku-5-5', freedom: 'Acts alone', does: 'Answers on chat, voice and WhatsApp around the clock and opens tickets.', needs: 'A customer-facing channel and portal. It grows out of the current assistant, which is read-only and staff-facing.' },
  finance: { name: 'Finance agent', status: 'planned', model: 'claude-haiku-5-5', freedom: 'Draft only', does: 'Month-end settlement figures and reports.', needs: 'The accounting books to be in daily use. The reports already exist.' },

  renewal: {
    name: 'Renewal agent', status: 'built', model: 'claude-haiku-5-5', freedom: 'Suggests (alone, with flags, later)',
    does: 'Finds policies whose term ends soon and suggests starting their renewal.',
    limits: { maxDaysBeforeEnd: 90 },
    wakesOn: ['PolicyIssued', 'PolicyRenewed'],
    audience: { roles: ['Underwriter', 'UW Manager'] },
  },
  'keep-customers': {
    name: 'Keep-customers agent', status: 'built', model: 'claude-haiku-5-5', freedom: 'Suggests',
    does: 'Follows the lapsing and lapsed lists and suggests a message to each customer nobody has been in touch with lately.',
    limits: { minDaysBetweenContacts: 7, maxContacts: 3 },
    wakesOn: [],
    audience: { roles: ['Agent', 'Underwriter', 'UW Manager'], byPolicy: true },
  },
  billing: {
    name: 'Billing agent', status: 'built', model: 'claude-haiku-5-5', freedom: 'Suggests; a cancellation notice always needs a person',
    does: 'Suggests a payment reminder for a late invoice, and sends a long-overdue one to a person.',
    limits: { reminderAfterDays: 3, escalateAfterDays: 15 },
    wakesOn: ['PaymentMissed', 'PaymentReceived'],
    audience: { roles: ['Agent', 'Underwriter', 'UW Manager'], byPolicy: true },
  },
  underwriting: {
    name: 'Underwriting agent', status: 'built', model: 'claude-opus-5-5', freedom: 'Partly alone: recommends; a person approves',
    does: 'For a submission with underwriting issues, recommends approval when every issue is within its limits, otherwise refers it to a person with its reasons.',
    limits: { maxApprovalLevel: 1, maxPremium: 5000, maxAccidents: 1 },
    wakesOn: [],
    audience: { roles: ['Underwriter', 'UW Manager'] },
  },
  compliance: {
    name: 'Compliance check agent', status: 'built', model: 'claude-opus-5-5', freedom: 'Reports only',
    does: 'Spot-checks the other agents and the audit log and reports anything unusual: a protected trait in a reason, a broken audit chain, an agent whose suggestions are mostly dismissed.',
    limits: { minDecisions: 5, dismissalRate: 0.5 },
    wakesOn: [],
    audience: { roles: ['UW Manager'] },
  },
};

const MODES = ['off', 'suggest'];
const PROTECTED = /\b(religio\w*|caste|ethnic\w*|race|racial|gender|sex|national origin|disabilit\w*|marital|pregnan\w*|sexual orientation)\b/i;

const isBuilt = (id) => AGENTS[id] && AGENTS[id].status === 'built';
const money = (n) => `$${Number(n).toFixed(2)}`;

class AgentService {
  constructor(pc, { audit }) {
    this.pc = pc;
    this.audit = audit;
  }

  get db() {
    return this.pc.db;
  }

  // ------------------------------------------------------------------ accounts, mode, limits

  // Every built agent has a staff account. It has no password, so nobody can sign in as an agent.
  ensureAccounts() {
    for (const [id, def] of Object.entries(AGENTS)) {
      if (def.status !== 'built' || this.pc.staffById(`ai-${id}`)) continue;
      this.db.staff.push({ id: `ai-${id}`, username: `ai-${id}`, name: def.name, role: 'AI Agent', authority: 0, producerCode: null, reportsTo: null, active: true, kind: 'agent', createdAt: this.pc.now() });
    }
  }

  account(id) {
    this.ensureAccounts();
    return this.pc.staffById(`ai-${id}`);
  }

  config(id) {
    const stored = (this.db.agentConfig || {})[id] || {};
    const def = AGENTS[id];
    return { mode: stored.mode || 'off', limits: { ...(def.limits || {}), ...(stored.limits || {}) }, updatedBy: stored.updatedBy || null, updatedAt: stored.updatedAt || null };
  }

  save(id, patch, user) {
    if (!this.db.agentConfig) this.db.agentConfig = {};
    const stored = this.db.agentConfig[id] || {};
    this.db.agentConfig[id] = { ...stored, ...patch, updatedBy: user.id, updatedAt: this.pc.now() };
  }

  requireAgent(id) {
    const def = AGENTS[id];
    if (!def) throw new AppError(404, 'Agent not found');
    return def;
  }

  list(user) {
    this.pc.requireManager(user, 'see the agents');
    this.ensureAccounts();
    const open = (this.db.agentSuggestions || []).filter((s) => s.status === 'Open');
    return Object.entries(AGENTS).map(([id, def]) => ({
      id, name: def.name, status: def.status, model: def.model, freedom: def.freedom, does: def.does, needs: def.needs || null,
      ...(def.status === 'built' ? { ...this.config(id), openSuggestions: open.filter((s) => s.agentId === id).length, account: `ai-${id}` } : {}),
    }));
  }

  setMode(id, mode, user) {
    this.pc.requireManager(user, 'switch an agent on or off');
    const def = this.requireAgent(id);
    if (def.status !== 'built') throw new AppError(422, `${def.name} is planned, not built yet: ${def.needs}`);
    if (mode === 'act') throw new AppError(422, 'Agents that act on their own are not available yet. Run the backtest and the suggest-only period first (docs/AGENTS.md).');
    if (!MODES.includes(mode)) throw new AppError(422, `Mode must be one of ${MODES.join(', ')}`);
    const previous = this.config(id).mode;
    this.save(id, { mode }, user);
    this.audit.record({ actor: user, action: 'agent.mode', subject: id, reasons: [`${def.name}: ${previous} to ${mode}`] });
    return { id, ...this.config(id) };
  }

  setLimits(id, limits, user) {
    this.pc.requireManager(user, 'change an agent\'s limits');
    const def = this.requireAgent(id);
    if (def.status !== 'built') throw new AppError(422, `${def.name} is planned, not built yet`);
    const next = { ...this.config(id).limits };
    for (const [key, value] of Object.entries(limits || {})) {
      if (!(key in (def.limits || {}))) throw new AppError(422, `${def.name} has no limit called ${key}. Its limits are ${Object.keys(def.limits).join(', ')}`);
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new AppError(422, `${key} must be a number, zero or more`);
      if (key === 'maxApprovalLevel' && value > 1) throw new AppError(422, 'The underwriting agent can be allowed to recommend at level 1 (an underwriter) at most; a manager\'s approval is always a person\'s');
      next[key] = value;
    }
    this.save(id, { limits: next }, user);
    this.audit.record({ actor: user, action: 'agent.limits', subject: id, reasons: [`${def.name}: ${Object.entries(limits).map(([k, v]) => `${k} = ${v}`).join(', ')}`], data: { limits: next } });
    return { id, ...this.config(id) };
  }

  // ------------------------------------------------------------------ running

  // Runs the built agents that are not off, over everything (a daily sweep) or the given policies. Returns one result per agent.
  run(user, opts = {}) {
    this.pc.requireManager(user, 'run the agents');
    return this.runAgents(opts);
  }

  runAgents({ agentIds, policyNumbers = null } = {}) {
    const ids = (agentIds || Object.keys(AGENTS).filter(isBuilt));
    return ids.map((id) => {
      const def = this.requireAgent(id);
      if (!isBuilt(id)) throw new AppError(422, `${def.name} is planned, not built yet`);
      const cfg = this.config(id);
      if (cfg.mode === 'off') return { agentId: id, skipped: 'off' };
      const agentUser = this.account(id);
      const ctx = { today: this.pc.today(), limits: cfg.limits, policyNumbers: policyNumbers ? new Set(policyNumbers) : null, user: agentUser };
      const proposals = this[`evaluate_${id.replace(/-/g, '_')}`](ctx);
      let created = 0;
      for (const p of proposals) {
        if (this.db.agentSuggestions.some((s) => s.dedupeKey === p.dedupeKey)) continue;
        if (p.supersedes) for (const s of this.db.agentSuggestions) if (s.status === 'Open' && s.dedupeKey === p.supersedes) s.status = 'Superseded';
        const suggestion = {
          id: this.pc.store.id('sug'), number: this.pc.store.number('SUG-', 7), agentId: id, kind: p.kind, status: 'Open',
          summary: p.summary, reasons: p.reasons, proposed: p.proposed || null, subject: p.subject || {}, dedupeKey: p.dedupeKey, createdAt: this.pc.now(),
          audience: this.audienceFor(id, p),
        };
        this.db.agentSuggestions.push(suggestion);
        this.audit.record({ actor: agentUser, action: 'suggestion.created', subject: suggestion.number, reasons: suggestion.reasons, data: { agent: id, kind: p.kind, summary: p.summary } });
        created++;
      }
      this.audit.record({ actor: agentUser, action: 'agent.run', subject: id, reasons: [`Looked at the books and made ${created} new suggestion${created === 1 ? '' : 's'}`] });
      return { agentId: id, created };
    });
  }

  // An event wakes only the agents that listen for it, and only for the policy in it.
  onEvent(event) {
    const policyNumber = event.payload && event.payload.policyNumber;
    const ids = Object.keys(AGENTS).filter((id) => isBuilt(id) && AGENTS[id].wakesOn.includes(event.type));
    if (!ids.length) return [];
    return this.runAgents({ agentIds: ids, policyNumbers: policyNumber ? [policyNumber] : null });
  }

  // ------------------------------------------------------------------ the agents

  inScope(ctx, policy) {
    return !ctx.policyNumbers || ctx.policyNumbers.has(policy.policyNumber);
  }

  evaluate_renewal(ctx) {
    const out = [];
    for (const p of this.db.policies) {
      if (p.cancellation || !this.inScope(ctx, p)) continue;
      const last = this.pc.lastTerm(p);
      const days = D.daysBetween(ctx.today, last.expirationDate);
      if (days < 0 || days > ctx.limits.maxDaysBeforeEnd) continue;
      if (this.db.jobs.some((j) => j.policyId === p.id && OPEN_JOB.includes(j.status))) continue;
      const account = this.db.accounts.find((a) => a.id === p.accountId);
      out.push({
        dedupeKey: `renewal:${p.id}:${last.termNumber}`, kind: 'start_renewal',
        summary: `Start the renewal of ${p.policyNumber}${account ? ` (${this.pc.accountName(account)})` : ''}: the term ends ${last.expirationDate}`,
        reasons: [`The term ends on ${last.expirationDate}, in ${days} days (this agent looks ${ctx.limits.maxDaysBeforeEnd} days ahead)`, 'No quote, submission or renewal is open on the policy'],
        proposed: { action: 'start_renewal', params: { policyId: p.id } }, subject: { policyId: p.id, policyNumber: p.policyNumber, accountId: p.accountId },
      });
    }
    return out;
  }

  evaluate_keep_customers(ctx) {
    const out = [];
    for (const row of this.pc.lapsePolicies(ctx.user)) {
      if (ctx.policyNumbers && !ctx.policyNumbers.has(row.policyNumber)) continue;
      if (row.followUpCount >= ctx.limits.maxContacts) continue;
      if (row.lastFollowUp && D.daysBetween(row.lastFollowUp.date, ctx.today) < ctx.limits.minDaysBetweenContacts) continue;
      const account = this.db.accounts.find((a) => a.id === row.accountId);
      const lapsed = row.status === 'Lapsed';
      const channel = account && account.email ? 'email' : (account && account.phone ? 'whatsapp' : null);
      const reasons = [lapsed ? `The policy lapsed ${-row.daysToExpiry} days ago (ended ${row.expirationDate}) and has not been renewed` : `The policy ends in ${row.daysToExpiry} days (${row.expirationDate})`, row.lastFollowUp ? `The last contact was ${row.lastFollowUp.date} (${row.lastFollowUp.channel}: ${row.lastFollowUp.result})` : 'Nobody has been in touch yet'];
      out.push({
        dedupeKey: `keep:${row.policyId}:${row.status}:${row.expirationDate}:${row.followUpCount}`, kind: channel ? 'contact' : 'no_contact_details',
        summary: channel ? `Send ${row.insured} a ${lapsed ? 'lapse' : 'renewal'} message about ${row.policyNumber}` : `${row.insured} has no email or phone on file: ${row.policyNumber} needs a contact detail first`,
        reasons: channel ? reasons : [...reasons, 'There is no email address or phone number to use'],
        proposed: channel ? { action: 'send_message', params: { accountId: row.accountId, policyId: row.policyId, template: lapsed ? 'lapse' : 'renewal', channel, language: 'en' } } : null,
        subject: { policyId: row.policyId, policyNumber: row.policyNumber, accountId: row.accountId },
      });
    }
    return out;
  }

  evaluate_billing(ctx) {
    const out = [];
    for (const p of this.db.policies) {
      if (p.cancellation || !this.inScope(ctx, p)) continue;
      const overdue = this.db.invoices.filter((i) => i.policyId === p.id && i.amount >= 0 && balanceOf(i) > 0 && i.dueDate < ctx.today).sort((a, b) => a.dueDate.localeCompare(b.dueDate));
      const oldest = overdue[0];
      if (!oldest) continue;
      const days = D.daysBetween(oldest.dueDate, ctx.today);
      const subject = { policyId: p.id, policyNumber: p.policyNumber, accountId: p.accountId, invoiceNumber: oldest.invoiceNumber };
      const owed = `${money(balanceOf(oldest))} on invoice ${oldest.invoiceNumber}, due ${oldest.dueDate}`;
      if (days >= ctx.limits.escalateAfterDays) {
        out.push({
          dedupeKey: `billing:escalate:${oldest.id}`, supersedes: `billing:reminder:${oldest.id}`, kind: 'escalate',
          summary: `${p.policyNumber} is ${days} days overdue: a cancellation notice needs a person's decision`,
          reasons: [`${owed}; ${days} days late (this agent hands over at ${ctx.limits.escalateAfterDays})`, 'A notice of cancellation for non-payment is never sent without a person deciding'],
          proposed: null, subject,
        });
      } else if (days >= ctx.limits.reminderAfterDays) {
        out.push({
          dedupeKey: `billing:reminder:${oldest.id}`, kind: 'reminder',
          summary: `Remind the customer to pay ${owed}`,
          reasons: [`${days} days late (this agent reminds from ${ctx.limits.reminderAfterDays} days)`, `Balance ${money(balanceOf(oldest))}`],
          proposed: { action: 'contact_customer', params: { accountId: p.accountId, policyId: p.id, reason: 'payment_reminder', invoiceNumber: oldest.invoiceNumber, balance: balanceOf(oldest), dueDate: oldest.dueDate } }, subject,
        });
      }
    }
    return out;
  }

  // What the underwriting agent would say about a set of issues on a job. Used live (the issues still waiting) and in the backtest.
  assess(issues, job, limits) {
    const reasons = [];
    const stoppers = [];
    for (const i of issues) {
      if (!i.approvable) stoppers.push(`${i.name}: it cannot be approved, the risk must change or the submission be declined`);
      else if (i.approvalLevel > limits.maxApprovalLevel) stoppers.push(`${i.name}: it needs a ${i.requiredRole}, above what this agent may recommend`);
      else reasons.push(`${i.name}: ${i.description} (level ${i.approvalLevel}, within the agent's level ${limits.maxApprovalLevel})`);
    }
    const premium = job.quote ? job.quote.premium : 0;
    if (premium > limits.maxPremium) stoppers.push(`The premium ${money(premium)} is over this agent's limit of ${money(limits.maxPremium)}`);
    else reasons.push(`The premium ${money(premium)} is within this agent's limit of ${money(limits.maxPremium)}`);
    const accidents = ((job.period && job.period.line && job.period.line.drivers) || []).reduce((n, d) => n + (Number(d.accidents) || 0), 0);
    if (accidents > limits.maxAccidents) stoppers.push(`${accidents} at-fault accidents across the drivers is over this agent's limit of ${limits.maxAccidents}`);
    return stoppers.length ? { decision: 'refer', reasons: stoppers } : { decision: 'approve', reasons };
  }

  evaluate_underwriting(ctx) {
    const out = [];
    for (const job of this.db.jobs) {
      if (!OPEN_JOB.includes(job.status)) continue;
      const policy = this.db.policies.find((p) => p.id === job.policyId);
      if (ctx.policyNumbers && !(policy && ctx.policyNumbers.has(policy.policyNumber))) continue;
      const pending = (job.uwIssues || []).filter((i) => !i.approved);
      if (!pending.length) continue;
      const a = this.assess(pending, job, ctx.limits);
      const keys = pending.map((i) => i.key).sort();
      const premium = job.quote ? job.quote.premium : 0;
      const subject = { jobId: job.id, jobNumber: job.jobNumber, accountId: job.accountId, policyId: job.policyId || null };
      out.push(a.decision === 'approve'
        ? { dedupeKey: `uw:${job.id}:${keys.join(',')}:${premium}:approve`, kind: 'recommend_approval', summary: `Approve ${pending.length} underwriting issue${pending.length === 1 ? '' : 's'} on ${job.jobNumber}`, reasons: a.reasons, proposed: { action: 'approve_uw_issue', params: { jobId: job.id, keys, note: 'Recommended by the underwriting agent' } }, subject }
        : { dedupeKey: `uw:${job.id}:${keys.join(',')}:${premium}:refer`, kind: 'refer', summary: `${job.jobNumber} needs a person: it is outside the underwriting agent's limits`, reasons: [...a.reasons, 'Refer to an underwriter or the UW manager with these reasons'], proposed: null, subject });
    }
    return out;
  }

  evaluate_compliance(ctx) {
    const out = [];
    for (const s of this.db.agentSuggestions) {
      if (s.agentId === 'compliance') continue;
      const hit = [s.summary, ...(s.reasons || [])].find((t) => PROTECTED.test(String(t)));
      if (hit) out.push({ dedupeKey: `compliance:protected:${s.id}`, kind: 'finding', summary: `Suggestion ${s.number} (${AGENTS[s.agentId] ? AGENTS[s.agentId].name : s.agentId}) mentions a protected trait`, reasons: [`The text "${hit}" names a trait (such as religion, caste, gender) that must never be used to price or decide`, 'Look at how the agent produced it, and switch the agent off if it keeps happening'], proposed: null, subject: { suggestion: s.number } });
    }
    const chain = this.audit.verify();
    if (!chain.ok) out.push({ dedupeKey: `compliance:audit:${chain.brokenAt}`, kind: 'finding', summary: `The audit log was changed: the chain is broken at entry ${chain.brokenAt}`, reasons: ['Each audit entry holds the hash of the one before it, and entry ' + chain.brokenAt + ' does not match', 'Restore the log from a backup and find out who changed it'], proposed: null, subject: { auditEntry: chain.brokenAt } });
    for (const id of Object.keys(AGENTS).filter((x) => isBuilt(x) && x !== 'compliance')) {
      const decided = this.db.agentSuggestions.filter((s) => s.agentId === id && ['Accepted', 'Dismissed'].includes(s.status));
      const dismissed = decided.filter((s) => s.status === 'Dismissed').length;
      if (decided.length >= ctx.limits.minDecisions && dismissed / decided.length > ctx.limits.dismissalRate) {
        out.push({ dedupeKey: `compliance:dismissed:${id}:${decided.length}`, kind: 'finding', summary: `${AGENTS[id].name}: ${dismissed} of ${decided.length} suggestions were dismissed`, reasons: ['People mostly reject what this agent suggests, so its limits or rules probably need review before it is given more freedom'], proposed: null, subject: { agent: id } });
      }
    }
    return out;
  }

  // ------------------------------------------------------------------ the queue and people's decisions

  requireReviewer(user, what) {
    if (!user || !['Underwriter', 'UW Manager'].includes(user.role)) throw new AppError(403, `Only underwriters and the UW manager can ${what}`);
  }

  // Who a suggestion is for. Internal underwriting work goes to the underwriting team; customer-facing work belongs to
  // the producer who owns the account, and to staff who see the whole book. Stored on the suggestion, so a later rule
  // change does not move work that is already waiting for someone.
  audienceFor(id, proposal) {
    const spec = (AGENTS[id] && AGENTS[id].audience) || { roles: ['UW Manager'] };
    const audience = { roles: [...spec.roles], producerCode: null };
    if (spec.byPolicy && proposal && proposal.subject) {
      const account = this.pc.db.accounts.find((a) => a.id === proposal.subject.accountId);
      if (account) audience.producerCode = account.producerCode || null;
    }
    return audience;
  }

  visibleTo(user, suggestion) {
    const audience = suggestion.audience || { roles: ['UW Manager'], producerCode: null }; // suggestions from before this existed
    if (!user || !audience.roles.includes(user.role)) return false;
    if (audience.producerCode && user.role === 'Agent') return audience.producerCode === user.producerCode;
    return true;
  }

  // The open suggestions addressed to this person: what the Desktop and the Work queues show. The decision stays theirs.
  suggestionsFor(user) {
    const items = this.db.agentSuggestions
      .filter((s) => s.status === 'Open' && this.visibleTo(user, s))
      .reverse()
      .map((s) => ({
        id: s.id,
        number: s.number,
        agentId: s.agentId,
        agent: (AGENTS[s.agentId] || {}).name || s.agentId,
        kind: s.kind,
        summary: s.summary,
        reasons: s.reasons || [],
        subject: s.subject || {},
        createdAt: s.createdAt,
      }));
    const counts = new Map();
    for (const s of items) counts.set(s.agentId, (counts.get(s.agentId) || 0) + 1);
    const byAgent = [...counts].map(([agentId, count]) => ({ agentId, name: (AGENTS[agentId] || {}).name || agentId, count }));
    return { count: items.length, byAgent, items };
  }

  suggestions(user, { status, agentId } = {}) {
    this.requireReviewer(user, 'see agent suggestions');
    return [...this.db.agentSuggestions].reverse().filter((s) => (!status || s.status === status) && (!agentId || s.agentId === agentId));
  }

  decide(id, { decision, note } = {}, user) {
    this.requireReviewer(user, 'decide on agent suggestions');
    const s = this.db.agentSuggestions.find((x) => x.id === id || x.number === id);
    if (!s) throw new AppError(404, 'Suggestion not found');
    if (!['accept', 'dismiss'].includes(decision)) throw new AppError(422, 'Decision must be accept or dismiss');
    if (s.status !== 'Open') throw new AppError(409, `This suggestion was already ${s.status.toLowerCase()}`);
    let outcome = null;
    if (decision === 'accept') {
      if (!s.proposed) throw new AppError(422, 'This suggestion has no action to run: dismiss it once you have dealt with it');
      outcome = this.execute(s.proposed, user);
    }
    Object.assign(s, { status: decision === 'accept' ? 'Accepted' : 'Dismissed', decidedBy: user.id, decidedByName: user.name, decidedAt: this.pc.now(), decisionNote: String(note || '').trim() });
    this.audit.record({ actor: user, action: decision === 'accept' ? 'suggestion.accepted' : 'suggestion.dismissed', subject: s.number, reasons: s.reasons, data: { agent: s.agentId, note: s.decisionNote, outcome } });
    return s;
  }

  // Runs what an accepted suggestion proposes, as the person. Their authority applies, so an underwriter still cannot approve what needs a manager.
  execute(proposed, user) {
    const { action, params } = proposed;
    if (action === 'start_renewal') {
      const job = this.pc.startRenewal(params.policyId, user);
      return { started: job.jobNumber };
    }
    if (action === 'approve_uw_issue') {
      for (const key of params.keys) this.pc.approveIssue(params.jobId, key, params.note, user);
      return { approved: params.keys };
    }
    // Messages and calls to customers are made by the person (the Email and WhatsApp buttons), who then logs the follow-up.
    return { next: 'The person contacts the customer and logs the follow-up', action };
  }

  // ------------------------------------------------------------------ testing before trust

  // Replays the underwriting agent over past cases and compares it with what people did. Plan, safety rule 4.
  backtest(id, user) {
    this.pc.requireManager(user, 'run a backtest');
    if (id !== 'underwriting') throw new AppError(422, 'Only the underwriting agent can be backtested so far: it is the one that judges past decisions');
    const limits = this.config('underwriting').limits;
    const cases = [];
    for (const job of this.db.jobs) {
      const approvals = job.uwApprovals || {};
      const issues = (job.uwIssues || []).filter((i) => approvals[i.key] || (job.status === 'Declined' && !i.approved));
      if (!issues.length) continue;
      const agent = this.assess(issues, job, limits);
      const approvers = issues.map((i) => approvals[i.key]).filter(Boolean).map((a) => this.pc.staffById(a.by)).filter(Boolean);
      const person = job.status === 'Declined' ? 'declined' : 'approved';
      const needed = approvers.some((a) => a.authority > limits.maxApprovalLevel);
      let result;
      if (person === 'declined') result = agent.decision === 'refer' ? 'agree' : 'overreach';
      else if (agent.decision === 'approve') result = 'agree';
      else result = needed ? 'agree' : 'too_cautious';
      cases.push({ job: job.jobNumber, person, agent: agent.decision, result });
    }
    const count = (r) => cases.filter((c) => c.result === r).length;
    return { agent: id, limits, cases: cases.length, agree: count('agree'), tooCautious: count('too_cautious'), overreach: count('overreach'), agreementRate: cases.length ? count('agree') / cases.length : null, detail: cases };
  }
}

module.exports = { AgentService, AGENTS, MODES };
