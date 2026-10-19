'use strict';
// REST API (the simulator's equivalent of PolicyCenter Cloud API). The caller is identified by
// the X-User header; every mutating call runs as one unit of work against the store.

const crypto = require('node:crypto');
const { stripDangerousKeys } = require('./security');
const { writeBackup, listBackups } = require('./backup');
const { DataProtection } = require('./dataProtection');
const { AuditLog } = require('./audit');
const { AgentService } = require('./agents');
const { PRODUCTS, STATES, USERS, PRODUCER_CODES } = require('./productModel');
const { RATE_BOOKS } = require('./rateBooks');
const { AppError, CANCEL_REASONS, CLAIM_TYPES } = require('./policyCenter');
const { Finance } = require('./finance');
const { Insights } = require('./insights');
const { Billing } = require('./billing');
const { Reports } = require('./reports');
const { Documents } = require('./documents');
const { Accounting } = require('./accounting');
const { ClaimMoney, RESERVE_LIMITS, PAYMENT_LIMITS, COST_TYPES, CLAIMANT_KINDS } = require('./claimMoney');

const hash = (v) => crypto.createHash('sha256').update(typeof v === 'string' ? v : JSON.stringify(v)).digest('hex');

// Remembered answers to POSTs sent with an Idempotency-Key are kept this long.
const IDEMPOTENCY_HOURS = 48;

// The ETag of an account or a job: a hash of the record as it is now, so it changes whenever the record does.
function etagFor(pc, sub) {
  const m = /^\/(accounts|jobs)\/([^/]+)/.exec(sub);
  if (!m) return null;
  const record = (m[1] === 'accounts' ? pc.db.accounts : pc.db.jobs).find((x) => x.id === m[2] || x.accountNumber === m[2] || x.jobNumber === m[2]);
  return record ? `"${hash(record).slice(0, 32)}"` : null;
}

