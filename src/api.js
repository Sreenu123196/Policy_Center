'use strict';
// REST API (the simulator's equivalent of PolicyCenter Cloud API). The caller is identified by
// the X-User header; every mutating call runs as one unit of work against the store.

const crypto = require('node:crypto');
const { stripDangerousKeys } = require('./security');
const { writeBackup, listBackups } = require('./backup');
const { DataProtection } = require('./dataProtection');
const { AuditLog } = require('./audit');
const { AgentService } = require('./agents');
const { PRODUCTS, STATES, PRODUCER_CODES } = require('./productModel');
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

function createApi(pc, store, { reseed, chatbot, speech, messaging, auth, bus, backupDir, audit: auditOption, agents: agentsOption, notifier: notifierOption, knowledge: knowledgeOption } = {}) {
  // The second-factor gate: a token waits here until its challenge is satisfied, and the SSO module holds the sessions.
  const pendingTokens = new Map();
  const sso = require('./sso').createSso({ store });
  // Notifications are optional (a test or a bare local run may not configure them). These keep the three outside doors
  // closed with an honest answer instead of failing on an undefined service.
  const notifier = notifierOption || {
    publicUrl: '',
    handleTelegramUpdate: () => { throw new AppError(503, 'Agent notifications are not configured on this server'); },
    voiceScript: () => null,
    handleVoiceKeypress: () => { throw new AppError(503, 'Agent notifications are not configured on this server'); },
  };
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
  const contacts = require('./contacts').createContacts(store);
  route('GET', '/contacts', () => contacts.list(), { readOnly: true });
  const incidents = require('./incidents').createIncidents(store, pc);
  route('GET', '/incidents', ({ user }) => {
    if (!user || user.role === 'Agent') throw new AppError(403, 'Incidents are not open to agents');
    return { incidents: incidents.list() };
  }, { readOnly: true });
  route('POST', '/incidents', ({ user, body }) => incidents.create(user, body), {});
  route('POST', '/incidents/:id/status', ({ user, params, body }) => {
    if (!user || !['UW Manager', 'Underwriter'].includes(user.role)) throw new AppError(403, 'Only claims staff may move an incident');
    return incidents.setStatus(params.id, String((body && body.status) || ''));
  }, {});
  const surveyors = require('./surveyors').createSurveyors(pc);
  route('GET', '/claims/:claim/surveyors', ({ user, params }) => {
    if (!user || user.role === 'Agent') throw new AppError(403, 'Surveys are not open to agents');
    return surveyors.list(user, params.claim);
  }, { readOnly: true });
  route('POST', '/claims/:claim/surveyors', ({ user, params, body }) => {
    if (!user || !['UW Manager', 'Underwriter'].includes(user.role)) throw new AppError(403, 'Only claims staff may appoint a surveyor');
    return surveyors.appoint(user, params.claim, body);
  }, {});
  const litigation = require('./litigation').createLitigation(pc);
  route('GET', '/claims/:claim/litigation', ({ user, params }) => {
    if (!user || user.role === 'Agent') throw new AppError(403, 'Litigation is not open to agents');
    return litigation.get(user, params.claim);
  }, { readOnly: true });
  route('POST', '/claims/:claim/litigation', ({ user, params, body }) => {
    if (!user || !['UW Manager', 'Underwriter'].includes(user.role)) throw new AppError(403, 'Only claims staff may record litigation');
    return litigation.record(user, params.claim, body);
  }, {});
  const bindGate = require('./bindGate').createBindGate(pc, store);
  route('POST', '/jobs/:id/bind-approval', ({ user, params }) => {
    if (!user || user.role === 'Agent') throw new AppError(403, 'Only staff may request a bind approval');
    return bindGate.requestApproval(user, params.id);
  }, {});
  route('GET', '/bind-approvals', ({ user }) => {
    if (!user || user.role === 'Agent') throw new AppError(403, 'Only staff may see bind approvals');
    return { approvals: bindGate.list() };
  }, { readOnly: true });
  route('POST', '/bind-approvals/:id/decision', ({ user, params, body }) => {
    if (!user || !['UW Manager', 'Underwriter'].includes(user.role)) throw new AppError(403, 'Only staff may decide a bind approval');
    return bindGate.decide(user, params.id, String((body && body.status) || ''));
  }, {});
  route('POST', '/jobs/:id/bind-approved', ({ user, params, body }) => {
    if (!user || user.role === 'Agent') throw new AppError(403, 'Agents cannot bind');
    return bindGate.bind(user, params.id, body && body.approvalId);
  }, {});
  const { CAPS } = require('./policyCapsData');
  const { resolveLimit, capsFor } = require('./policyCaps');
  const { inferForm, formsFor } = require('./formInference');
  route('POST', '/products/:product/form', ({ user, params, body }) => {
    if (!user || user.role === 'Agent') throw new AppError(403, 'Form inference is staff material');
    const forms = formsFor(params.product);
    // An unknown product is bad input, not a broken server: 422 with the reason, never a 500.
    if (!forms.length) throw new AppError(422, 'No forms are defined for ' + params.product);
    return { product: params.product, forms, ...inferForm({ product: params.product, facts: body || {} }) };
  }, { readOnly: true });
  const { resolveVersion, versionsFor } = require('./productVersions');
  route('GET', '/products/:product/version', ({ user, params, query }) => {
    if (!user || user.role === 'Agent') throw new AppError(403, 'Product versions are staff material');
    const asOf = query.get('asOf') || new Date().toISOString().slice(0, 10);
    const versions = versionsFor(params.product);
    // An unknown product is an empty collection, not an error: asking about something that does not exist is a fair
    // question with an empty answer. A malformed date is still bad input and says so.
    if (!versions.length) return { product: params.product, asOf, versions: [], resolved: null, reason: 'No versions are defined for ' + params.product };
    try {
      return { product: params.product, asOf, versions, resolved: resolveVersion({ product: params.product, asOf }) };
    } catch (err) {
      throw new AppError(422, err.message);
    }
  }, { readOnly: true });
  const { allocatePayment } = require('./paymentAllocation');
  // A receipt and the invoices it might settle. Nothing is written: the answer says where every rupee would go, and the
  // caller decides whether to post it - allocation is a question before it is a transaction.
  const mandates = require('./mandates').createMandates();
  const mandateStore = () => { store.data.mandates = store.data.mandates || []; return store.data.mandates; };
  const findMandate = (reference) => {
    const mandate = mandateStore().find((m) => m.reference === reference);
    if (!mandate) throw new AppError(404, 'Mandate not found');
    return mandate;
  };
  const { dueActions } = require('./workflowTimers');
  // What is overdue right now. Read-only: the caller decides whether to remind or escalate, and the item's lastActionAt
  // is what stops the same stage firing twice.
  const { createSignatures, hashDocument } = require('./esign');
  const signatures = createSignatures(store);
  // Signing is recorded against the bytes of the document. The body carries the document as text for the simulator; a real
  // client would post a file and the hash would be taken over the uploaded bytes.
  route('GET', '/sso/sessions', ({ user }) => {
    if (!user || user.role === 'Agent') throw new AppError(403, 'Sessions are staff material');
    // The challenge code is never returned here: it is only handed back at creation, and only because this is a simulation.
    return { sessions: (store.data.ssoSessions || []).map((s) => ({ id: s.id, subject: s.subject, role: s.role, state: s.state, createdAt: s.createdAt, expiresAt: s.expiresAt })) };
  }, { readOnly: true });
  route('GET', '/esign/signatures', ({ user }) => {
    if (!user || user.role === 'Agent') throw new AppError(403, 'Signatures are staff material');
    return { signatures: store.data.signatures || [] };
  }, { readOnly: true });
  route('POST', '/esign/signatures', ({ user, body }) => {
    if (!user) throw new AppError(401, 'Sign in first');
    const input = body || {};
    try {
      return signatures.sign({ signer: user, document: String(input.document || ''), documentRef: String(input.documentRef || '') });
    } catch (err) { throw new AppError(err instanceof AppError ? err.status : 422, err.message); }
  }, {});
  route('POST', '/esign/verify', ({ user, body }) => {
    if (!user) throw new AppError(401, 'Sign in first');
    const input = body || {};
    try {
      const hash = hashDocument(String(input.document || ''));
      const result = signatures.check(String(input.document || ''), { documentRef: input.documentRef || null });
      return { documentHash: hash, signed: result.signed, signatures: result.signatures, stale: result.stale };
    } catch (err) { throw new AppError(err instanceof AppError ? err.status : 422, err.message); }
  }, { readOnly: true });
  const gatewayUsage = () => (store.data.aiUsage || { tenants: {} });
  const aops = require('./aops').createAops();
  // B2: the procedures an agent must work within, readable by anyone who has to follow them.
  route('GET', '/aops', () => ({ procedures: aops.list() }), { readOnly: true });
  // Asking whether an action is permitted. Useful to the assistant before it acts, and to a person checking the answer.
  route('POST', '/aops/check', ({ body }) => {
    const input = body || {};
    if (!input.action) throw new AppError(422, 'action is required');
    return aops.check({ action: input.action, role: input.role, amount: input.amount, actor: input.actor, requestedBy: input.requestedBy });
  }, {});
  route('GET', '/ai/usage', ({ user }) => {
    if (!user || user.role === 'Agent') throw new AppError(403, 'AI spend is management material');
    const book = gatewayUsage();
    const tenants = book.tenants || {};
    const totalCost = Object.values(tenants).reduce((sum, t) => sum + (Number(t.cost) || 0), 0);
    return { tenants, totalCost: Math.round(totalCost * 1e6) / 1e6 };
  }, { readOnly: true });
  route('GET', '/workflow/due', ({ user, query }) => {
    if (!user || user.role === 'Agent') throw new AppError(403, 'Workflow timers are staff material');
    const items = (store.data.workflowItems || []);
    return { now: new Date().toISOString(), due: dueActions({ now: new Date(), items }) };
  }, { readOnly: true });
  route('GET', '/billing/mandates', ({ user }) => {
    if (!user || user.role === 'Agent') throw new AppError(403, 'Mandates are finance material');
    return { mandates: mandateStore() };
  }, { readOnly: true });
  route('POST', '/billing/mandates', ({ user, body }) => {
    if (!user || user.role === 'Agent') throw new AppError(403, 'Mandates are finance material');
    try {
      const mandate = mandates.create(body || {});
      mandateStore().push(mandate);
      return mandate;
    } catch (err) { throw new AppError(422, err.message); }
  }, {});
  route('POST', '/billing/mandates/:reference/authorise', ({ user, params, body }) => {
    if (!user || user.role === 'Agent') throw new AppError(403, 'Mandates are finance material');
    try { return mandates.authorise(findMandate(params.reference), body || {}); }
    catch (err) { throw new AppError(err instanceof AppError ? err.status : 422, err.message); }
  }, {});
  route('POST', '/billing/mandates/:reference/notice', ({ user, params, body }) => {
    if (!user || user.role === 'Agent') throw new AppError(403, 'Mandates are finance material');
    try { return mandates.notice(findMandate(params.reference), body || {}); }
    catch (err) { throw new AppError(err instanceof AppError ? err.status : 422, err.message); }
  }, {});
  // The debit is the only part that moves money: the mandate rules decide, then billing records the payment.
  route('POST', '/billing/mandates/:reference/debit', ({ user, params, body }) => {
    if (!user || user.role === 'Agent') throw new AppError(403, 'Mandates are finance material');
    const input = body || {};
    try {
      const mandate = mandates.debit(findMandate(params.reference), { on: input.on, amount: input.amount, period: input.period });
      const payment = billing.receivePayment(user, {
        policyId: input.policyId, amount: input.amount, method: input.method || 'eNACH',
        reference: mandate.reference + '/' + input.period, receivedOn: input.on,
      });
      return { mandate, payment };
    } catch (err) {
      throw new AppError(err instanceof AppError ? err.status : 422, err.message);
    }
  }, {});
  const allocations = require('./allocations').createAllocations(store);
  // Recording an allocation is a deliberate second step: the plan is computed by /billing/allocate, then written here with
  // who decided it. The invoices are not touched - settling them belongs to the payment path.
  route('POST', '/billing/allocations', ({ user, body }) => {
    if (!user || user.role === 'Agent') throw new AppError(403, 'Allocation is finance material');
    const input = body || {};
    try {
      const plan = allocatePayment({ amount: input.amount, invoices: input.invoices || [], reference: input.reference || null });
      return { plan, record: allocations.record(user, plan, input) };
    } catch (err) {
      throw new AppError(err instanceof AppError ? err.status : 422, err.message);
    }
  }, {});
  route('GET', '/billing/allocations', ({ user }) => {
    if (!user || user.role === 'Agent') throw new AppError(403, 'Allocation is finance material');
    return { allocations: allocations.list(), suspenseTotal: allocations.suspenseTotal() };
  }, { readOnly: true });
  route('POST', '/billing/allocate', ({ user, body }) => {
    if (!user || user.role === 'Agent') throw new AppError(403, 'Allocation is finance material');
    try {
      return allocatePayment({ amount: (body && body.amount), invoices: (body && body.invoices) || [], reference: (body && body.reference) || null });
    } catch (err) {
      throw new AppError(422, err.message);
    }
  }, { readOnly: true });
  route('GET', '/products/:product/caps', ({ user, params, query }) => {
    if (!user || user.role === 'Agent') throw new AppError(403, 'Product caps are staff material');
    const caps = capsFor(params.product, CAPS);
    const coverage = query.get('coverage');
    const requested = query.get('requested');
    const resolution = coverage && requested !== null && requested !== ''
      ? resolveLimit({ product: params.product, coverage, requested: Number(requested), caps })
      : null;
    return { product: params.product, caps, resolution };
  }, { readOnly: true });
  const claimRecoveries = require('./claimRecoveries').createRecoveries(pc);
  route('GET', '/claims/:claim/recoveries', ({ user, params }) => {
    // Refuse the role before the lookup: otherwise 404-versus-403 tells an agent whether a claim exists.
    if (!user || user.role === 'Agent') throw new AppError(403, 'Recoveries are not open to agents');
    return claimRecoveries.list(user, params.claim);
  }, { readOnly: true });
  route('POST', '/claims/:claim/recoveries', ({ user, params, body }) => {
    if (!user || user.role !== 'UW Manager') throw new AppError(403, 'Only a manager may record a recovery');
    return claimRecoveries.add(user, params.claim, body);
  }, {});
  route('POST', '/contacts', ({ user, body }) => contacts.create(user, body), {});
  route('GET', '/contacts/:id', ({ params }) => contacts.find(params.id), { readOnly: true });
  route('POST', '/contacts/:id/kyc', ({ user, params }) => {
    // A refusal is a refusal whatever the id is: checking the role before the lookup keeps an agent from learning
    // whether a contact exists by the difference between 403 and 404.
    if (!user || user.role !== 'UW Manager') throw new AppError(403, 'Only a manager may verify a contact');
    return contacts.verify(params.id, user);
  }, {});
  // Knowledge Assistant. Both are read-only in the app's sense: they change nothing in the store, so the dispatcher
  // awaits them. The query log lives in the separate knowledge database.
  const knowledge = knowledgeOption || null;
  // Customer and agent use arrives in R4; until then the corpus is staff-only.
  const staffOnly = (user) => { if (user && user.role === 'Agent') throw new AppError(403, 'The knowledge assistant is not open to agents yet'); };
  const noKnowledge = () => ({ status: 'not_found', answer: 'The knowledge assistant is not configured on this server.', citations: [], passages: [] });
  route('POST', '/knowledge/feedback', async ({ user, body }) => {
    if (!knowledge) return { ok: false, message: 'The knowledge assistant is not configured on this server' };
    try {
      return { ok: true, ...(await knowledge.recordFeedback(user, {
        queryId: body && body.queryId, verdict: body && body.verdict, comment: body && body.comment,
      })) };
    } catch (err) {
      throw new AppError(422, err.message);
    }
  }, { readOnly: true });
  route('GET', '/knowledge/feedback', async ({ user, query }) => {
    if (!user || user.role !== 'UW Manager') throw new AppError(403, 'Only a manager may see the review queue');
    if (!knowledge) return { feedback: [] };
    return { feedback: await knowledge.feedbackQueue({ verdict: query.get('verdict') || 'bad', limit: Number(query.get('limit') || 50) }) };
  }, { readOnly: true });

  route('GET', '/knowledge/drift', async ({ user }) => {
    if (!user || user.role !== 'UW Manager') throw new AppError(403, 'Only a manager may run the drift check');
    if (!knowledge) return { checked: 0, drifted: [], rows: [] };
    // Where the sources come from is the deployment's business: a JSON list in KNOWLEDGE_SOURCES, each
    // { documentId, path }. Empty means nothing is registered, which is reported rather than guessed at.
    let sources = [];
    try { sources = JSON.parse(process.env.KNOWLEDGE_SOURCES || '[]'); } catch { sources = []; }
    return knowledge.runDrift(sources);
  }, { readOnly: true });

  route('GET', '/knowledge/dashboard', async ({ user, query }) => {
    if (!user || user.role !== 'UW Manager') throw new AppError(403, 'Only a manager may see the knowledge dashboard');
    if (!knowledge) return { asked: 0, answered: 0, notFound: 0, notFoundRate: 0, latencyMs: {}, byDay: [], byRole: [] };
    return knowledge.dashboard({ days: Number(query.get('days') || 7) });
  }, { readOnly: true });

  route('GET', '/knowledge/gaps', async ({ user, query }) => {
    if (!user || user.role !== 'UW Manager') throw new AppError(403, 'Only a manager may see the content gaps');
    if (!knowledge) return { gaps: [] };
    return { gaps: await knowledge.contentGaps(Number(query.get('limit') || 20)) };
  }, { readOnly: true });

  route('GET', '/knowledge/documents', async ({ user }) => {
    if (!user || user.role !== 'UW Manager') throw new AppError(403, 'Only a manager may see the corpus inventory');
    if (!knowledge) return { configured: false, documents: [], versions: [], runs: [] };
    return { configured: true, ...(await knowledge.overview()) };
  }, { readOnly: true });

  route('POST', '/knowledge/documents', async ({ user, body }) => {
    if (!user || user.role !== 'UW Manager') throw new AppError(403, 'Only a manager may publish a wording');
    if (!knowledge) return { ok: false, message: 'The knowledge assistant is not configured on this server' };
    const title = String((body && body.title) || '').trim();
    const text = String((body && body.text) || '');
    if (!title || !text) return { ok: false, message: 'A title and the wording text are required' };
    const validFrom = String((body && body.validFrom) || new Date().toISOString().slice(0, 10));
    const product = (body && body.product) || null;
    return knowledge.ingest({
      document: { id: (product || 'wording') + '-' + title.toLowerCase().replace(/[^a-z0-9]+/g, '-'), title, source: 'upload' },
      version: { id: 'v-' + Date.now(), version: 1, validFrom },
      text,
      metadata: { audience: String((body && body.audience) || 'underwriting'), product, language: (body && body.language) || 'en', sensitivity: 'internal', validFrom },
    });
  }, { readOnly: true });

  route('POST', '/knowledge/reindex', async ({ user }) => {
    if (!user || user.role !== 'UW Manager') throw new AppError(403, 'Only a manager may reindex the corpus');
    if (!knowledge) return { ok: false, message: 'The knowledge assistant is not configured on this server' };
    return knowledge.reindex();
  }, { readOnly: true });

  route('POST', '/knowledge/ask', async ({ user, body }) => (knowledge ? knowledge.ask(user, String((body && body.question) || ''), { asOf: body && body.asOf, language: (body && body.language) || 'en' }) : noKnowledge()), { readOnly: true });
  route('GET', '/knowledge/search', async ({ user, query }) => (knowledge ? knowledge.search(user, String(query.get('q') || ''), { asOf: query.get('asOf') || null }) : []), { readOnly: true });

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
    const { file: _file, ...made } = writeBackup(JSON.stringify(store.data), backupDir);
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
  // The suggestions addressed to the signed-in person: what the Desktop and the Work queues show. Any signed-in role may
  // ask; it only ever returns their own.
  route('GET', '/suggestions/mine', ({ user }) => (agents ? agents.suggestionsFor(user) : { count: 0, byAgent: [], items: [] }));

  // How an agent reaches a person when it needs a decision. These three doors cannot sign in, so each checks its sender:
  // Telegram with the secret set when the webhook was registered, Twilio with the signature over the request.
  route('POST', '/webhooks/telegram', ({ body, headers }) => notifier.handleTelegramUpdate(body, { secret: headers['x-telegram-bot-api-secret-token'], expectedSecret: process.env.TELEGRAM_WEBHOOK_SECRET }), { isPublic: true });
  route('GET', '/webhooks/twilio/voice', ({ query }, res) => {
    const script = notifier.voiceScript(query.get('n'), query.get('t'));
    res.writeHead(script ? 200 : 404, { 'Content-Type': script ? 'text/xml; charset=utf-8' : 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(script ? script.twiml : 'Unknown call');
  }, { stream: true, isPublic: true });
  // Razorpay posts here: bytes, then signature, then parse. The logic is a module so it can be tested without a server.
  route('POST', '/webhooks/razorpay', ({ headers, body }) => receiveRazorpayWebhook({
    headers, body, secret: process.env.RAZORPAY_WEBHOOK_SECRET, store,
  }), { isPublic: true, raw: true, readOnly: true });
  route('POST', '/webhooks/twilio/decision', ({ body, query, headers, url }) => {
    const params = Object.fromEntries(new URLSearchParams(body.toString('utf8')));
    return notifier.handleVoiceKeypress({
      number: query.get('n'), token: query.get('t'), digits: params.Digits || '', signature: headers['x-twilio-signature'], params,
      url: `${notifier.publicUrl}${url}`,
    });
  }, { isPublic: true, raw: true });
  route('POST', '/agents/suggestions/:id/decision', ({ user, params, body }) => agents.decide(params.id, body, user));
  route('POST', '/agents/:id/mode', ({ user, params, body }) => agents.setMode(params.id, body.mode, user));
  route('POST', '/agents/:id/limits', ({ user, params, body }) => agents.setLimits(params.id, body.limits, user));
  route('GET', '/agents/:id/backtest', ({ user, params }) => agents.backtest(params.id, user));
  route('GET', '/auth/status', () => ({ setupNeeded: pc.setupNeeded() }), { isPublic: true });
  route('POST', '/auth/setup', (ctx) => {
    const view = pc.setupFirstManager({ username: ctx.body.username, password: ctx.body.password });
    const { token } = auth.login(view.username, ctx.body.password);
  if (process.env.SSO_ENFORCE_MFA === '1') {
    const started = sso.startSession({ subject: view.username, role: view.role, mfaRequired: true });
    pendingTokens.set(started.session.id, token);
    return { mfaRequired: true, sessionId: started.session.id, simulatedCode: started.simulatedCode };
  }
    ctx.setCookie = `pc_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`;
    return { user: view, mustChangePassword: false };
  }, { isPublic: true });
  // Sign-in with a second factor, when SSO_ENFORCE_MFA=1. The password is checked first; the session cookie is not issued
  // until the challenge is satisfied. Off by default, so an install without the flag behaves exactly as before.
  route('POST', '/auth/sso/mfa', (ctx) => {
    const input = ctx.body || {};
    const session = sso.satisfyChallenge(String(input.sessionId || ''), String(input.code || ''));
    const token = pendingTokens.get(session.id);
    if (!token) throw new AppError(401, 'This sign-in has expired; sign in again');
    pendingTokens.delete(session.id);
    ctx.setCookie = `pc_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`;
    return { user: session.subject };
  }, { isPublic: true });

  // Sign-in
  route('POST', '/auth/login', (ctx) => {
    const { token, ...rest } = auth.login(ctx.body.username, ctx.body.password);
    // With SSO_ENFORCE_MFA=1 the cookie is withheld: the token waits in pendingTokens until the challenge is satisfied, and the
    // code is returned only because this is a simulation.
    if (process.env.SSO_ENFORCE_MFA === '1') {
      const started = sso.startSession({ subject: rest.user && rest.user.username, role: rest.user && rest.user.role, mfaRequired: true });
      pendingTokens.set(started.session.id, token);
      return { mfaRequired: true, sessionId: started.session.id, simulatedCode: started.simulatedCode };
    }
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
  // With ESIGN_REQUIRED=1 a bind is refused until the quoted schedule has been signed. The document the signature covers is
  // the job number and its quoted premium: the two things a signature on a schedule attests, and stable across the bind.
  route('POST', '/jobs/:id/bind', ({ user, params }) => {
    if (process.env.ESIGN_REQUIRED === '1') {
      const job = pc.job(params.id, user);
      if (job.status === 'Quoted') {
        const document = job.jobNumber + '|' + (job.quote && job.quote.premium !== undefined ? job.quote.premium : '');
        signatures.requireSigned(document, { documentRef: job.jobNumber });
      }
    }
    return pc.jobDetail(pc.bind(params.id, user).id, user);
  }, {});
  route('POST', '/jobs/:id/withdraw', ({ user, params }) => pc.jobDetail(pc.withdraw(params.id, user).id, user));
  route('POST', '/jobs/:id/decline', ({ user, params, body }) => pc.jobDetail(pc.decline(params.id, body.reason, user).id, user));
  route('POST', '/jobs/:id/uw-issues/:key/approve', ({ user, params, body }) =>
    pc.jobDetail(pc.approveIssue(params.id, decodeURIComponent(params.key), body.note, user).id, user));

  route('GET', '/policies', ({ user, query }) => pc.listPolicies(query.get('q'), user));
  route('GET', '/claims', ({ user, query }) => pc.listClaims(user, { status: query.get('status') || undefined }));
  route('GET', '/claims/:id', ({ user, params }) => pc.claimDetail(params.id, user));
  route('GET', '/policies/:id', ({ user, params }) => pc.policyDetail(params.id, user));
  // A9: ask about one policy, answered from the wordings with citations, plus that policy's own facts.
  // Access is the application's: pc.policy throws for a policy the person may not see, so an agent cannot ask about another
  // agent's customer by guessing a policy number.
  route('GET', '/policies/:id/ask', async ({ user, params, query }) => {
    const policy = pc.policy(params.id, user);
    const question = String(query.get('q') || '').trim();
    // No question is a fair request with an empty answer, not an error: the smoke test asks every read route once, and a person
    // who opens the page before typing should see the prompt rather than a failure.
    if (!question) return { policy: { policyNumber: policy.policyNumber }, answer: 'Ask a question with ?q=', citations: [], notFound: true };
    const { policyFacts } = require('./knowledge/policy-facts');
    const facts = policyFacts({ pc, user, policyNumber: policy.policyNumber });
    if (!knowledge) {
      return { policy: { policyNumber: policy.policyNumber, facts }, answer: 'The knowledge assistant is not configured on this server.', citations: [], notFound: true };
    }
    const result = await knowledge.ask(user, question, { asOf: policy.effectiveDate || null });
    return {
      policy: { policyNumber: policy.policyNumber, status: facts.status, product: facts.product, asOf: facts.asOf, facts },
      answer: result.answer,
      citations: (result.citations || []).map((c) => ({ clause: c.clause, headingPath: c.headingPath, page: c.page })),
      notFound: result.status !== 'answered',
    };
  }, { readOnly: true });
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
      const sub = require('./paths').normalizePath(pathname);
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
      const ctx = { user, token, params: match.groups || {}, query, body, headers: req.headers, url: req.url };
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
