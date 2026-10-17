'use strict';
// REST API (the simulator's equivalent of PolicyCenter Cloud API). The caller is identified by
// the X-User header; every mutating call runs as one unit of work against the store.

const { PRODUCTS, STATES, USERS, PRODUCER_CODES } = require('./productModel');
const { RATE_BOOKS } = require('./rateBooks');
const { AppError, CANCEL_REASONS } = require('./policyCenter');

function createApi(pc, store, { reseed, chatbot, speech, messaging } = {}) {
  const routes = [];
  // readOnly routes run outside the store's unit of work (the chatbot only reads data).
  // raw routes receive the request body as bytes (audio) instead of JSON.
  const route = (method, pattern, handler, { readOnly = method === 'GET', stream = false, raw = false } = {}) => {
    const re = new RegExp(`^${pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`);
    routes.push({ method, re, handler, readOnly, stream, raw });
  };

  route('GET', '/meta', () => ({
    today: pc.today(),
    states: STATES,
    users: USERS,
    producerCodes: PRODUCER_CODES,
    products: PRODUCTS,
    cancelReasons: CANCEL_REASONS,
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
  route('GET', '/policies/:id', ({ user, params }) => pc.policyDetail(params.id, user));
  route('POST', '/policies/:id/change', ({ user, params, body }) => pc.jobDetail(pc.startPolicyChange(params.id, body, user).id, user));
  route('POST', '/policies/:id/cancel', ({ user, params, body }) => pc.jobDetail(pc.startCancellation(params.id, body, user).id, user));
  route('POST', '/policies/:id/reinstate', ({ user, params }) => pc.jobDetail(pc.startReinstatement(params.id, user).id, user));
  route('POST', '/policies/:id/renew', ({ user, params }) => pc.jobDetail(pc.startRenewal(params.id, user).id, user));

  route('GET', '/activities', ({ user, query }) => pc.activities(user, { all: query.get('all') === 'true' }));
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
      emit('error', { error: err instanceof AppError ? err.message : `Internal error: ${err.message}`, status: err.status || 500 });
    }
    res.end();
  }, { readOnly: true, stream: true });
  // Voice input: the browser posts a WAV recording; Google detects the language and transcribes it.
  route('GET', '/speech/status', () => (speech ? speech.status() : { enabled: false, reason: 'Speech is not configured' }));
  route('POST', '/speech', ({ body }) => {
    if (!speech) throw new AppError(503, 'Cloud speech is not set up on the server');
    return speech.transcribe(body);
  }, { readOnly: true, raw: true });
  // Sales analytics, lapsing policies and follow-ups.
  route('GET', '/sales/analytics', ({ user, query }) => pc.salesAnalytics(user, { period: query.get('period') || 'month', product: query.get('product') || undefined }));
  route('GET', '/sales/lapsing', ({ user }) => pc.lapsePolicies(user));
  route('GET', '/sales/followups', ({ user }) => pc.followUpsVisible(user));
  route('GET', '/sales/policies/:id/followups', ({ user, params }) => pc.followUpHistory(params.id, user));
  route('POST', '/sales/policies/:id/followups', ({ user, params, body }) => pc.logFollowUp(params.id, body, user));
  // Customer messages (email and WhatsApp). Sending needs confirm: true in the body.
  route('GET', '/messages/status', () => (messaging ? messaging.status() : { channels: {}, templates: [] }));
  route('POST', '/messages/preview', ({ user, body }) => messaging.preview(body, user), { readOnly: true });
  route('POST', '/messages/send', ({ user, body }) => messaging.send(body, user));
  route('GET', '/accounts/:id/messages', ({ user, params }) => messaging.messagesFor(params.id, user));
  route('POST', '/admin/reset', ({ user }) => {
    pc.requireAuthority(user, 2, 'reset demo data');
    store.reset();
    if (reseed) reseed();
    return { ok: true };
  });

  return async function handle(req, res, pathname, query) {
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
      const user = pc.user(req.headers['x-user'] || 'agent');
      const ctx = { user, params: match.groups || {}, query, body };
      if (found.stream) return await found.handler(ctx, res);
      const result = found.readOnly ? await found.handler(ctx) : store.transaction(() => found.handler(ctx));
      send(req.method === 'POST' && /\/(accounts|submission)$/.test(sub) ? 201 : 200, result);
    } catch (err) {
      if (err instanceof AppError) return send(err.status, { error: err.message, details: err.details || null });
      console.error(err);
      send(500, { error: `Internal error: ${err.message}` });
    }
  };
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new AppError(413, 'Request body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const text = (await readBody(req, 1e6)).toString('utf8');
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new AppError(400, 'Request body is not valid JSON');
  }
}

module.exports = { createApi };