function createApi(pc, store, { reseed, chatbot, speech, messaging, auth, bus, backupDir, audit: auditOption, agents: agentsOption } = {}) {
  const routes = [];
  const finance = new Finance(pc);
  const insights = new Insights(pc, finance);
  const billing = new Billing(pc);
  const claimMoney = new ClaimMoney(pc);
  const reports = new Reports(pc, billing);
  const documents = new Documents(pc, messaging);
  const accounting = new Accounting(pc);
  const dataProtection = new DataProtection(pc);
  const audit = auditOption || new AuditLog(pc);
  const agents = agentsOption || new AgentService(pc, { audit });
  // The consumers run right after the response has gone, never inside the request: a person who saves something does not wait
  // for the queues to be filled. Several writes in a row ask once.
  let busAsked = false;
  const runBusSoon = () => {
    if (!bus || busAsked) return;
    busAsked = true;
    setImmediate(() => {
      busAsked = false;
      try { bus.run(); } catch (err) { console.error('The event consumers failed:', err); }
    });
  };
  // readOnly routes run outside the store's unit of work (the chatbot only reads data).
  // raw routes receive the request body as bytes (audio) instead of JSON.
  // public routes need no sign-in (login and the sign-in check). Everything else needs a valid session.
  const route = (method, pattern, handler, { readOnly = method === 'GET', stream = false, raw = false, isPublic = false } = {}) => {
    const re = new RegExp(`^${pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`);
    routes.push({ method, pattern, re, handler, readOnly, stream, raw, isPublic });
  };

  // Setup: until the first account has a password, the app asks the first person to choose one.
  // Is the server up? No sign-in, nothing private: for a load balancer or a container health check.
  route('GET', '/health', () => ({ ok: true, uptimeSeconds: Math.round(process.uptime()) }), { isPublic: true });
  // How the server is doing (UW managers): memory, how many records, what saving the data costs.
  route('GET', '/admin/metrics', ({ user }) => {
    pc.requireAuthority(user, 2, 'see server metrics');
    const mb = (n) => Math.round((n / 1048576) * 10) / 10;
    const mem = process.memoryUsage();
    const d = pc.db;
    const s = store.stats;
    return {
      uptimeSeconds: Math.round(process.uptime()), rssMb: mb(mem.rss), heapUsedMb: mb(mem.heapUsed),
      records: { accounts: d.accounts.length, policies: d.policies.length, jobs: d.jobs.length, invoices: d.invoices.length, claims: d.claims.length, events: d.events.length, ledgerEntries: d.ledger.length },
      store: { saves: s.saves, lastSaveMs: Math.round(s.lastSaveMs * 10) / 10, maxSaveMs: Math.round(s.maxSaveMs * 10) / 10, averageSaveMs: s.saves ? Math.round((s.totalSaveMs / s.saves) * 10) / 10 : 0, fileMb: mb(s.lastSaveBytes) },
    };
  });
  // Backups (UW managers): a checked copy of all the data, taken now. Restoring is done with the server stopped (scripts/restore.js).
  route('POST', '/admin/backup', ({ user }) => {
    pc.requireAuthority(user, 2, 'take a backup');
    if (!backupDir) throw new AppError(503, 'Backups are not set up on this server');
    const { file, ...made } = writeBackup(JSON.stringify(store.data), backupDir);
    return made;
  }, { readOnly: true });
  route('GET', '/admin/backups', ({ user }) => {
    pc.requireAuthority(user, 2, 'see backups');
    return backupDir ? listBackups(backupDir) : [];
  });
  // Personal data (UW managers): a copy of what is held about an account, erasure of the identity, and the log of such requests.
  route('GET', '/accounts/:id/personal-data', ({ user, params }) => dataProtection.export(params.id, user));
  route('POST', '/accounts/:id/erase', ({ user, params, body }) => dataProtection.erase(params.id, body, user));
  route('GET', '/admin/data-requests', ({ user }) => dataProtection.requests(user));
  // The audit log (UW managers): who or which agent did what, and why. Entries are chained, so a change is found by /audit/verify.
  route('GET', '/audit', ({ user, query }) => audit.list(user, { limit: query.get('limit') || undefined, action: query.get('action') || undefined, actor: query.get('actor') || undefined }));
  route('GET', '/audit/verify', ({ user }) => { pc.requireManager(user, 'verify the audit log'); return audit.verify(); });
  // AI agents (docs/AGENTS.md). They only write suggestions; people decide. The UW manager switches them on and off and sets their limits.
  route('GET', '/agents', ({ user }) => agents.list(user));
  route('POST', '/agents/run', ({ user, body }) => agents.run(user, { agentIds: Array.isArray(body.agentIds) ? body.agentIds : undefined }));
  route('GET', '/agents/suggestions', ({ user, query }) => agents.suggestions(user, { status: query.get('status') || undefined, agentId: query.get('agent') || undefined }));
  route('POST', '/agents/suggestions/:id/decision', ({ user, params, body }) => agents.decide(params.id, body, user));
  route('POST', '/agents/:id/mode', ({ user, params, body }) => agents.setMode(params.id, body.mode, user));
  route('POST', '/agents/:id/limits', ({ user, params, body }) => agents.setLimits(params.id, body.limits, user));
  route('GET', '/agents/:id/backtest', ({ user, params }) => agents.backtest(params.id, user));
  route('GET', '/auth/status', () => ({ setupNeeded: pc.setupNeeded() }), { isPublic: true });
  route('POST', '/auth/setup', (ctx) => {
    const view = pc.setupFirstManager({ username: ctx.body.username, password: ctx.body.password });
    const { token } = auth.login(view.username, ctx.body.password);
    ctx.setCookie = `pc_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`;
    return { user: view, mustChangePassword: false };
  }, { isPublic: true });
  // Sign-in
  route('POST', '/auth/login', (ctx) => {
    const { token, ...rest } = auth.login(ctx.body.username, ctx.body.password);
    ctx.setCookie = `pc_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`;
    return rest;
  }, { isPublic: true });
  route('POST', '/auth/logout', (ctx) => {
    if (ctx.token) auth.logout(ctx.token);
    ctx.setCookie = 'pc_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0';
    return { ok: true };
  }, { isPublic: true });
  route('GET', '/auth/me', ({ user, token }) => ({ user: pc.userView(user), mustChangePassword: Boolean(user.mustChangePassword) }), { isPublic: true });
  route('POST', '/auth/password', ({ user, body }) => pc.changeOwnPassword(user, { current: body.current, next: body.next }), { isPublic: true });
  // Staff accounts: the UW Manager creates and resets them.
  route('GET', '/staff', ({ user }) => pc.listStaff(user));
  route('POST', '/staff', ({ user, body }) => pc.createStaff(body, user));
  route('POST', '/staff/:id/reset', ({ user, params }) => { const r = pc.resetStaffPassword(params.id, user); auth.endSessionsFor(params.id); return r; });
  route('POST', '/staff/:id/active', ({ user, params, body }) => { const r = pc.setStaffActive(params.id, body.active, user); if (!body.active) auth.endSessionsFor(params.id); return r; });

  route('GET', '/meta', () => ({
    today: pc.today(),
    states: STATES,
    users: pc.db.staff.map((x) => pc.userView(x)),
    producerCodes: PRODUCER_CODES,
    products: PRODUCTS,
    cancelReasons: CANCEL_REASONS,
    claimTypes: CLAIM_TYPES,
    claimLimits: { reserve: RESERVE_LIMITS, payment: PAYMENT_LIMITS, costTypes: COST_TYPES, claimantKinds: CLAIMANT_KINDS },
  }));
  route('GET', '/desktop', ({ user }) => pc.desktop(user));
  route('GET', '/search', ({ user, query }) => pc.search(query.get('q') || '', user));

  route('GET', '/accounts', ({ user, query }) => pc.listAccounts(query.get('q'), user));
  route('POST', '/accounts', ({ user, body }) => pc.createAccount(body, user));
  route('GET', '/accounts/:id', ({ user, params }) => pc.accountDetail(params.id, user));
  route('PUT', '/accounts/:id', ({ user, params, body }) => pc.updateAccount(params.id, body, user));

  route('GET', '/jobs', ({ user, query }) => pc.listJobs(user, { status: query.get('status') }));
  route('POST', '/jobs/submission', ({ user, body }) => pc.jobDetail(pc.startSubmission(body, user).id, user));
  route('GET', '/jobs/:id', ({ user, params }) => pc.jobDetail(params.id, user));
  route('PUT', '/jobs/:id/period', ({ user, params, body }) => pc.jobDetail(pc.updateDraft(params.id, body, user).id, user));
  route('POST', '/jobs/:id/quote', ({ user, params }) => pc.jobDetail(pc.quote(params.id, user).id, user));
  route('POST', '/jobs/:id/bind', ({ user, params }) => pc.jobDetail(pc.bind(params.id, user).id, user));
  route('POST', '/jobs/:id/withdraw', ({ user, params }) => pc.jobDetail(pc.withdraw(params.id, user).id, user));
  route('POST', '/jobs/:id/decline', ({ user, params, body }) => pc.jobDetail(pc.decline(params.id, body.reason, user).id, user));
  route('POST', '/jobs/:id/uw-issues/:key/approve', ({ user, params, body }) =>
    pc.jobDetail(pc.approveIssue(params.id, decodeURIComponent(params.key), body.note, user).id, user));

  route('GET', '/policies', ({ user, query }) => pc.listPolicies(query.get('q'), user));
  route('GET', '/claims', ({ user, query }) => pc.listClaims(user, { status: query.get('status') || undefined }));
  route('GET', '/claims/:id', ({ user, params }) => pc.claimDetail(params.id, user));
  route('GET', '/policies/:id', ({ user, params }) => pc.policyDetail(params.id, user));
  route('POST', '/policies/:id/claims', ({ user, params, body }) => pc.claimDetail(pc.openClaim(params.id, body, user).id, user));
  route('POST', '/policies/:id/change', ({ user, params, body }) => pc.jobDetail(pc.startPolicyChange(params.id, body, user).id, user));
  route('POST', '/policies/:id/cancel', ({ user, params, body }) => pc.jobDetail(pc.startCancellation(params.id, body, user).id, user));
  route('POST', '/policies/:id/reinstate', ({ user, params }) => pc.jobDetail(pc.startReinstatement(params.id, user).id, user));
  route('POST', '/policies/:id/renew', ({ user, params }) => pc.jobDetail(pc.startRenewal(params.id, user).id, user));

  // Payments and missed payments (UW managers). A payment is applied to the oldest invoice first.
  // Premium audit: start the audit of a term that has ended, record the actual figures, then quote and bind the job as usual.
  route('POST', '/policies/:id/audit', ({ user, params, body }) => pc.jobDetail(pc.startPremiumAudit(params.id, body, user).id, user));
  route('POST', '/jobs/:id/audit-actuals', ({ user, params, body }) => pc.jobDetail(pc.recordAuditActuals(params.id, body.actuals, user).id, user));
  route('POST', '/policies/:id/rewrite', ({ user, params, body }) => pc.jobDetail(pc.startRewrite(params.id, body, user).id, user));
  route('GET', '/policies/:id/billing', ({ user, params }) => ({ invoices: billing.invoicesFor(params.id, user), payments: billing.paymentsFor(params.id, user), credit: billing.creditFor(params.id, user) }));
  route('POST', '/policies/:id/payments', ({ user, params, body }) => billing.receivePayment(user, { ...body, policyId: params.id }));
  route('GET', '/policies/:id/ledger', ({ user, params }) => billing.ledgerFor(params.id, user));
  route('POST', '/policies/:id/refunds/:refundId/issue', ({ user, params, body }) => {
    const refund = billing.refundsFor(params.id, user).find((r) => r.id === params.refundId);
    if (!refund) throw new AppError(404, 'Refund not found on this policy');
    return billing.issueRefund(user, params.refundId, body);
  });
  route('POST', '/billing/delinquency', ({ user, body }) => billing.runDelinquency(user, { asOf: body.asOf }));

  // Event consumers (UW managers): run them now, see the events they gave up on, and redrive one after the cause is fixed.
  route('GET', '/admin/events/dead', ({ user }) => { pc.requireAuthority(user, 2, 'see dead events'); return bus ? bus.deadEvents() : []; });
  route('POST', '/admin/events/run', ({ user }) => { pc.requireAuthority(user, 2, 'run the event consumers'); return bus ? bus.run() : []; });
  route('POST', '/admin/events/dead/:consumer/:eventId/redrive', ({ user, params }) => {
    if (!bus) throw new AppError(503, 'Event consumers are not enabled');
    return bus.redrive(user, { consumer: decodeURIComponent(params.consumer), eventId: decodeURIComponent(params.eventId) });
  });
  // Claim exposures, reserves and payments (staff). Limits are in src/claimMoney.js.
  route('POST', '/claims/:id/exposures', ({ user, params, body }) => { claimMoney.addExposure(user, params.id, body); return pc.claimDetail(params.id, user); });
  route('POST', '/claims/:id/exposures/:number/reserve', ({ user, params, body }) => { claimMoney.setExposureReserve(user, params.id, params.number, body.amount); return pc.claimDetail(params.id, user); });
  route('POST', '/claims/:id/exposures/:number/payments', ({ user, params, body }) => ({ result: claimMoney.payExposure(user, params.id, params.number, body), claim: pc.claimDetail(params.id, user) }));
  route('POST', '/claims/:id/payments/:paymentId/approve', ({ user, params }) => ({ result: claimMoney.approvePayment(user, params.id, params.paymentId), claim: pc.claimDetail(params.id, user) }));
  // Documents in English, Hindi or Telugu; electronic signature; delivery by email or WhatsApp.
  route('GET', '/documents/:id/render', ({ user, params, query }) => documents.render(user, params.id, { language: query.get('language') || undefined }));
  // The document as a page of its own, for printing or saving as PDF from the browser (which has the Hindi and Telugu fonts).
  route('GET', '/documents/:id/view', ({ user, params, query }, res) => {
    const doc = documents.render(user, params.id, { language: query.get('language') || undefined });
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'", 'X-Content-Type-Options': 'nosniff' });
    res.end(doc.html);
  }, { stream: true });
  route('POST', '/documents/:id/sign', ({ user, params, body }) => documents.sign(user, params.id, body));
  route('GET', '/documents/:id/verify', ({ user, params }) => documents.verify(user, params.id));
  route('POST', '/documents/:id/deliver', ({ user, params, body }) => documents.deliver(user, params.id, body), { readOnly: true });
  // Accounting (UW managers): trial balance, journal, general ledger export, reconciliation, month close, producers and commission.
  route('GET', '/accounting/trial-balance', ({ user, query }) => accounting.trialBalance(user, { asOf: query.get('asOf') || undefined }));
  route('GET', '/accounting/journal', ({ user, query }) => accounting.journal(user, { from: query.get('from') || undefined, to: query.get('to') || undefined, account: query.get('account') || undefined }));
  route('GET', '/accounting/gl.csv', ({ user, query }, res) => {
    const csv = accounting.glCsv(user, { from: query.get('from') || undefined, to: query.get('to') || undefined });
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="general-ledger.csv"', 'Cache-Control': 'no-store' });
    res.end(csv);
  }, { stream: true });
  route('GET', '/accounting/reconciliation', ({ user }) => accounting.reconciliation(user));
  route('GET', '/accounting/closings', ({ user }) => accounting.verifyClosings(user));
  route('POST', '/accounting/closings', ({ user, body }) => accounting.closeMonth(user, body.month));
  route('GET', '/accounting/producers', ({ user }) => accounting.producers(user));
  route('POST', '/accounting/producers/:code/rate', ({ user, params, body }) => accounting.setProducerRate(user, params.code, body.percent));
  route('POST', '/accounting/producers/:code/payments', ({ user, params, body }) => accounting.payCommission(user, { ...body, producerCode: params.code }));
  // Commission statements: a manager for any producer, a producer for their own.
  const range = (query) => ({ from: query.get('from') || undefined, to: query.get('to') || undefined });
  route('GET', '/producers/:code/statement', ({ user, params, query }) => accounting.statement(user, params.code, range(query)));
  route('GET', '/producers/:code/statement.csv', ({ user, params, query }, res) => {
    const csv = accounting.statementCsv(user, params.code, range(query));
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="commission-${params.code}.csv"`, 'Cache-Control': 'no-store' });
    res.end(csv);
  }, { stream: true });
  route('GET', '/producers/:code/statement.pdf', async ({ user, params, query }, res) => {
    const pdf = await accounting.statementPdf(user, params.code, range(query));
    res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="commission-${params.code}.pdf"`, 'Content-Length': pdf.length });
    res.end(pdf);
  }, { stream: true });
  route('GET', '/activities', ({ user, query }) => pc.activities(user, { all: query.get('all') === 'true', type: query.get('type') || undefined }));
  // Work queues: what waits in each queue, taking an item, and a manager giving one to a person.
  route('GET', '/queues', ({ user }) => pc.queueSummary(user));
  route('POST', '/activities/:id/take', ({ user, params }) => pc.takeActivity(params.id, user));
  route('POST', '/activities/:id/assign', ({ user, params, body }) => pc.assignActivity(params.id, body.assigneeId, user));
  route('POST', '/activities/:id/complete', ({ user, params }) => pc.completeActivity(params.id, user));

  route('GET', '/ratebooks', () => RATE_BOOKS);
  route('GET', '/events', () => pc.events(200));
  route('POST', '/batch/renewals', ({ user, body }) => pc.runRenewalBatch(body, user));
  route('GET', '/chat/status', () => (chatbot ? chatbot.status() : { mode: 'disabled' }));
  route('POST', '/chat', ({ user, body }) => {
    if (!chatbot) throw new AppError(503, 'The assistant is not enabled');
    return chatbot.chat(body, user);
  }, { readOnly: true });
  // Live answers: Server-Sent Events (meta, tool, delta, reset, done, error) over one POST response.
  route('POST', '/chat/stream', async ({ user, body }, res) => {
    if (!chatbot) throw new AppError(503, 'The assistant is not enabled');
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    let open = true;
    res.on('close', () => { open = false; });
    const emit = (event, data) => { if (open) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
    emit('meta', chatbot.status());
    try {
      const result = await chatbot.chat(body, user, emit);
      emit('done', result);
    } catch (err) {
      if (!(err instanceof AppError)) console.error(err);
      emit('error', { error: err instanceof AppError ? err.message : GENERIC_ERROR, status: err.status || 500 });
    }
    res.end();
  }, { readOnly: true, stream: true });
  // Voice input: the browser posts a WAV recording; Google detects the language and transcribes it.
  route('GET', '/speech/status', () => (speech ? speech.status() : { enabled: false, reason: 'Speech is not configured' }));
  route('POST', '/speech', ({ body, query }) => {
    if (!speech) throw new AppError(503, 'Cloud speech is not set up on the server');
    return speech.transcribe(body, { language: query.get('language') || undefined });
  }, { readOnly: true, raw: true });
  // Sales analytics, lapsing policies and follow-ups.
  route('GET', '/sales/analytics', ({ user, query }) => pc.salesAnalytics(user, { period: query.get('period') || 'month', product: query.get('product') || undefined }));
  route('GET', '/sales/lapsing', ({ user }) => pc.lapsePolicies(user));
  route('GET', '/sales/followups', ({ user }) => pc.followUpsVisible(user));
  route('GET', '/sales/policies/:id/followups', ({ user, params }) => pc.followUpHistory(params.id, user));
  route('POST', '/sales/policies/:id/followups', ({ user, params, body }) => pc.logFollowUp(params.id, body, user));
  // Management reports. Access is set per role in src/permissions.js.
  route('GET', '/reports/claims', ({ user }) => pc.claimsReport(user));
  // Reports on payments, refunds and claim approvals. Collections and refunds: UW managers. Claim approvals: underwriters and managers.
  route('GET', '/reports/collections', ({ user, query }) => reports.collections(user, { asOf: query.get('asOf') || undefined }));
  route('GET', '/reports/refunds', ({ user }) => reports.refunds(user));
  route('GET', '/reports/claim-approvals', ({ user }) => reports.claimApprovals(user));
  route('GET', '/reports/billing', ({ user, query }) => pc.billingReport(user, { from: query.get('from') || undefined, to: query.get('to') || undefined }));
  // Monthly profitability and settlement (UW Manager only): premiums + commission, less expenses entered here.
  const monthRange = (query) => ({ from: query.get('from') || undefined, to: query.get('to') || undefined });
  route('GET', '/insights', ({ user, query }) => insights.dashboard(user, monthRange(query)));
  route('GET', '/finance/report', ({ user, query }) => finance.report(user, monthRange(query)));
  route('GET', '/finance/expenses', ({ user, query }) => finance.expenses(user, monthRange(query)));
  route('POST', '/finance/expenses', ({ user, body }) => finance.addExpense(user, body));
  route('POST', '/finance/commission', ({ user, body }) => finance.setCommissionRate(user, body.percent));
  const download = (type, contentType, make) => route('GET', `/reports/profitability.${type}`, async ({ user, query }, res) => {
    const file = await make(user, monthRange(query));
    res.writeHead(200, { 'Content-Type': contentType, 'Content-Disposition': `attachment; filename="settlement-${query.get('from') || 'start'}-to-${query.get('to') || 'end'}.${type}"`, 'Content-Length': file.length });
    res.end(file);
  }, { stream: true });
  download('xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', (u, r) => finance.excel(u, r));
  download('pdf', 'application/pdf', (u, r) => finance.pdf(u, r));

  // Tickets: issues with priority and SLA timers. The queue puts premium customers first.
  route('GET', '/tickets', ({ user, query }) => pc.listTickets(user, { status: query.get('status') || undefined }));
  route('GET', '/tickets/queue', ({ user }) => pc.ticketQueue(user));
  route('POST', '/tickets', ({ user, body }) => pc.ticketView(pc.createTicket(body, user), user));
  route('GET', '/tickets/:id', ({ user, params }) => pc.ticketView(pc.ticket(params.id, user), user));
  route('POST', '/tickets/:id/assign', ({ user, params, body }) => pc.assignTicket(params.id, body.assigneeId, user));
  route('POST', '/tickets/:id/status', ({ user, params, body }) => pc.moveTicket(params.id, { to: body.to }, user));
  route('POST', '/tickets/:id/notes', ({ user, params, body }) => pc.addTicketNote(params.id, body, user));
  // Claim stages: Submitted > Under Review > Documents Pending > Approved / Rejected > Settled.
  route('POST', '/claims/:id/stage', ({ user, params, body }) => pc.moveClaim(params.id, { to: body.to, reason: body.reason }, user));

  // Customer messages (email and WhatsApp). Sending needs confirm: true in the body.
  route('GET', '/messages/status', () => (messaging ? messaging.status() : { channels: {}, templates: [] }));
  route('POST', '/messages/preview', ({ user, body }) => messaging.preview(body, user), { readOnly: true });
  // Sending waits for the mail server, so these two save their own record afterwards instead of running inside a unit of work.
  route('POST', '/messages/send', ({ user, body }) => messaging.send(body, user), { readOnly: true });
  route('GET', '/accounts/:id/messages', ({ user, params }) => messaging.messagesFor(params.id, user));
  route('POST', '/admin/reset', ({ user }) => {
    pc.requireAuthority(user, 2, 'reset demo data');
    store.reset();
    // The staff go with the data, and the seed signs in as them: put the built-in team back first.
    pc.seedStaff();
    if (reseed) reseed();
    return { ok: true };
  });

  const handle = async function handle(req, res, pathname, query) {
    const send = (status, payload) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(payload));
    };
    try {
      const sub = pathname.replace(/^\/api/, '') || '/';
      let match = null;
      let found = null;
      for (const r of routes) {
        const m = r.re.exec(sub);
        if (m) {
          match = m;
          if (r.method === req.method) { found = r; break; }
        }
      }
      if (!found) throw new AppError(match ? 405 : 404, match ? 'Method not allowed' : `No route for ${req.method} ${sub}`);
      const body = req.method === 'GET' ? {} : found.raw ? await readBody(req, 4 * 1024 * 1024) : await readJson(req);
      // The signed-in user comes from the session cookie, never from a header the caller chooses.
      const cookie = String(req.headers.cookie || '');
      const match2 = cookie.match(/(?:^|;\s*)pc_session=([0-9a-f]{64})/);
      const token = match2 ? match2[1] : null;
      let user = null;
      if (auth && token) user = auth.userFor(token);
      if (!found.isPublic || sub === "/auth/password") {
        if (!user) throw new AppError(401, 'Sign in to continue');
        if (user.mustChangePassword && !sub.startsWith('/auth/')) throw new AppError(403, 'Change your temporary password before using the app');
      }
      if (found.isPublic && !user && sub === '/auth/me') throw new AppError(401, 'Not signed in');
      const ctx = { user, token, params: match.groups || {}, query, body };
      if (found.stream) return await found.handler(ctx, res);

      // If-Match: a change to an account or a job says which version it was based on. Refused if the record has changed since.
      const ifMatch = req.headers['if-match'];
      if (req.method === 'PUT' && ifMatch && ifMatch !== '*') {
        const current = etagFor(pc, sub);
        if (current && ifMatch.replace(/^W\//, '') !== current) throw new AppError(412, 'This record was changed by someone else since you opened it. Reload it and try again.');
      }

      // Idempotency-Key: the same key and the same request again gets the first answer back and does the work once.
      const key = req.method === 'POST' && user && !found.readOnly && !found.raw ? String(req.headers['idempotency-key'] || '').trim() : '';
      const keyId = key ? `${user.id}|${key}` : '';
      const requestHash = key ? hash(`${sub}|${JSON.stringify(body)}`) : '';
      if (key) {
        const stored = store.data.idempotency[keyId];
        if (stored) {
          if (stored.requestHash !== requestHash) throw new AppError(422, 'This Idempotency-Key was already used for a different request');
          res.setHeader('Idempotency-Replayed', 'true');
          if (stored.etag) res.setHeader('ETag', stored.etag);
          return send(stored.status, stored.response);
        }
      }
      const statusFor = req.method === 'POST' && /\/(accounts|submission)$/.test(sub) ? 201 : 200;
      const result = found.readOnly
        ? await found.handler(ctx)
        : store.transaction(() => {
          const r = found.handler(ctx);
          if (key) {
            // Saved with the change, so a change and its remembered answer stand or fall together.
            const cutoff = pc.nowMs() - IDEMPOTENCY_HOURS * 3600000;
            for (const [k, v] of Object.entries(store.data.idempotency)) if (v.at < cutoff) delete store.data.idempotency[k];
            store.data.idempotency[keyId] = { requestHash, status: statusFor, response: r, etag: etagFor(pc, sub), at: pc.nowMs() };
          }
          return r;
        });
      const etag = etagFor(pc, sub);
      if (etag) res.setHeader('ETag', etag);
      // The consumers run after the change is saved, never inside it: a failing consumer cannot undo the change.
      if (bus && !found.readOnly && !sub.startsWith('/admin/events')) runBusSoon();
      if (ctx.setCookie) res.setHeader('Set-Cookie', ctx.setCookie);
      send(statusFor, result);
    } catch (err) {
      if (err instanceof AppError) return send(err.status, { error: err.message, details: err.details || null });
      console.error(err);
      send(500, { error: GENERIC_ERROR });
    }
  };
  // The list of routes, so a test can check every one of them (test/permissions-matrix.test.js).
  handle.routes = routes.map((r) => ({ method: r.method, pattern: r.pattern, isPublic: r.isPublic, readOnly: r.readOnly }));
  return handle;
}

// What a person sees when something breaks inside the server; the details go to the server log only.
const GENERIC_ERROR = 'Something went wrong on the server. Please try again, and tell your administrator if it keeps happening.';

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        if (chunks.length) chunks.length = 0;
        reject(new AppError(413, 'Request body too large')); // later chunks are read and dropped so the answer can be sent
      } else if (size <= limit) chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const text = (await readBody(req, 1e6)).toString('utf8');
  if (!text) return {};
  try {
    return JSON.parse(text, stripDangerousKeys);
  } catch {
    throw new AppError(400, 'Request body is not valid JSON');
  }
}

module.exports = { createApi };
