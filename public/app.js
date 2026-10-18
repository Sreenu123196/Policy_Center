'use strict';
/* PolicyCenter Simulator UI: a small hash-routed single-page app over the REST API. */

const OPEN = ['Draft', 'Quoted'];
const EDITABLE_TYPES = ['Submission', 'PolicyChange', 'Renewal'];
const S = { meta: null, me: null, jv: null, policy: null, policyTab: 'summary', batch: null };

// ------------------------------------------------------------------ utilities

function readPref(k) { try { return localStorage.getItem(k); } catch { return null; } }
function writePref(k, v) { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } }
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => (n === null || n === undefined || n === '' ? '—' : Number(n).toLocaleString('en-US', { style: 'currency', currency: 'USD' }));
const usd0 = (n) => (n === null || n === undefined || n === '' ? '—' : '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 }));
const when = (s) => (s ? new Date(s).toLocaleString() : '—');
const slug = (t) => String(t).toLowerCase().replace(/[^a-z]+/g, '-').replace(/^-|-$/g, '');
const badge = (t) => `<span class="badge b-${slug(t)}">${esc(t)}</span>`;
const clone = (o) => JSON.parse(JSON.stringify(o));
const me = () => S.me;
const product = (code) => S.meta.products[code];
const sel = (a, b) => (String(a) === String(b) ? 'selected' : '');
const dis = (editable) => (editable ? '' : 'disabled');

function setPath(obj, path, value) {
  const keys = path.split('.');
  let o = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (o[keys[i]] === undefined || o[keys[i]] === null) o[keys[i]] = /^\d+$/.test(keys[i + 1]) ? [] : {};
    o = o[keys[i]];
  }
  o[keys[keys.length - 1]] = value;
}

async function api(method, path, body) {
  const res = await fetch('/api' + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !String(path).startsWith('/auth/')) signInScreen('Your session has ended. Sign in again.');
  if (!res.ok) {
    const err = new Error(data.error || res.statusText);
    err.status = res.status;
    err.details = data.details;
    throw err;
  }
  return data;
}

function toast(text, level = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${level}`;
  el.textContent = text;
  document.getElementById('toasts').appendChild(el);
  setTimeout(() => el.remove(), level === 'error' ? 7000 : 3500);
}

function reportError(err) {
  toast(err.message, 'error');
  const errors = err.details && err.details.errors;
  const target = document.querySelector('.form-errors');
  if (errors && target) target.innerHTML = errorList(errors, err.message);
}

const errorList = (errors, title) => `<div class="banner error"><strong>${esc(title)}</strong><ul>${errors.map((e) => `<li>${esc(e.message)}</li>`).join('')}</ul></div>`;
const notice = (n) => (n ? `<div class="banner ${esc(n.level)}">${esc(n.text)}</div>` : '');
const view = (html) => { document.getElementById('app').innerHTML = html; };
const field = (label, control, cls = '') => `<label class="field ${cls}"><span>${esc(label)}</span>${control}</label>`;

function openModal(html, wide = false) {
  const m = document.getElementById('modal');
  m.innerHTML = `<div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">${html}</div>`;
  m.hidden = false;
  const first = m.querySelector('input, select, textarea, button');
  if (first) first.focus();
}
function closeModal() {
  const m = document.getElementById('modal');
  m.hidden = true;
  m.innerHTML = '';
}

function table(headers, rows, empty = 'Nothing to show') {
  if (!rows.length) return `<div class="empty">${esc(empty)}</div>`;
  return `<div class="table-wrap"><table class="list"><thead><tr>${headers.map((h) => `<th class="${h.startsWith('$') ? 'num' : ''}">${esc(h.replace(/^\$/, ''))}</th>`).join('')}</tr></thead>
    <tbody>${rows.map((r) => `<tr>${r.map((c, i) => `<td class="${headers[i].startsWith('$') ? 'num' : ''}">${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

const jobLink = (j) => `<a href="#/job/${j.id}">${esc(j.jobNumber)}</a>`;
const policyLink = (p) => (p && p.policyNumber ? `<a href="#/policy/${p.policyId || p.id}">${esc(p.policyNumber)}</a>` : '—');
const accountLink = (id, name) => `<a href="#/account/${id}">${esc(name)}</a>`;
const productLabel = (code, form) => esc(product(code).name) + (form ? ` <span class="muted">${esc(form)}</span>` : '');

// ------------------------------------------------------------------ router

const ROUTES = [
  [/^#\/desktop$/, pageDesktop],
  [/^#\/accounts$/, pageAccounts],
  [/^#\/accounts\/new$/, () => pageAccountForm(null)],
  [/^#\/account\/([^/]+)\/edit$/, (id) => pageAccountForm(id)],
  [/^#\/account\/([^/]+)$/, pageAccount],
  [/^#\/policies$/, pagePolicies],
  [/^#\/policy\/([^/]+)$/, pagePolicy],
  [/^#\/job\/([^/]+)$/, pageJob],
  [/^#\/search\/(.*)$/, pageSearch],
  [/^#\/sales$/, pageSales],
  [/^#\/staff$/, pageStaff],
  [/^#\/finance$/, pageFinance],
  [/^#\/insights$/, pageInsights],
  [/^#\/admin$/, pageAdmin],
];

async function router() {
  const hash = location.hash && location.hash !== '#/' ? location.hash : '#/desktop';
  document.querySelectorAll('.mainnav a').forEach((a) => a.classList.toggle('active', hash.startsWith('#/' + a.dataset.nav)));
  closeModal();
  for (const [re, fn] of ROUTES) {
    const m = hash.match(re);
    if (!m) continue;
    try {
      await fn(...m.slice(1).map(decodeURIComponent));
    } catch (err) {
      view(`<div class="banner error">${esc(err.message)}</div>`);
    }
    window.scrollTo(0, 0);
    return;
  }
  view('<div class="card"><h2>Page not found</h2><a href="#/desktop">Back to desktop</a></div>');
}

// ------------------------------------------------------------------ desktop

async function pageDesktop() {
  const d = await api('GET', '/desktop');
  const u = me();
  view(`
    <div class="spread"><div><div class="eyebrow">Desktop</div><h1>Welcome, ${esc(u.name)} <span class="badge">${esc(u.role)}</span></h1></div>
      <div class="toolbar"><a class="btn primary" href="#/accounts/new">New account</a></div></div>
    <div class="tiles">
      <div class="tile accent"><div class="label">Policies in force</div><div class="value">${d.stats.inForce}</div></div>
      <div class="tile"><div class="label">In-force term premium</div><div class="value">${money(d.stats.inForcePremium)}</div></div>
      <div class="tile"><div class="label">Open jobs</div><div class="value">${d.stats.openJobs}</div></div>
      <div class="tile"><div class="label">${u.role === 'Agent' ? 'Open referrals' : 'My referrals'}</div><div class="value">${d.stats.openReferrals}</div></div>
    </div>
    <div class="card"><h2>${u.role === 'Agent' ? 'Referrals on my accounts' : 'My activities'}</h2>
      ${table(['Activity', 'Subject', 'Job', 'Priority', 'Assigned to', 'Due', ''], d.activities.map((a) => [
        esc(a.activityNumber),
        `${esc(a.subject)}<div class="muted" style="white-space:pre-line">${esc(a.description)}</div>`,
        `<a href="#/job/${a.jobId}">${esc(a.jobNumber)}</a>`,
        badge(a.priority), esc(a.assignedToName || a.assignedTo), esc(a.dueDate),
        u.role === 'Agent' ? '' : `<button class="btn small" data-action="complete-activity" data-id="${a.id}">Complete</button>`,
      ]), 'No open activities')}
    </div>
    <div class="grid two">
      <div class="card"><h2>Open jobs</h2>
        ${table(['Job', 'Type', 'Account', 'Product', 'Status', '$Amount'], d.openJobs.map((j) => [jobLink(j), esc(j.type), accountLink(j.accountId, j.accountName), productLabel(j.product), badge(j.status), money(j.amount)]), 'No open jobs')}
      </div>
      <div class="card"><h2>Recent policies</h2>
        ${table(['Policy', 'Insured', 'Product', 'Status', '$Term premium'], d.recentPolicies.map((p) => [policyLink(p), accountLink(p.accountId, p.insuredName), productLabel(p.product, p.form), badge(p.status), money(p.termPremium)]), 'No policies yet')}
      </div>
    </div>`);
}

// ------------------------------------------------------------------ accounts

async function pageAccounts() {
  const q = S.accountQuery || '';
  const list = await api('GET', '/accounts?q=' + encodeURIComponent(q));
  view(`
    <div class="spread"><div><div class="eyebrow">Accounts</div><h1>Accounts</h1></div>
      <a class="btn primary" href="#/accounts/new">New account</a></div>
    <div class="card">
      <form class="toolbar" data-form="account-search" style="margin-bottom:12px">
        <input name="q" value="${esc(q)}" placeholder="Name, account number, city or ZIP" style="flex:1;max-width:360px">
        <button class="btn">Search</button>
      </form>
      ${table(['Account', 'Name', 'Address', 'Producer', 'Policies'], list.map((a) => [
        `<a href="#/account/${a.id}">${esc(a.accountNumber)}</a>`, esc(a.name),
        `${esc(a.address.line1)}, ${esc(a.address.city)}, ${esc(a.address.state)} ${esc(a.address.zip)}`, esc(a.producerCode), a.policyCount,
      ]), 'No accounts match')}
    </div>`);
}

async function pageAccountForm(id) {
  const a = id ? (await api('GET', `/accounts/${id}`)).account : { address: { state: me().role === 'Agent' ? 'TX' : 'TX' }, producerCode: me().producerCode || 'PC-100' };
  const agent = me().role === 'Agent';
  const v = (k) => esc(k.split('.').reduce((o, p) => (o ? o[p] : ''), a) ?? '');
  view(`
    <div class="eyebrow">${id ? 'Edit account' : 'New account'}</div><h1>${id ? esc(a.name) : 'Create account'}</h1>
    <form class="card" data-form="account" data-id="${id || ''}">
      <div class="form-errors"></div>
      <h3>Primary named insured</h3>
      <div class="form-grid">
        ${field('First name', `<input name="firstName" value="${v('firstName')}" required>`)}
        ${field('Last name', `<input name="lastName" value="${v('lastName')}" required>`)}
        ${field('Date of birth', `<input name="dob" type="date" value="${v('dob')}" required>`)}
        ${field('Email', `<input name="email" type="email" value="${v('email')}">`)}
        ${field('Phone', `<input name="phone" value="${v('phone')}">`)}
      </div>
      <h3>Mailing address</h3>
      <div class="form-grid">
        ${field('Street', `<input name="address.line1" value="${v('address.line1')}" required>`)}
        ${field('City', `<input name="address.city" value="${v('address.city')}" required>`)}
        ${field('State', `<select name="address.state">${Object.entries(S.meta.states).map(([c, n]) => `<option value="${c}" ${sel(c, a.address.state)}>${esc(n)}</option>`).join('')}</select>`)}
        ${field('ZIP', `<input name="address.zip" value="${v('address.zip')}" pattern="\\d{5}" required>`)}
      </div>
      <h3>Producer</h3>
      <div class="form-grid">
        ${field('Producer code', `<select name="producerCode" ${agent ? 'disabled' : ''}>${S.meta.producerCodes.map((p) => `<option value="${p.code}" ${sel(p.code, a.producerCode)}>${esc(p.code)} – ${esc(p.name)}</option>`).join('')}</select>`)}
      </div>
      <div class="toolbar" style="margin-top:18px"><button class="btn primary">${id ? 'Save account' : 'Create account'}</button>
        <a class="btn" href="${id ? `#/account/${id}` : '#/accounts'}">Cancel</a></div>
    </form>`);
}

async function pageAccount(id) {
  const d = await api('GET', `/accounts/${id}`);
  const a = d.account;
  view(`
    <div class="spread"><div><div class="eyebrow">Account ${esc(a.accountNumber)}</div><h1>${esc(a.name)}</h1>
      <div class="meta-row">${esc(a.address.line1)}, ${esc(a.address.city)}, ${esc(a.address.state)} ${esc(a.address.zip)} · ${esc(a.producerCode)} ${esc(a.producerName || '')}</div></div>
      <div class="toolbar"><a class="btn" href="#/account/${a.id}/edit">Edit account</a>
        <button class="btn primary" data-action="new-submission" data-account="${a.id}">New submission</button></div></div>
    <div class="grid two">
      <div class="card"><h2>Account holder</h2><dl class="facts">
        <dt>Date of birth</dt><dd>${esc(a.dob)}</dd><dt>Email</dt><dd>${esc(a.email || '—')}</dd><dt>Phone</dt><dd>${esc(a.phone || '—')}</dd>
        <dt>Created</dt><dd>${when(a.createdAt)}</dd></dl></div>
      <div class="card"><h2>Policies</h2>
        ${table(['Policy', 'Product', 'Status', 'Term', '$Term premium'], d.policies.map((p) => [policyLink(p), productLabel(p.product, p.form), badge(p.status), `${esc(p.effectiveDate)} → ${esc(p.expirationDate)}`, money(p.termPremium)]), 'No policies yet. Start a submission.')}
      </div>
    </div>
    <div class="card"><h2>Policy transactions (jobs)</h2>
      ${table(['Job', 'Type', 'Product', 'Policy', 'Effective', 'Status', '$Amount', 'Updated'], d.jobs.map((j) => [jobLink(j), esc(j.type), productLabel(j.product), policyLink(j), esc(j.effectiveDate), badge(j.status), money(j.amount), when(j.updatedAt)]), 'No jobs')}
    </div>
    ${messagesCard({ accountId: a.id, list: d.messages })}`);
}

// ------------------------------------------------------------------ customer messages

function composeBody(form) {
  const fd = new FormData(form);
  const body = { accountId: form.dataset.id, channel: fd.get('channel'), template: fd.get('template'), language: fd.get('language') };
  if (fd.get('policyId')) body.policyId = fd.get('policyId');
  if (fd.get('claimId')) body.claimId = fd.get('claimId');
  return body;
}

async function composeModal(accountId) {
  const [acct, status, claims] = await Promise.all([api('GET', `/accounts/${accountId}`), api('GET', '/messages/status'), api('GET', '/claims')]);
  const policyNumbers = new Set(acct.policies.map((p) => p.policyNumber));
  const mine = claims.filter((c) => policyNumbers.has(c.policyNumber));
  const chOpts = ['email', 'whatsapp'].map((c) => {
    const st = status.channels[c] || { enabled: false };
    return `<option value="${c}">${c === 'email' ? 'Email' : 'WhatsApp'}${st.enabled ? '' : ' (not set up)'}</option>`;
  }).join('');
  const tplOpts = status.templates.map((t) => `<option value="${t.key}">${esc(t.label)}</option>`).join('');
  openModal(`<h2>Send message to ${esc(acct.account.name)}</h2>
    <form data-form="compose-message" data-id="${esc(accountId)}">
      <div class="form-errors"></div>
      <div class="form-grid">
        ${field('Channel', `<select name="channel">${chOpts}</select>`)}
        ${field('Template', `<select name="template">${tplOpts}</select>`)}
        ${field('Language', '<select name="language"><option value="en">English</option><option value="hi">हिंदी (Hindi)</option><option value="te">తెలుగు (Telugu)</option></select>')}
        ${field('Policy', `<select name="policyId"><option value="">Choose a policy</option>${acct.policies.map((p) => `<option value="${esc(p.id)}">${esc(p.policyNumber)} · ${esc(p.product)}</option>`).join('')}</select>`)}
        ${field('Claim (for claim updates)', `<select name="claimId"><option value="">None</option>${mine.map((c) => `<option value="${esc(c.id)}">${esc(c.claimNumber)} · ${esc(c.status)}</option>`).join('')}</select>`)}
      </div>
      <div class="toolbar" style="margin:12px 0"><button type="button" class="btn" data-action="message-preview">Preview message</button></div>
      <div id="msg-preview" class="card" style="background:var(--surface-2)" hidden></div>
      <label class="field check"><input type="checkbox" name="confirm"> <span>I have checked the recipient and the message</span></label>
      <div class="actions"><button type="button" class="btn" data-action="close-modal">Cancel</button><button class="btn primary">Send message</button></div>
    </form>`, true);
}

function messagesCard(messages) {
  return `<div class="card"><div class="spread"><h2>Messages</h2><button class="btn small primary" data-action="compose-message" data-account="${messages.accountId}">Send message</button></div>
    ${table(['Sent', 'Channel', 'Template', 'Language', 'To', 'Status', 'By', 'Message'], messages.list.map((m) => [
      when(m.sentAt), esc(m.channel), esc(m.template), esc(m.language), esc(m.to || '—'), badge(m.status === 'Sent' ? 'Delivered' : m.status),
      esc(m.sentByName), `<div style="white-space:pre-wrap;max-width:360px">${m.subject ? `<strong>${esc(m.subject)}</strong><br>` : ''}${esc(m.body)}${m.error ? `<br><span class="muted">Error: ${esc(m.error)}</span>` : ''}</div>`,
    ]), 'No messages yet')}
  </div>`;
}

function newSubmissionModal(accountId) {
  openModal(`
    <h2>New submission</h2>
    <form data-form="new-submission" data-account="${accountId}">
      <div class="form-errors"></div>
      <div class="form-grid">
        ${field('Product', `<select name="product">${Object.values(S.meta.products).map((p) => `<option value="${p.code}">${esc(p.name)} (${p.termMonths}-month term)</option>`).join('')}</select>`)}
        ${field('Effective date', `<input name="effectiveDate" type="date" value="${S.meta.today}" required>`)}
      </div>
      <div class="actions"><button type="button" class="btn" data-action="close-modal">Cancel</button><button class="btn primary">Start submission</button></div>
    </form>`);
}

// ------------------------------------------------------------------ policies

async function pagePolicies() {
  const q = S.policyQuery || '';
  const list = await api('GET', '/policies?q=' + encodeURIComponent(q));
  view(`
    <div class="eyebrow">Policies</div><h1>Policies</h1>
    <div class="card">
      <form class="toolbar" data-form="policy-search" style="margin-bottom:12px">
        <input name="q" value="${esc(q)}" placeholder="Policy number, insured, product or status" style="flex:1;max-width:360px">
        <button class="btn">Search</button>
      </form>
      ${table(['Policy', 'Insured', 'Product', 'Status', 'Term', 'Effective', 'Expiration', '$Term premium'], list.map((p) => [
        policyLink(p), accountLink(p.accountId, p.insuredName), productLabel(p.product, p.form), badge(p.status), p.termNumber, esc(p.effectiveDate), esc(p.expirationDate), money(p.termPremium),
      ]), 'No policies match')}
    </div>`);
}

async function pagePolicy(id) {
  S.policy = await api('GET', `/policies/${id}`);
  renderPolicy();
}

function renderPolicy() {
  const p = S.policy;
  const cancelled = !!p.cancellation;
  const tabs = [['summary', 'Summary'], ['transactions', 'Transactions'], ['billing', 'Billing'], ['documents', 'Documents'], ['history', 'History'], ['events', 'Integration events']];
  const actions = [];
  if (p.openJob) actions.push(`<a class="btn" href="#/job/${p.openJob.id}">Open ${esc(p.openJob.type)} ${esc(p.openJob.jobNumber)}</a>`);
  if (!cancelled && !p.openJob) {
    actions.push(`<button class="btn" data-action="policy-change">Change policy</button>`);
    actions.push(`<button class="btn" data-action="policy-renew">Renew</button>`);
    actions.push(`<button class="btn danger" data-action="policy-cancel">Cancel policy</button>`);
  }
  if (cancelled && !p.openJob) actions.push(`<button class="btn primary" data-action="policy-reinstate">Reinstate</button>`);

  view(`
    <div class="spread"><div><div class="eyebrow">${productLabel(p.product, p.form)} · Term ${p.termNumber}</div>
      <h1>${esc(p.policyNumber)} ${badge(p.status)}</h1>
      <div class="meta-row">Insured ${accountLink(p.account.id, p.account.name)} (${esc(p.account.accountNumber)}) · ${esc(p.effectiveDate)} → ${esc(p.expirationDate)} · Producer ${esc(p.account.producerCode)}</div></div>
      <div class="toolbar">${actions.join('')}</div></div>
    ${cancelled ? `<div class="banner error">Cancelled effective ${esc(p.cancellation.effectiveDate)}: ${esc(p.cancellation.reasonName)} (${esc(p.cancellation.method)}), return premium ${money(-p.cancellation.refund)}.</div>` : ''}
    <div class="tiles">
      <div class="tile accent"><div class="label">Term premium (incl. tax)</div><div class="value">${money(p.termPremium)}</div></div>
      <div class="tile"><div class="label">Written premium to date</div><div class="value">${money(p.writtenPremium)}</div></div>
      <div class="tile"><div class="label">Policy versions</div><div class="value">${p.versions.length}</div></div>
      <div class="tile"><div class="label">Rate book</div><div class="value" style="font-size:16px">${esc(p.current.quote.rateBook.code)} ${esc(p.current.quote.rateBook.version)}</div></div>
    </div>
    <div class="card">
      <div class="tabs">${tabs.map(([k, n]) => `<button class="${S.policyTab === k ? 'active' : ''}" data-action="policy-tab" data-tab="${k}">${n}</button>`).join('')}</div>
      ${POLICY_TABS[S.policyTab](p)}
    </div>`);
}

const BILLING_HIDDEN = '<div class="empty">Billing is visible to UW managers only.</div>';

const POLICY_TABS = {
  summary: (p) => `<div class="muted" style="margin-bottom:10px">Showing version from ${esc(p.current.jobType)} ${esc(p.current.jobNumber)}, effective ${esc(p.current.editEffectiveDate)}</div>${periodSummary(p.product, p.current.period)}`,
  transactions: (p) => p.billingHidden ? BILLING_HIDDEN : table(['Posted', 'Job', 'Type', 'Effective', 'Description', '$Amount'], p.transactions.map((t) => [
    when(t.postedAt), esc(t.jobNumber), esc(t.jobType), esc(t.effectiveDate), esc(t.description), `<span class="${t.amount < 0 ? 'neg' : ''}">${money(t.amount)}</span>`,
  ])) + `<div class="spread" style="margin-top:10px"><span></span><strong>Written premium: ${money(p.writtenPremium)}</strong></div>`,
  billing: (p) => {
    if (p.billingHidden) return BILLING_HIDDEN;
    const total = p.invoices.reduce((s, i) => s + i.amount + i.fee, 0);
    return `<div class="muted" style="margin-bottom:10px">Simulated BillingCenter invoice stream for this policy.</div>`
      + table(['Invoice', 'Due', 'Job', 'Description', 'Status', '$Amount', '$Fee'], p.invoices.map((i) => [
        esc(i.invoiceNumber), esc(i.dueDate), esc(i.jobNumber), esc(i.description), badge(i.status), money(i.amount), money(i.fee),
      ])) + `<div class="spread" style="margin-top:10px"><span></span><strong>Total billed and planned: ${money(total)}</strong></div>`;
  },
  documents: (p) => table(['Document', 'Name', 'Job', 'Created', ''], p.documents.map((d) => [
    esc(d.documentNumber), esc(d.name), esc(d.jobNumber), when(d.createdAt), `<button class="btn small" data-action="view-doc" data-id="${d.id}">View</button>`,
  ]), 'No documents'),
  history: (p) => p.terms.map((t) => `<h3>Term ${t.termNumber}: ${esc(t.effectiveDate)} → ${esc(t.expirationDate)}</h3>`
    + table(['Version job', 'Type', 'Effective', '$Term total', 'Bound'], t.versions.map((v) => [esc(v.jobNumber), esc(v.jobType), esc(v.editEffectiveDate), money(v.total), when(v.boundAt)]))).join('')
    + '<h3>All jobs on this policy</h3>'
    + table(['Job', 'Type', 'Effective', 'Status', '$Amount'], p.jobs.map((j) => [jobLink(j), esc(j.type), esc(j.effectiveDate), badge(j.status), money(j.amount)])),
  events: (p) => eventsTable(p.events),
};

function eventsTable(events) {
  return table(['Event', 'Type', 'Topic', 'Occurred', 'Status', 'Payload'], events.map((e) => [
    esc(e.eventId), esc(e.type), esc(e.topic), when(e.occurredAt), badge(e.status), `<pre class="payload">${esc(JSON.stringify(e.payload, null, 1))}</pre>`,
  ]), 'No events');
}

// Coverage summary shared by the policy file and the declarations page.
function termText(def, cov) {
  return def.terms
    .filter((t) => cov.terms[t.code] !== undefined)
    .map((t) => {
      const v = cov.terms[t.code];
      const label = t.type === 'option' ? (t.options.find((o) => o.value === String(v)) || {}).label || v : usd0(v);
      return def.terms.length > 1 ? `${t.name}: ${label}` : label;
    }).join(' · ') || 'Included';
}

function coverageRows(defs, map) {
  return defs.filter((d) => map && map[d.code] && map[d.code].selected).map((d) => [esc(d.name), esc(termText(d, map[d.code]))]);
}

function periodSummary(productCode, period) {
  const pm = product(productCode);
  if (productCode === 'PersonalAuto') {
    const { drivers, vehicles, lineCoverages } = period.line;
    return `<h3>Drivers</h3>${table(['Name', 'Date of birth', 'License', 'Years licensed', 'Accidents', 'Violations', 'Good student'], drivers.map((d) => [
      esc(`${d.firstName} ${d.lastName}`), esc(d.dob), esc(`${d.licenseState} ${d.licenseNumber}`), d.yearsLicensed, d.accidents, d.violations, d.goodStudent ? 'Yes' : 'No',
    ]))}
      <h3>Policy-level coverages (apply to each vehicle)</h3>${table(['Coverage', 'Limit'], coverageRows(pm.lineCoverages, lineCoverages))}
      ${vehicles.map((v, i) => `<h3>Vehicle ${i + 1}: ${esc(`${v.year} ${v.make} ${v.model}`)}</h3>
        <div class="muted" style="margin-bottom:6px">VIN ${esc(v.vin)} · ${esc(v.usage)} · ${Number(v.annualMiles || 0).toLocaleString()} mi/yr · value ${usd0(v.marketValue)} · garaged ${esc(v.garagingZip)}</div>
        ${table(['Coverage', 'Deductible / limit'], coverageRows(pm.vehicleCoverages, v.coverages), 'Liability only')}`).join('')}`;
  }
  const { form, dwelling: d, coverages } = period.line;
  const formName = pm.forms.find((f) => f.code === form).name;
  return `<h3>Dwelling: ${esc(formName)}</h3>
    <dl class="facts">
      <dt>Location</dt><dd>${esc(`${d.line1}, ${d.city}, ${period.state} ${d.zip}`)}</dd>
      <dt>Construction</dt><dd>${esc(d.construction)}, built ${esc(d.yearBuilt)}, ${Number(d.squareFeet || 0).toLocaleString()} sq ft${form === 'HO3' || form === 'HO5' ? `, roof ${esc(d.roofAge)} yrs` : ''}</dd>
      <dt>Protection</dt><dd>Class ${esc(d.protectionClass)}, ${esc(d.distanceToFireStation)} mi to fire station, ${esc(d.alarm)} alarm${d.sprinklers ? ', sprinklered' : ''}</dd>
      <dt>Hazards</dt><dd>${[d.pool && (d.poolFenced ? 'Fenced pool' : 'Unfenced pool'), d.trampoline && 'Trampoline', d.aggressiveDog && 'Animal liability exposure'].filter(Boolean).join(', ') || 'None reported'}</dd>
      <dt>Prior claims (5 yrs)</dt><dd>${esc(d.priorClaims)}</dd>
    </dl>
    <h3>Coverages</h3>${table(['Coverage', 'Limit / deductible'], coverageRows(pm.coverages, coverages))}`;
}

function costTable(quote) {
  const groups = [];
  for (const c of quote.costs) {
    let g = groups.find((x) => x.name === c.coverable);
    if (!g) groups.push((g = { name: c.coverable, costs: [] }));
    g.costs.push(c);
  }
  return `<div class="cost-head"><span>Coverage / item</span><span>Limit / deductible</span><span class="num">Amount</span></div>`
    + groups.map((g) => `<div class="cost-group">${esc(g.name)}</div>` + g.costs.map((c) => `
      <details class="cost"><summary><span>${esc(c.coverageName)}</span><span class="muted">${esc(c.termValue || '')}</span><span class="num ${c.amount < 0 ? 'neg' : ''}">${money(c.amount)}</span></summary>
        <table class="ws">${c.worksheet.map((s, i) => `<tr><td>${i === 0 ? '' : '×'}</td><td>${esc(s.label)}</td><td class="num">${s.factor}</td><td class="num">${s.running.toFixed(4)}</td></tr>`).join('')}</table>
      </details>`).join('')).join('');
}

function docModal(id) {
  const p = S.policy;
  const doc = p.documents.find((d) => d.id === id);
  const version = doc.versionId ? p.versions.find((v) => v.versionId === doc.versionId) : null;
  let body;
  if (version) {
    const q = version.quote;
    body = `<dl class="facts">
        <dt>Named insured</dt><dd>${esc(version.period.insured.name)}<br>${esc(`${version.period.insured.address.line1}, ${version.period.insured.address.city}, ${version.period.insured.address.state} ${version.period.insured.address.zip}`)}</dd>
        <dt>Policy period</dt><dd>${esc(version.effectiveDate)} to ${esc(version.expirationDate)}, 12:01 a.m. standard time</dd>
        <dt>Transaction</dt><dd>${esc(version.jobType)} ${esc(version.jobNumber)}, effective ${esc(version.editEffectiveDate)}</dd>
        <dt>Producer</dt><dd>${esc(version.period.producerCode)}</dd>
        <dt>Payment plan</dt><dd>${esc(version.period.paymentPlan)}</dd>
      </dl>
      ${periodSummary(p.product, version.period)}
      <h3>Premium</h3>${costTable(q)}
      <div class="spread" style="margin-top:12px"><span>Rate book ${esc(q.rateBook.code)} ${esc(q.rateBook.version)}</span><strong>Total term cost: ${money(q.total)}</strong></div>`;
  } else {
    const c = p.cancellation || (p.reinstatements[p.reinstatements.length - 1] || {}).cancellation || {};
    body = `<p>${esc(doc.name)} for policy ${esc(p.policyNumber)} issued to ${esc(p.account.name)}.</p>
      <dl class="facts"><dt>Job</dt><dd>${esc(doc.jobNumber)}</dd><dt>Cancellation effective</dt><dd>${esc(c.effectiveDate || '—')}</dd>
      <dt>Reason</dt><dd>${esc(c.reasonName || '—')}</dd><dt>Return premium</dt><dd>${c.refund ? money(-c.refund) : '—'}</dd></dl>`;
  }
  openModal(`<div class="dec">
      <div class="dec-head"><div class="eyebrow">Simulated Mutual Insurance Company</div><h2>${esc(doc.name)}</h2>
        <div>${esc(product(p.product).name)} policy <strong>${esc(p.policyNumber)}</strong> · ${esc(doc.documentNumber)}</div></div>
      ${body}</div>
    <div class="actions no-print"><button class="btn" data-action="print">Print</button><button class="btn primary" data-action="close-modal">Close</button></div>`, true);
}

// ------------------------------------------------------------------ job wizard

async function pageJob(id) {
  const job = await api('GET', `/jobs/${id}`);
  const keepStep = S.jv && S.jv.job.id === job.id ? S.jv.step : null;
  setJob(job);
  const steps = jobSteps(job).map((s) => s[0]);
  S.jv.step = keepStep && steps.includes(keepStep) ? keepStep : job.quote && steps.includes('quote') ? 'quote' : steps[0];
  renderJob();
}

function setJob(job) {
  S.jv = { ...(S.jv && S.jv.job.id === job.id ? S.jv : { step: null }), job, draft: clone({ effectiveDate: job.period.effectiveDate, paymentPlan: job.period.paymentPlan, line: job.period.line }), dirty: false };
}

const isEditable = (job) => OPEN.includes(job.status) && EDITABLE_TYPES.includes(job.type);

function jobSteps(job) {
  if (!EDITABLE_TYPES.includes(job.type)) return [['summary', 'Summary']];
  if (job.product === 'PersonalAuto') return [['info', 'Policy info'], ['drivers', 'Drivers'], ['vehicles', 'Vehicles'], ['coverages', 'Coverages'], ['risk', 'Risk analysis'], ['quote', 'Quote']];
  return [['info', 'Policy info'], ['dwelling', 'Dwelling'], ['coverages', 'Coverages'], ['risk', 'Risk analysis'], ['quote', 'Quote']];
}

async function saveDraft() {
  if (!S.jv.dirty) return;
  const job = await api('PUT', `/jobs/${S.jv.job.id}/period`, S.jv.draft);
  setJob(job);
}

function renderJob() {
  const { job, draft, step } = S.jv;
  const editable = isEditable(job);
  const steps = jobSteps(job);
  const q = job.quote;
  const amountLabel = job.type === 'PolicyChange' ? 'Change in premium' : job.type === 'Cancellation' ? 'Return premium' : job.type === 'Reinstatement' ? 'Premium restored' : 'Total cost';
  const bindLabel = { Submission: 'Bind & issue', PolicyChange: 'Bind change', Renewal: 'Bind renewal', Cancellation: 'Bind cancellation', Reinstatement: 'Reinstate policy' }[job.type];
  const u = me();
  const buttons = [];
  if (editable) buttons.push('<button class="btn" data-action="job-save">Save draft</button>', '<button class="btn primary" data-action="job-quote">Quote</button>');
  if (job.status === 'Quoted') buttons.push(`<button class="btn success" data-action="job-bind">${bindLabel}</button>`);
  if (job.type === 'Submission' && OPEN.includes(job.status) && u.authority >= 1) buttons.push('<button class="btn danger" data-action="job-decline">Decline</button>');
  if (OPEN.includes(job.status)) buttons.push('<button class="btn" data-action="job-withdraw">Withdraw</button>');
  if (job.status === 'Bound' && job.policyId) buttons.push(`<a class="btn primary" href="#/policy/${job.policyId}">Go to policy</a>`);

  view(`
    <div class="card job-header">
      <div><div class="eyebrow">${esc(job.type)} · ${productLabel(job.product, job.product === 'Homeowners' ? draft.line.form : '')}</div>
        <h1>${esc(job.jobNumber)} ${badge(job.status)}</h1>
        <div class="meta-row">Account ${accountLink(job.account.id, job.account.name)} (${esc(job.account.accountNumber)})${job.policy ? ` · Policy ${policyLink(job.policy)}` : ''}
          · Term ${job.period.termNumber}: ${esc(job.period.effectiveDate)} → ${esc(job.period.expirationDate)}${job.type !== 'Submission' && job.type !== 'Renewal' ? ` · Effective ${esc(job.period.editEffectiveDate)}` : ''}</div></div>
      <div class="header-total"><div class="eyebrow">${amountLabel}</div><div class="value">${q ? money(q.changeAmount) : '—'}</div>${q && q.rateBook ? `<div class="muted">Rate book ${esc(q.rateBook.version)}</div>` : ''}</div>
    </div>
    ${notice(job.notice)}
    ${S.jv.errors ? errorList(S.jv.errors, 'Fix these before quoting') : ''}
    <div class="wizard">
      <nav class="steps">${steps.map(([k, n], i) => `<button class="${step === k ? 'active' : ''}" data-action="job-step" data-step="${k}"><span class="n">${i + 1}</span>${n}${k === 'risk' && job.uwIssues && job.uwIssues.some((x) => !x.approved) ? ' <span class="badge b-pending">!</span>' : ''}</button>`).join('')}</nav>
      <section class="card step-body">${STEPS[step](job, draft, editable)}</section>
    </div>
    <div class="footer-bar">${buttons.join('')}</div>`);
}

const STEPS = {
  info(job, draft, editable) {
    const pm = product(job.product);
    const p = job.period;
    const isSub = job.type === 'Submission';
    return `<h2>Policy info</h2>
      <div class="form-grid">
        ${field('Named insured', `<input value="${esc(p.insured.name)}" disabled>`)}
        ${field('Base state', `<input value="${esc(S.meta.states[p.state])}" disabled>`)}
        ${field('Producer code', `<input value="${esc(p.producerCode)}" disabled>`)}
        ${field('Term', `<input value="${pm.termMonths} months" disabled>`)}
        ${field('Effective date', `<input type="date" data-bind="effectiveDate" data-save value="${esc(draft.effectiveDate)}" ${dis(editable && isSub)}>`)}
        ${field('Expiration date', `<input value="${esc(p.expirationDate)}" disabled>`)}
        ${field('Payment plan', `<select data-bind="paymentPlan" ${dis(editable && job.type !== 'PolicyChange')}>${pm.paymentPlans.map((pl) => `<option value="${pl.code}" ${sel(pl.code, draft.paymentPlan)}>${esc(pl.name)}${pl.installmentFee ? ` ($${pl.installmentFee} fee each)` : ''}</option>`).join('')}</select>`)}
        ${job.product === 'Homeowners' ? field('Policy form', `<select data-bind="line.form" data-save ${dis(editable)}>${pm.forms.map((f) => `<option value="${f.code}" ${sel(f.code, draft.line.form)}>${esc(f.name)}</option>`).join('')}</select>`) : ''}
      </div>
      ${job.type === 'PolicyChange' ? `<div class="banner info" style="margin-top:16px">Policy change effective ${esc(p.editEffectiveDate)}. The premium difference is pro-rated over the ${daysLeft(p)} days left in the term.</div>` : ''}
      ${job.type === 'Renewal' ? `<div class="banner info" style="margin-top:16px">Renewal term ${p.termNumber}. Rating uses the rate book in effect on ${esc(p.effectiveDate)}; drivers' ages and vehicle ages are recalculated.</div>` : ''}`;
  },

  drivers(job, draft, editable) {
    const drivers = draft.line.drivers;
    return `<div class="spread"><h2>Drivers</h2>${editable ? '<button class="btn" data-action="add-driver">Add driver</button>' : ''}</div>
      ${drivers.length ? '' : '<div class="empty">No drivers yet.</div>'}
      ${drivers.map((d, i) => {
        const b = (f) => `line.drivers.${i}.${f}`;
        return `<fieldset><legend>Driver ${i + 1}${d.firstName ? `: ${esc(d.firstName)} ${esc(d.lastName)}` : ''}</legend>
          <div class="form-grid">
            ${field('First name', `<input data-bind="${b('firstName')}" value="${esc(d.firstName)}" ${dis(editable)}>`)}
            ${field('Last name', `<input data-bind="${b('lastName')}" value="${esc(d.lastName)}" ${dis(editable)}>`)}
            ${field('Date of birth', `<input type="date" data-bind="${b('dob')}" value="${esc(d.dob)}" ${dis(editable)}>`)}
            ${field('License number', `<input data-bind="${b('licenseNumber')}" value="${esc(d.licenseNumber)}" ${dis(editable)}>`)}
            ${field('License state', `<input data-bind="${b('licenseState')}" value="${esc(d.licenseState)}" maxlength="2" ${dis(editable)}>`)}
            ${field('Years licensed', `<input type="number" min="0" data-type="number" data-bind="${b('yearsLicensed')}" value="${esc(d.yearsLicensed)}" ${dis(editable)}>`)}
            ${field('At-fault accidents (3 yrs)', `<input type="number" min="0" data-type="number" data-bind="${b('accidents')}" value="${esc(d.accidents)}" ${dis(editable)}>`)}
            ${field('Violations (3 yrs)', `<input type="number" min="0" data-type="number" data-bind="${b('violations')}" value="${esc(d.violations)}" ${dis(editable)}>`)}
            ${field('Good student (under 25)', `<input type="checkbox" data-bind="${b('goodStudent')}" ${d.goodStudent ? 'checked' : ''} ${dis(editable)}>`, 'check')}
          </div>
          ${editable && drivers.length > 1 ? `<div style="margin-top:10px"><button class="btn small danger" data-action="remove-driver" data-index="${i}">Remove driver</button></div>` : ''}
        </fieldset>`;
      }).join('')}`;
  },

  vehicles(job, draft, editable) {
    const vehicles = draft.line.vehicles;
    return `<div class="spread"><h2>Vehicles</h2>${editable ? '<button class="btn" data-action="add-vehicle">Add vehicle</button>' : ''}</div>
      ${vehicles.length ? '' : '<div class="empty">No vehicles yet. Add one to continue.</div>'}
      ${vehicles.map((v, i) => {
        const b = (f) => `line.vehicles.${i}.${f}`;
        return `<fieldset><legend>Vehicle ${i + 1}${v.make ? `: ${esc(v.year)} ${esc(v.make)} ${esc(v.model)}` : ''}</legend>
          <div class="form-grid">
            ${field('Model year', `<input type="number" data-type="number" data-bind="${b('year')}" value="${esc(v.year)}" ${dis(editable)}>`)}
            ${field('Make', `<input data-bind="${b('make')}" value="${esc(v.make)}" ${dis(editable)}>`)}
            ${field('Model', `<input data-bind="${b('model')}" value="${esc(v.model)}" ${dis(editable)}>`)}
            ${field('VIN', `<input data-bind="${b('vin')}" value="${esc(v.vin)}" maxlength="17" ${dis(editable)}>`)}
            ${field('Primary use', `<select data-bind="${b('usage')}" ${dis(editable)}>${product('PersonalAuto').usages.map((x) => `<option ${sel(x, v.usage)}>${x}</option>`).join('')}</select>`)}
            ${field('Annual miles', `<input type="number" min="0" data-type="number" data-bind="${b('annualMiles')}" value="${esc(v.annualMiles)}" ${dis(editable)}>`)}
            ${field('Market value ($)', `<input type="number" min="0" data-type="number" data-bind="${b('marketValue')}" value="${esc(v.marketValue)}" ${dis(editable)}>`)}
            ${field('Garaging ZIP', `<input data-bind="${b('garagingZip')}" value="${esc(v.garagingZip)}" maxlength="5" ${dis(editable)}>`)}
          </div>
          ${editable ? `<div style="margin-top:10px"><button class="btn small danger" data-action="remove-vehicle" data-index="${i}">Remove vehicle</button></div>` : ''}
        </fieldset>`;
      }).join('')}`;
  },

  dwelling(job, draft, editable) {
    const pm = product('Homeowners');
    const d = draft.line.dwelling;
    const owner = ['HO3', 'HO5'].includes(draft.line.form);
    const b = (f) => `line.dwelling.${f}`;
    const num = (label, f, extra = '') => field(label, `<input type="number" data-type="number" data-bind="${b(f)}" value="${esc(d[f])}" ${extra} ${dis(editable)}>`);
    const check = (label, f) => field(label, `<input type="checkbox" data-bind="${b(f)}" ${d[f] ? 'checked' : ''} data-rerender ${dis(editable)}>`, 'check');
    const rce = job.quote && job.quote.replacementCost;
    return `<h2>Dwelling</h2>
      <h3>Location</h3>
      <div class="form-grid">
        ${field('Street', `<input data-bind="${b('line1')}" value="${esc(d.line1)}" ${dis(editable)}>`)}
        ${field('City', `<input data-bind="${b('city')}" value="${esc(d.city)}" ${dis(editable)}>`)}
        ${field('State', `<input value="${esc(job.period.state)}" disabled>`)}
        ${field('ZIP', `<input data-bind="${b('zip')}" value="${esc(d.zip)}" maxlength="5" ${dis(editable)}>`)}
      </div>
      <h3>Construction</h3>
      <div class="form-grid">
        ${num('Year built', 'yearBuilt')}
        ${field('Construction type', `<select data-bind="${b('construction')}" ${dis(editable)}>${pm.constructionTypes.map((x) => `<option ${sel(x, d.construction)}>${x}</option>`).join('')}</select>`)}
        ${num(owner ? 'Square feet' : 'Unit square feet', 'squareFeet')}
        ${num('Stories', 'stories')}
        ${owner ? num('Roof age (years)', 'roofAge') : ''}
      </div>
      ${rce ? `<div class="banner info" style="margin-top:12px">Replacement cost estimate from last quote: ${usd0(rce)}</div>` : ''}
      <h3>Protection</h3>
      <div class="form-grid">
        ${field('Protection class', `<select data-bind="${b('protectionClass')}" data-type="number" ${dis(editable)}>${[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => `<option ${sel(n, d.protectionClass)}>${n}</option>`).join('')}</select>`)}
        ${num('Miles to fire station', 'distanceToFireStation', 'step="0.1" min="0"')}
        ${field('Burglar / fire alarm', `<select data-bind="${b('alarm')}" ${dis(editable)}>${pm.alarmTypes.map((x) => `<option ${sel(x, d.alarm)}>${x}</option>`).join('')}</select>`)}
        ${check('Sprinkler system', 'sprinklers')}
      </div>
      <h3>Liability hazards and loss history</h3>
      <div class="form-grid">
        ${check('Swimming pool', 'pool')}
        ${d.pool ? check('Pool has locking fence', 'poolFenced') : ''}
        ${check('Trampoline', 'trampoline')}
        ${check('Dog with bite history / restricted breed', 'aggressiveDog')}
        ${num('Claims in last 5 years', 'priorClaims', 'min="0"')}
      </div>`;
  },

  coverages(job, draft, editable) {
    const pm = product(job.product);
    const row = (def, cov, prefix, saveOnChange = false) => {
      if (!cov) return '';
      const required = def.existence === 'Required';
      const terms = cov.selected ? def.terms.filter((t) => cov.terms[t.code] !== undefined).map((t) => {
        const bind = `${prefix}.terms.${t.code}`;
        const ctl = t.type === 'option'
          ? `<select data-bind="${bind}" ${dis(editable)}>${t.options.map((o) => `<option value="${esc(o.value)}" ${sel(o.value, cov.terms[t.code])}>${esc(o.label)}</option>`).join('')}</select>`
          : `<input type="number" min="0" step="100" data-type="number" data-bind="${bind}" value="${esc(cov.terms[t.code])}" ${saveOnChange ? 'data-save' : ''} ${dis(editable)}>`;
        return `<label class="field"><span>${esc(t.name)}</span>${ctl}</label>`;
      }).join('') : '';
      return `<div class="cov-row">
        <label class="cov-name"><input type="checkbox" data-bind="${prefix}.selected" data-rerender ${cov.selected ? 'checked' : ''} ${required || !editable ? 'disabled' : ''}> ${esc(def.name)} ${required ? '<span class="tag">Required</span>' : ''}</label>
        <div class="cov-terms">${terms || (cov.selected ? '<span class="muted">No terms</span>' : '')}</div></div>`;
    };
    const group = (title, inner) => (inner.trim() ? `<div class="cov-group"><div class="cov-title">${esc(title)}</div>${inner}</div>` : '');

    if (job.product === 'PersonalAuto') {
      const { lineCoverages, vehicles } = draft.line;
      return `<h2>Coverages</h2>
        ${group('Policy-level coverages', pm.lineCoverages.map((d) => row(d, lineCoverages[d.code], `line.lineCoverages.${d.code}`)).join(''))}
        ${vehicles.length ? vehicles.map((v, i) => group(`Vehicle ${i + 1}: ${v.year || ''} ${v.make || ''} ${v.model || ''}`, pm.vehicleCoverages.map((d) => row(d, (v.coverages || {})[d.code], `line.vehicles.${i}.coverages.${d.code}`)).join(''))).join('') : '<div class="empty">Add a vehicle to choose physical damage coverages.</div>'}`;
    }
    const covs = draft.line.coverages;
    const cats = [...new Set(pm.coverages.map((d) => d.category))];
    return `<h2>Coverages</h2>
      <div class="muted" style="margin-bottom:12px">Coverage B, C and D default to a percentage of Coverage A (or of C for renters and condos). Changing A recalculates the defaults you have not edited.</div>
      ${cats.map((cat) => group(cat, pm.coverages.filter((d) => d.category === cat).map((d) => row(d, covs[d.code], `line.coverages.${d.code}`, d.code === 'HODwellingCov')).join(''))).join('')}`;
  },

  risk(job, draft, editable) {
    const issues = job.uwIssues || [];
    const u = me();
    if (!issues.length) {
      return `<h2>Risk analysis</h2><div class="empty">${job.quote || job.history.some((h) => h.action.startsWith('Quote')) ? 'No underwriting issues. The risk is within appetite.' : 'Underwriting rules run when you quote.'}</div>`;
    }
    return `<h2>Risk analysis: underwriting issues</h2>
      ${table(['Issue', 'Blocks', 'Approval needed', 'Status', ''], issues.map((i) => {
        let status;
        if (i.approved) status = `${badge('Approved')}<div class="muted">${esc(i.approval.byName)}, ${when(i.approval.at)}${i.approval.note ? `<br>"${esc(i.approval.note)}"` : ''}</div>`;
        else status = i.approvable ? badge('Pending') : badge('Not approvable');
        const canApprove = editable || (OPEN.includes(job.status));
        const action = !i.approved && i.approvable && canApprove
          ? (u.authority >= i.approvalLevel
            ? `<div class="toolbar"><input placeholder="Approval note" data-note-for="${esc(i.key)}" style="width:160px"><button class="btn small primary" data-action="approve-issue" data-key="${esc(i.key)}">Approve</button></div>`
            : `<span class="muted">Needs ${esc(i.requiredRole)}</span>`)
          : '';
        return [`<strong>${esc(i.name)}</strong><div class="muted">${esc(i.description)}</div>`, badge(i.blockingPoint), esc(i.requiredRole || 'Cannot be approved'), status, action];
      }))}`;
  },

  quote(job) {
    const q = job.quote;
    if (!q) return '<h2>Quote</h2><div class="empty">Not quoted yet. Click Quote to rate this job.</div>';
    const tiles = [
      ['Premium', q.premium], ['Taxes', q.taxes], ['Fees', q.fees], ['Total term cost', q.total],
    ].map(([l, v], i) => `<div class="tile ${i === 3 ? 'accent' : ''}"><div class="label">${l}</div><div class="value">${money(v)}</div></div>`).join('');
    const pr = q.proration;
    return `<h2>Quote</h2>
      <div class="tiles">${tiles}</div>
      ${pr ? `<div class="banner info">Prior full-term premium ${money(pr.priorTermPremium)} → new ${money(pr.newTermPremium)}. Pro-rated over ${pr.remainingDays} of ${pr.termDays} days (${pr.factor}): <strong>change in premium ${money(q.changeAmount)}</strong>.</div>` : ''}
      <div class="muted" style="margin-bottom:8px">Rate book ${esc(q.rateBook.code)} ${esc(q.rateBook.version)} (effective ${esc(q.rateBook.effectiveDate)}, rate level ${q.rateBook.rateLevel})${q.ratedDriver ? ` · Rated driver: ${esc(q.ratedDriver.label)}, factor ${q.ratedDriver.factor}` : ''}${q.replacementCost ? ` · Replacement cost estimate ${usd0(q.replacementCost)}` : ''}. Click a line to see its rating worksheet.</div>
      ${costTable(q)}`;
  },

  summary(job) {
    if (job.type === 'Cancellation') {
      const c = job.cancellation;
      return `<h2>Cancellation</h2>
        <dl class="facts"><dt>Reason</dt><dd>${esc(c.reasonName)}</dd><dt>Effective</dt><dd>${esc(c.effectiveDate)}</dd><dt>Calculation method</dt><dd>${esc(c.method)}</dd><dt>Return premium</dt><dd><strong>${money(-c.refund)}</strong></dd></dl>
        <h3>Unearned premium by term</h3>
        ${table(['Term', '$Term premium', 'Unearned days', 'Short rate', '$Return'], c.lines.map((l) => [l.termNumber, money(l.termPremium), `${l.unearnedDays} of ${l.termDays}`, l.shortRate ? 'Yes (90%)' : 'No', money(l.refund)]))}
        <div class="muted" style="margin-top:10px">Policy fees are fully earned and not returned.</div>`;
    }
    const r = job.reinstatement;
    return `<h2>Reinstatement</h2>
      <dl class="facts"><dt>Cancellation</dt><dd>${esc(r.cancellationJobNumber)}, effective ${esc(r.cancellationEffectiveDate)} (${esc(r.reasonName)})</dd>
      <dt>Premium restored</dt><dd><strong>${money(job.quote.changeAmount)}</strong></dd></dl>
      <div class="muted" style="margin-top:10px">Coverage is restored with no lapse from the cancellation date.</div>`;
  },
};

function daysLeft(p) {
  return Math.round((Date.parse(p.expirationDate) - Date.parse(p.editEffectiveDate)) / 86400000);
}

// ------------------------------------------------------------------ search & admin

async function pageSearch(q) {
  const r = await api('GET', '/search?q=' + encodeURIComponent(q));
  view(`
    <div class="eyebrow">Search</div><h1>Results for "${esc(q)}"</h1>
    <div class="card"><h2>Accounts</h2>${table(['Account', 'Name', 'City'], r.accounts.map((a) => [`<a href="#/account/${a.id}">${esc(a.accountNumber)}</a>`, esc(a.name), esc(a.address.city)]), 'No accounts')}</div>
    <div class="card"><h2>Policies</h2>${table(['Policy', 'Insured', 'Product', 'Status'], r.policies.map((p) => [policyLink(p), esc(p.insuredName), productLabel(p.product, p.form), badge(p.status)]), 'No policies')}</div>
    <div class="card"><h2>Jobs</h2>${table(['Job', 'Type', 'Account', 'Status'], r.jobs.map((j) => [jobLink(j), esc(j.type), esc(j.accountName), badge(j.status)]), 'No jobs')}</div>`);
}

async function pageAdmin() {
  const [books, events] = await Promise.all([api('GET', '/ratebooks'), api('GET', '/events')]);
  const u = me();
  const b = S.batch;
  view(`
    <div class="eyebrow">Administration</div><h1>Administration</h1>
    <div class="grid two">
      <div class="card"><h2>Renewal batch process</h2>
        <p class="muted">Starts and quotes renewals for policies expiring within the window. Requires underwriter authority.</p>
        <form class="toolbar" data-form="renewal-batch">
          ${field('As of', `<input type="date" name="asOf" value="${S.meta.today}">`)}
          ${field('Days ahead', `<input type="number" name="daysAhead" value="60" min="1" max="120" style="width:90px">`)}
          <button class="btn primary" style="align-self:flex-end" ${u.authority >= 1 ? '' : 'disabled'}>Run batch</button>
        </form>
        ${b ? `<h3>Last run: ${b.processed} policies</h3>${table(['Policy', 'Outcome', 'Job', 'Message'], b.results.map((x) => [esc(x.policyNumber), badge(x.outcome), x.jobId ? `<a href="#/job/${x.jobId}">${esc(x.jobNumber)}</a>` : '—', esc(x.message)]), 'No policies in the window')}` : ''}
      </div>
      <div class="card"><h2>Users and authority</h2>
        ${table(['User', 'Role', 'UW authority', 'Producer'], S.meta.users.map((x) => [esc(x.name), esc(x.role), x.authority, esc(x.producerCode || 'All')]))}
        <h3>Demo data</h3>
        <button class="btn danger" data-action="reset-demo" ${u.authority >= 2 ? '' : 'disabled'}>Reset demo data</button>
        <span class="muted">${u.authority >= 2 ? '' : 'UW Manager only'}</span>
      </div>
    </div>
    <div class="card"><h2>Rate books</h2>
      ${table(['Code', 'Product', 'Version', 'Effective', 'Status', 'Rate level', 'Description'], books.map((r) => [esc(r.code), esc(product(r.product).name), esc(r.version), esc(r.effectiveDate), badge(r.status), r.rateLevel, esc(r.description)]))}
    </div>
    <div class="card"><h2>Integration event outbox (latest 200)</h2>${eventsTable(events)}</div>`);
}

// ------------------------------------------------------------------ actions

// ------------------------------------------------------------------ sales

const SALES = { tab: 'analytics', period: 'month', product: '' };
const FOLLOW_CHANNELS = ['Phone', 'Email', 'SMS', 'Visit', 'Letter'];
const FOLLOW_RESULTS = ['Interested', 'Callback requested', 'No answer', 'Not reachable', 'Declined', 'Renewed', 'Other'];

// Opens the customer's WhatsApp chat or email app with the renewal (or lapse) message filled in.
// The message comes from the saved templates; nothing is sent by the server, and the user presses Send.
async function contactRenewal(d) {
  const language = (document.getElementById('renewal-lang') || {}).value || 'en';
  const channel = d.channel;
  // Pop-up blockers allow a new tab only when it is opened straight from the click, so open it first.
  const tab = channel === 'whatsapp' ? window.open('', '_blank') : null;
  try {
    const p = await api('POST', '/messages/preview', { accountId: d.account, policyId: d.policy, template: d.status === 'Lapsed' ? 'lapse' : 'renewal', channel, language });
    if (!p.to) {
      if (tab) tab.close();
      toast(channel === 'email' ? 'This customer has no email address on file.' : 'This customer has no valid phone number on file (use 10 digits or a number with country code).', 'error');
      return;
    }
    if (channel === 'email') {
      window.location.href = `mailto:${p.to}?subject=${encodeURIComponent(p.subject || '')}&body=${encodeURIComponent(p.body)}`;
    } else {
      tab.location.href = `https://wa.me/${p.to}?text=${encodeURIComponent(p.body)}`;
    }
  } catch (err) {
    if (tab) tab.close();
    toast(err.message, 'error');
  }
}

async function pageSales() {
  const tabs = [['analytics', 'Sales analytics'], ['lapsing', 'Lapsing & lapsed'], ['history', 'Follow-up history']];
  const tabBar = `<div class="tabs">${tabs.map(([k, n]) => `<button class="${SALES.tab === k ? 'active' : ''}" data-action="sales-tab" data-tab="${k}">${n}</button>`).join('')}</div>`;
  let body;
  if (SALES.tab === 'analytics') {
    const q = `period=${encodeURIComponent(SALES.period)}${SALES.product ? `&product=${encodeURIComponent(SALES.product)}` : ''}`;
    const d = await api('GET', `/sales/analytics?${q}`);
    body = `<form class="toolbar" data-form="sales-filter" style="margin-bottom:12px">
        ${field('Period', `<select name="period">${['day', 'month', 'year'].map((p) => `<option value="${p}" ${sel(p, SALES.period)}>${p === 'day' ? 'Daily' : p === 'month' ? 'Monthly' : 'Yearly'}</option>`).join('')}</select>`)}
        ${field('Product', `<select name="product"><option value="">All products</option>${Object.values(S.meta.products).map((p) => `<option value="${p.code}" ${sel(p.code, SALES.product)}>${esc(p.name)}</option>`).join('')}</select>`)}
        <button class="btn">Show</button>
      </form>
      <div class="muted" style="margin-bottom:10px">Policies sold, by the day they were bound. Premium includes tax. Showing ${esc(d.scope)}.</div>`
      + (d.buckets.length
        ? d.buckets.map((b) => `<h3>${esc(b.period)} · ${b.total.policies} policies · ${money(b.total.premium)}</h3>`
          + table(['Salesperson', '$Policies', '$Premium'], b.salespeople.map((s) => [esc(s.name), s.policies, money(s.premium)]))).join('')
        : '<div class="empty">No sales in this view yet.</div>');
  } else if (SALES.tab === 'lapsing') {
    const rows = await api('GET', '/sales/lapsing');
    body = '<div class="muted" style="margin-bottom:10px">Lapsing: the term ends within 60 days and nothing has renewed. Lapsed: the term ended in the last 90 days and nothing has renewed.</div>'
      + `<div class="toolbar" style="margin-bottom:10px"><label class="field"><span>Message language for WhatsApp and email</span><select id="renewal-lang"><option value="en">English</option><option value="hi">हिन्दी</option><option value="te">తెలుగు</option></select></label><span class="muted">Opens your WhatsApp or email app with the message filled in. You send it yourself.</span></div>`
      + table(['Policy', 'Insured', 'Status', '$Premium', 'Ends', 'Days left', 'Salesperson', 'Last follow-up', ''], rows.map((r) => [
        policyLink({ policyNumber: r.policyNumber, policyId: r.policyId }), esc(r.insured), badge(r.status), money(r.premium), esc(r.expirationDate),
        r.daysToExpiry, esc(r.salesperson.name),
        r.lastFollowUp ? `${esc(r.lastFollowUp.date)} · ${esc(r.lastFollowUp.channel)} · ${esc(r.lastFollowUp.result)}` : '<span class="muted">None yet</span>',
        `<div class="toolbar"><button class="btn small primary" data-action="log-followup" data-id="${esc(r.policyId)}" data-number="${esc(r.policyNumber)}">Log follow-up</button><button class="btn small" data-action="followup-history" data-id="${esc(r.policyId)}" data-number="${esc(r.policyNumber)}">History</button>${['whatsapp', 'email'].map((ch) => `<button class="btn small" data-action="contact-policy" data-channel="${ch}" data-account="${esc(r.accountId)}" data-policy="${esc(r.policyId)}" data-status="${esc(r.status)}">${ch === 'whatsapp' ? 'WhatsApp' : 'Email'}</button>`).join('')}</div>`,
      ]), 'No lapsing or lapsed policies for you');
  } else {
    const rows = await api('GET', '/sales/followups');
    body = table(['Date', 'Policy', 'Insured', 'Channel', 'Result', 'Salesperson', 'Notes'], rows.map((f) => [
      esc(f.date), policyLink({ policyNumber: f.policyNumber, policyId: f.policyId }), esc(f.insured), esc(f.channel), esc(f.result),
      esc((S.meta.users.find((u) => u.id === f.salespersonId) || { name: f.salespersonId }).name), esc(f.notes || ''),
    ]), 'No follow-ups logged yet');
  }
  view(`<div class="eyebrow">Sales</div><h1>Sales</h1>${tabBar}<div class="card">${body}</div>`);
}

function followUpModal(policyId, number) {
  openModal(`<h2>Log follow-up · ${esc(number)}</h2>
    <form data-form="followup" data-id="${esc(policyId)}">
      <div class="form-errors"></div>
      <div class="form-grid">
        ${field('Date', `<input type="date" name="date" value="${S.meta.today}" max="${S.meta.today}" required>`)}
        ${field('Channel', `<select name="channel">${FOLLOW_CHANNELS.map((c) => `<option>${c}</option>`).join('')}</select>`)}
        ${field('Result', `<select name="result">${FOLLOW_RESULTS.map((r) => `<option>${r}</option>`).join('')}</select>`)}
      </div>
      ${field('Notes', '<textarea name="notes" rows="3" style="width:100%" placeholder="What the customer said, and the next step"></textarea>')}
      <div class="actions"><button type="button" class="btn" data-action="close-modal">Cancel</button><button class="btn primary">Save follow-up</button></div>
    </form>`);
}

async function followUpHistoryModal(policyId, number) {
  const rows = await api('GET', `/sales/policies/${encodeURIComponent(policyId)}/followups`);
  openModal(`<h2>Follow-up history · ${esc(number)}</h2>`
    + table(['Date', 'Channel', 'Result', 'Notes', 'Logged by'], rows.map((f) => [esc(f.date), esc(f.channel), esc(f.result), esc(f.notes || ''), esc(f.loggedByName)]), 'No follow-ups yet')
    + '<div class="actions"><button class="btn" data-action="close-modal">Close</button></div>', true);
}

// ------------------------------------------------------------------ staff accounts (UW Manager)

function showTemporaryPassword(r) {
  openModal(`<h2>Account ready: ${esc(r.username)}</h2>
    <p>Give this temporary password to ${esc(r.name)}. They must choose their own password at first sign-in. It is shown only once.</p>
    <div class="card" style="font-family:Consolas,monospace;font-size:20px;text-align:center;letter-spacing:.05em">${esc(r.temporaryPassword)}</div>
    <div class="actions"><button class="btn primary" data-action="close-modal">Done</button></div>`);
}

async function pageStaff() {
  const rows = await api('GET', '/staff');
  const roles = ['Agent', 'Underwriter', 'Insurance Executive', 'UW Manager'];
  view(`<div class="eyebrow">Administration</div><h1>Staff accounts</h1>
    <div class="grid two">
      <div class="card"><h2>Create an account</h2>
        <form data-form="create-staff"><div class="form-errors"></div>
          ${field('Username', '<input name="username" placeholder="for example venkatesh.r" required>')}
          ${field('Full name', '<input name="name" required>')}
          ${field('Role', `<select name="role">${roles.map((r) => `<option>${r}</option>`).join('')}</select>`)}
          ${field('Producer code (agents only)', `<select name="producerCode"><option value="">None</option>${S.meta.producerCodes.map((p) => `<option value="${p.code}">${p.code} · ${esc(p.name)}</option>`).join('')}</select>`)}
          ${field('Reports to (username)', `<input name="reportsTo" value="${esc(S.me.username || S.me.id)}">`)}
          <div class="toolbar" style="margin-top:12px"><button class="btn primary">Create account</button></div>
        </form>
      </div>
      <div class="card"><h2>Accounts</h2>
        ${table(['Username', 'Name', 'Role', 'Status', ''], rows.map((r) => [
          esc(r.username), esc(r.name), esc(r.role), r.active ? badge('Active') : badge('Off'),
          `<div class="toolbar"><button class="btn small" data-action="reset-staff" data-id="${esc(r.id)}">${r.hasPassword ? 'Reset password' : 'Create password'}</button><button class="btn small danger" data-action="toggle-staff" data-id="${esc(r.id)}" data-active="${r.active}">${r.active ? 'Turn off' : 'Turn on'}</button></div>`,
        ]))}
      </div>
    </div>`);
}

// Plain SVG pie chart with a legend. Slices with no value are left out by the caller.
const PIE_COLORS = ['#0b6bcb', '#2e7d32', '#f9a825', '#c62828', '#6a1b9a', '#00838f', '#ef6c00', '#5d4037'];
function pieChart(slices, fmt = (v) => v) {
  const shown = slices.filter((x) => x.value > 0);
  const total = shown.reduce((s, x) => s + x.value, 0);
  if (!total) return '<div class="empty">No data in this range</div>';
  const cx = 100, cy = 100, r = 90;
  let angle = -Math.PI / 2;
  const paths = [];
  const legend = [];
  shown.forEach((s, i) => {
    const color = PIE_COLORS[i % PIE_COLORS.length];
    const pct = s.value / total;
    const share = `${Math.round(pct * 1000) / 10}%`;
    const title = `<title>${esc(s.label)}: ${esc(fmt(s.value))} (${share})</title>`;
    if (shown.length === 1) {
      paths.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="${color}">${title}</circle>`);
    } else {
      const next = angle + pct * 2 * Math.PI;
      const [x1, y1] = [cx + r * Math.cos(angle), cy + r * Math.sin(angle)];
      const [x2, y2] = [cx + r * Math.cos(next), cy + r * Math.sin(next)];
      const large = pct > 0.5 ? 1 : 0;
      paths.push(`<path d="M${cx},${cy} L${x1.toFixed(2)},${y1.toFixed(2)} A${r},${r} 0 ${large} 1 ${x2.toFixed(2)},${y2.toFixed(2)} Z" fill="${color}">${title}</path>`);
      angle = next;
    }
    legend.push(`<li><span class="swatch" style="background:${color}"></span><span>${esc(s.label)}</span><span class="muted">${esc(fmt(s.value))} · ${share}</span></li>`);
  });
  return `<div class="pie"><svg viewBox="0 0 200 200" role="img" aria-label="Pie chart">${paths.join('')}</svg><ul class="pie-legend">${legend.join('')}</ul></div>`;
}

// ------------------------------------------------------------------ insights (UW Manager)

const INSIGHTS = { from: '', to: '' };

async function pageInsights() {
  const q = new URLSearchParams();
  if (INSIGHTS.from) q.set('from', INSIGHTS.from);
  if (INSIGHTS.to) q.set('to', INSIGHTS.to);
  const d = await api('GET', `/insights${q.toString() ? `?${q}` : ''}`);
  INSIGHTS.from = d.from;
  INSIGHTS.to = d.to;
  const fin = await api('GET', `/finance/report?from=${encodeURIComponent(d.from)}&to=${encodeURIComponent(d.to)}`);
  const t = d.totals;
  const maxProfit = Math.max(1, ...d.months.map((m) => Math.abs(m.profit)));
  const bar = (v) => `<div style="height:8px;border-radius:4px;background:${v >= 0 ? 'var(--ok, #2e7d32)' : 'var(--bad, #c62828)'};width:${Math.round((Math.abs(v) / maxProfit) * 100)}%"></div>`;
  const share = (g) => `${g.share}%`;
  const range = `from=${encodeURIComponent(d.from)}&to=${encodeURIComponent(d.to)}`;
  const kpi = (label, value) => `<div class="card"><div class="muted">${label}</div><div style="font-size:24px;font-weight:600;margin-top:4px">${value}</div></div>`;
  const charts = `<div class="grid two" style="margin-top:16px">
      <div class="card"><h2>Policies sold by product</h2>${pieChart(d.byProduct.map((g) => ({ label: g.product, value: g.policies })), (v) => `${v} policies`)}</div>
      <div class="card"><h2>Premium by producer (agency)</h2>${pieChart(d.byProducer.map((g) => ({ label: g.producer, value: g.premium })), money)}</div>
      <div class="card"><h2>Policies by salesperson</h2>${pieChart(d.bySalesperson.map((g) => ({ label: g.salesperson, value: g.policies })), (v) => `${v} policies`)}</div>
      <div class="card"><h2>Expenses by category</h2>${pieChart(Object.entries(fin.totals.expenses).map(([k, v]) => ({ label: k, value: v })), money)}</div>
    </div>`;
  view(`<div class="eyebrow">Insights</div><h1>Sales and profit dashboard</h1>
    <div class="card">
      <form class="toolbar" data-form="insights-range">
        ${field('From (month)', `<input type="month" name="from" value="${esc(d.from)}" required>`)}
        ${field('To (month)', `<input type="month" name="to" value="${esc(d.to)}" required>`)}
        <button class="btn">Show</button>
        <a class="btn" href="/api/reports/profitability.xlsx?${range}">Download Excel</a>
        <a class="btn" href="/api/reports/profitability.pdf?${range}">Download PDF</a>
      </form>
    </div>
    <div class="grid four" style="margin-top:16px">
      ${kpi('Policies sold', t.policiesSold)}
      ${kpi('Premium sold', money(t.premiumSold))}
      ${kpi('Income (premium + commission)', money(t.income))}
      ${kpi('Profit after expenses', `<span style="color:${t.profit >= 0 ? 'var(--ok, #2e7d32)' : 'var(--bad, #c62828)'}">${money(t.profit)}</span>`)}
    </div>
    ${charts}
    <div class="card" style="margin-top:16px"><h2>Month by month</h2>
      ${table(['Month', 'Policies sold', 'Premium sold', 'Income', 'Expenses', 'Profit', 'Profit trend'],
        d.months.map((m) => [esc(m.month), m.policiesSold, money(m.premiumSold), money(m.income), money(m.expenses), `<strong>${money(m.profit)}</strong>`, bar(m.profit)]),
        'No months in this range')}
    </div>
    <div class="grid two" style="margin-top:16px">
      <div class="card"><h2>By product</h2>
        ${table(['Product', 'Policies', 'Share', 'Premium', 'Commission'], d.byProduct.map((g) => [esc(g.product), g.policies, share(g), money(g.premium), money(g.commission)]), 'No sales in this range')}
      </div>
      <div class="card"><h2>By producer (agency)</h2>
        ${table(['Producer', 'Policies', 'Share', 'Premium', 'Commission'], d.byProducer.map((g) => [esc(g.producer), g.policies, share(g), money(g.premium), money(g.commission)]), 'No sales in this range')}
      </div>
    </div>
    <div class="card" style="margin-top:16px"><h2>By salesperson</h2>
      ${table(['Salesperson', 'Policies', 'Share', 'Premium', 'Commission'], d.bySalesperson.map((g) => [esc(g.salesperson), g.policies, share(g), money(g.premium), money(g.commission)]), 'No sales in this range')}
    </div>
    <div class="card" style="margin-top:16px"><h2>Policies sold per salesperson, per month</h2>
      ${table(['Salesperson', ...d.matrix.months, 'Total'], d.matrix.rows.map((r) => [esc(r.salesperson), ...r.counts.map((c) => (c ? `<strong>${c}</strong>` : '<span class="muted">0</span>')), `<strong>${r.total}</strong>`]), 'No sales in this range')}
    </div>`);
}

// ------------------------------------------------------------------ finance (UW Manager)

const FIN = { from: '', to: '' };

async function pageFinance() {
  const q = new URLSearchParams();
  if (FIN.from) q.set('from', FIN.from);
  if (FIN.to) q.set('to', FIN.to);
  const qs = q.toString() ? `?${q}` : '';
  const [r, expenses] = await Promise.all([api('GET', `/finance/report${qs}`), api('GET', `/finance/expenses${qs}`)]);
  FIN.from = r.from;
  FIN.to = r.to;
  const cats = r.categories;
  const range = `from=${encodeURIComponent(r.from)}&to=${encodeURIComponent(r.to)}`;
  const headers = ['Month', 'Premium', 'Commission', 'Income', ...cats, 'Expenses', 'Net profit'];
  const rows = r.months.map((m) => [
    esc(m.month), money(m.premium), money(m.commission), money(m.income),
    ...cats.map((c) => money(m.expenses[c])), money(m.totalExpenses), `<strong>${money(m.net)}</strong>`,
  ]);
  const t = r.totals;
  const totalRow = ['<strong>Total</strong>', money(t.premium), money(t.commission), money(t.income), ...cats.map((c) => money(t.expenses[c])), money(t.totalExpenses), `<strong>${money(t.net)}</strong>`];
  view(`<div class="eyebrow">Finance</div><h1>Profitability and settlement</h1>
    <p class="muted">Income is billed premium plus ${r.commissionRatePercent}% commission on that premium. Net profit is income minus the expenses entered below.</p>
    <div class="card">
      <form class="toolbar" data-form="finance-range">
        ${field('From (month)', `<input type="month" name="from" value="${esc(r.from)}" required>`)}
        ${field('To (month)', `<input type="month" name="to" value="${esc(r.to)}" required>`)}
        <button class="btn">Show</button>
        <a class="btn" href="/api/reports/profitability.xlsx?${range}">Download Excel</a>
        <a class="btn" href="/api/reports/profitability.pdf?${range}">Download PDF</a>
      </form>
    </div>
    <div class="card" style="margin-top:16px"><h2>Month by month</h2>
      ${table(headers, [...rows, totalRow], 'No months in this range')}
    </div>
    <div class="grid two" style="margin-top:16px">
      <div class="card"><h2>Commission rate</h2>
        <form data-form="finance-commission"><div class="form-errors"></div>
          ${field('Commission (percent of premium)', `<input name="percent" type="number" min="0" max="100" step="0.1" value="${r.commissionRatePercent}" required>`)}
          <div class="toolbar" style="margin-top:12px"><button class="btn primary">Save rate</button></div>
        </form>
      </div>
      <div class="card"><h2>Add an expense</h2>
        <form data-form="finance-expense"><div class="form-errors"></div>
          ${field('Month', `<input name="month" type="month" value="${esc(r.to)}" required>`)}
          ${field('Category', `<select name="category">${cats.map((c) => `<option>${esc(c)}</option>`).join('')}</select>`)}
          ${field('Amount', '<input name="amount" type="number" min="0.01" step="0.01" required>')}
          ${field('Note (optional)', '<input name="note" placeholder="for example March payroll">')}
          <div class="toolbar" style="margin-top:12px"><button class="btn primary">Add expense</button></div>
        </form>
      </div>
    </div>
    <div class="card" style="margin-top:16px"><h2>Expenses in this range</h2>
      ${table(['Month', 'Category', 'Amount', 'Note', 'Entered by'], expenses.map((e) => [esc(e.month), esc(e.category), money(e.amount), esc(e.note), esc(e.createdByName)]), 'No expenses entered yet')}
    </div>`);
}

const ACTIONS = {
  'reset-staff': async (d) => { const r = await api('POST', `/staff/${encodeURIComponent(d.id)}/reset`); showTemporaryPassword(r); pageStaff(); },
  'toggle-staff': async (d) => { await api('POST', `/staff/${encodeURIComponent(d.id)}/active`, { active: d.active !== 'true' }); pageStaff(); },
  'compose-message': (d) => composeModal(d.account),
  'message-preview': async (d, el) => {
    const out = document.getElementById('msg-preview');
    out.hidden = false;
    out.textContent = 'Preparing the message…';
    const p = await api('POST', '/messages/preview', composeBody(el.closest('form')));
    out.innerHTML = `<div class="muted">To: ${esc(p.to || 'no address on file')} · ${esc(p.channel === 'email' ? 'Email' : 'WhatsApp')}</div>`
      + (p.subject ? `<div style="margin-top:6px"><strong>${esc(p.subject)}</strong></div>` : '')
      + `<div style="margin-top:6px;white-space:pre-wrap">${esc(p.body)}</div>`;
  },
  'sales-tab': (d) => { SALES.tab = d.tab; pageSales(); },
  'log-followup': (d) => followUpModal(d.id, d.number),
  'contact-policy': (d) => contactRenewal(d),
  'followup-history': (d) => followUpHistoryModal(d.id, d.number),
  'close-modal': () => closeModal(),
  print: () => window.print(),
  'new-submission': (d) => newSubmissionModal(d.account),
  'complete-activity': async (d) => { await api('POST', `/activities/${d.id}/complete`); toast('Activity completed', 'success'); router(); },

  'job-step': async (d) => { await saveDraft(); S.jv.step = d.step; renderJob(); },
  'job-save': async () => { await saveDraft(); toast('Draft saved', 'success'); renderJob(); },
  'job-quote': async () => {
    S.jv.errors = null;
    try {
      await saveDraft();
      const job = await api('POST', `/jobs/${S.jv.job.id}/quote`);
      setJob(job);
      S.jv.step = job.status === 'Quoted' ? 'quote' : 'risk';
    } catch (err) {
      if (err.details && err.details.errors) S.jv.errors = err.details.errors;
      else throw err;
    }
    renderJob();
  },
  'job-bind': async () => {
    const job = await api('POST', `/jobs/${S.jv.job.id}/bind`);
    setJob(job);
    if (job.status !== 'Bound') S.jv.step = jobSteps(job).some((s) => s[0] === 'risk') ? 'risk' : S.jv.step;
    renderJob();
  },
  'job-withdraw': async () => { setJob(await api('POST', `/jobs/${S.jv.job.id}/withdraw`)); renderJob(); },
  'job-decline': async () => { setJob(await api('POST', `/jobs/${S.jv.job.id}/decline`, { reason: 'Outside underwriting appetite' })); renderJob(); },
  'approve-issue': async (d) => {
    const input = [...document.querySelectorAll('[data-note-for]')].find((x) => x.dataset.noteFor === d.key);
    const job = await api('POST', `/jobs/${S.jv.job.id}/uw-issues/${encodeURIComponent(d.key)}/approve`, { note: input ? input.value : '' });
    setJob(job);
    renderJob();
  },
  'add-driver': async () => { S.jv.draft.line.drivers.push({ firstName: '', lastName: '', dob: '', licenseNumber: '', licenseState: S.jv.job.period.state, yearsLicensed: null, accidents: 0, violations: 0 }); S.jv.dirty = true; await saveDraft(); renderJob(); },
  'remove-driver': async (d) => { S.jv.draft.line.drivers.splice(Number(d.index), 1); S.jv.dirty = true; await saveDraft(); renderJob(); },
  'add-vehicle': async () => { S.jv.draft.line.vehicles.push({ year: null, make: '', model: '', vin: '', usage: 'Commute', annualMiles: 12000, marketValue: null, garagingZip: S.jv.job.account.address.zip }); S.jv.dirty = true; await saveDraft(); renderJob(); },
  'remove-vehicle': async (d) => { S.jv.draft.line.vehicles.splice(Number(d.index), 1); S.jv.dirty = true; await saveDraft(); renderJob(); },

  'policy-tab': (d) => { S.policyTab = d.tab; renderPolicy(); },
  'view-doc': (d) => docModal(d.id),
  'policy-change': () => openModal(`<h2>Change policy ${esc(S.policy.policyNumber)}</h2>
    <form data-form="policy-change"><div class="form-errors"></div>
      ${field('Change effective date', `<input type="date" name="effectiveDate" value="${S.meta.today}" required>`)}
      <div class="actions"><button type="button" class="btn" data-action="close-modal">Cancel</button><button class="btn primary">Start policy change</button></div></form>`),
  'policy-cancel': () => openModal(`<h2>Cancel policy ${esc(S.policy.policyNumber)}</h2>
    <form data-form="policy-cancel"><div class="form-errors"></div>
      <div class="form-grid">
        ${field('Reason', `<select name="reason">${Object.entries(S.meta.cancelReasons).map(([k, r]) => `<option value="${k}" ${me().authority >= r.authority ? '' : 'disabled'}>${esc(r.name)}${r.noticeDays ? ` (${r.noticeDays} days notice)` : ''}</option>`).join('')}</select>`)}
        ${field('Cancellation effective date', `<input type="date" name="effectiveDate" value="${S.meta.today}" required>`)}
      </div>
      <p class="muted">Insured-request cancellations return 90% of unearned premium (short rate); others are pro rata. Cancelling on the term start date is a flat cancel.</p>
      <div class="actions"><button type="button" class="btn" data-action="close-modal">Back</button><button class="btn danger">Start cancellation</button></div></form>`),
  'policy-reinstate': async () => { const job = await api('POST', `/policies/${S.policy.id}/reinstate`); location.hash = `#/job/${job.id}`; },
  'policy-renew': async () => { const job = await api('POST', `/policies/${S.policy.id}/renew`); toast(job.notice ? job.notice.text : 'Renewal started'); location.hash = `#/job/${job.id}`; },
  'reset-demo': async (d, el) => {
    if (el.dataset.armed !== 'yes') { el.dataset.armed = 'yes'; el.textContent = 'Click again to confirm reset'; return; }
    await api('POST', '/admin/reset');
    S.jv = null;
    S.batch = null;
    toast('Demo data reset', 'success');
    router();
  },
};

const FORMS = {
  setup: async (fd) => {
    if (fd.get('password') !== fd.get('confirm')) throw new Error('The two passwords do not match');
    await api('POST', '/auth/setup', { username: fd.get('username'), password: fd.get('password') });
    location.reload();
  },
  signin: async (fd) => {
    await api('POST', '/auth/login', { username: fd.get('username'), password: fd.get('password') });
    location.reload();
  },
  'change-password': async (fd) => {
    if (fd.get('next') !== fd.get('confirm')) throw new Error('The two new passwords do not match');
    await api('POST', '/auth/password', { current: fd.get('current'), next: fd.get('next') });
    toast('Password saved', 'success');
    location.reload();
  },
  'create-staff': async (fd, form) => {
    const r = await api('POST', '/staff', {
      username: fd.get('username'), name: fd.get('name'), role: fd.get('role'),
      producerCode: fd.get('producerCode') || undefined, reportsTo: fd.get('reportsTo') || undefined,
    });
    form.reset();
    showTemporaryPassword(r);
    pageStaff();
  },
  'compose-message': async (fd, form) => {
    if (!fd.get('confirm')) throw new Error('Tick the box to confirm the recipient and message before sending');
    const rec = await api('POST', '/messages/send', { ...composeBody(form), confirm: true });
    closeModal();
    if (rec.status === 'Sent') toast(`Message sent (${rec.messageNumber})`, 'success');
    else toast(`Message failed: ${rec.error}`, 'error');
    pageAccount(form.dataset.id);
  },
  'insights-range': (fd) => { INSIGHTS.from = String(fd.get('from') || ''); INSIGHTS.to = String(fd.get('to') || ''); pageInsights(); },
  'finance-range': (fd) => { FIN.from = String(fd.get('from') || ''); FIN.to = String(fd.get('to') || ''); pageFinance(); },
  'finance-commission': async (fd) => { await api('POST', '/finance/commission', { percent: fd.get('percent') }); pageFinance(); },
  'finance-expense': async (fd) => {
    await api('POST', '/finance/expenses', { month: fd.get('month'), category: fd.get('category'), amount: fd.get('amount'), note: fd.get('note') });
    pageFinance();
  },
  'sales-filter': (fd) => { SALES.period = String(fd.get('period') || 'month'); SALES.product = String(fd.get('product') || ''); pageSales(); },
  followup: async (fd, form) => {
    await api('POST', `/sales/policies/${encodeURIComponent(form.dataset.id)}/followups`, { date: fd.get('date'), channel: fd.get('channel'), result: fd.get('result'), notes: fd.get('notes') });
    closeModal();
    toast('Follow-up saved', 'success');
    pageSales();
  },
  search: (fd) => { const q = String(fd.get('q') || '').trim(); if (q) location.hash = '#/search/' + encodeURIComponent(q); },
  'account-search': (fd) => { S.accountQuery = String(fd.get('q') || ''); pageAccounts(); },
  'policy-search': (fd) => { S.policyQuery = String(fd.get('q') || ''); pagePolicies(); },
  account: async (fd, form) => {
    const body = {};
    for (const [k, v] of fd.entries()) setPath(body, k, v);
    const id = form.dataset.id;
    const a = id ? await api('PUT', `/accounts/${id}`, body) : await api('POST', '/accounts', body);
    toast(id ? 'Account saved' : `Account ${a.accountNumber} created`, 'success');
    location.hash = `#/account/${a.id}`;
  },
  'new-submission': async (fd, form) => {
    const job = await api('POST', '/jobs/submission', { accountId: form.dataset.account, product: fd.get('product'), effectiveDate: fd.get('effectiveDate') });
    closeModal();
    location.hash = `#/job/${job.id}`;
  },
  'policy-change': async (fd) => {
    const job = await api('POST', `/policies/${S.policy.id}/change`, { effectiveDate: fd.get('effectiveDate') });
    closeModal();
    location.hash = `#/job/${job.id}`;
  },
  'policy-cancel': async (fd) => {
    const job = await api('POST', `/policies/${S.policy.id}/cancel`, { effectiveDate: fd.get('effectiveDate'), reason: fd.get('reason') });
    closeModal();
    location.hash = `#/job/${job.id}`;
  },
  'renewal-batch': async (fd) => {
    S.batch = await api('POST', '/batch/renewals', { asOf: fd.get('asOf'), daysAhead: Number(fd.get('daysAhead')) });
    toast(`Renewal batch processed ${S.batch.processed} policies`, 'success');
    pageAdmin();
  },
};

document.addEventListener('click', async (ev) => {
  const el = ev.target.closest('[data-action]');
  if (!el || el.disabled) return;
  const fn = ACTIONS[el.dataset.action];
  if (!fn) return;
  ev.preventDefault();
  el.disabled = true;
  try {
    await fn(el.dataset, el);
  } catch (err) {
    reportError(err);
  } finally {
    el.disabled = false;
  }
});

document.addEventListener('submit', async (ev) => {
  const form = ev.target.closest('form[data-form]');
  if (!form) return;
  ev.preventDefault();
  try {
    await FORMS[form.dataset.form](new FormData(form), form);
  } catch (err) {
    reportError(err);
  }
});

document.addEventListener('change', async (ev) => {
  const el = ev.target;
  if (!el.dataset || !el.dataset.bind || !S.jv) return;
  let v = el.type === 'checkbox' ? el.checked : el.value;
  if (el.dataset.type === 'number') v = v === '' ? null : Number(v);
  setPath(S.jv.draft, el.dataset.bind, v);
  S.jv.dirty = true;
  try {
    if (el.dataset.save !== undefined) {
      await saveDraft();
      renderJob();
    } else if (el.dataset.rerender !== undefined) renderJob();
  } catch (err) {
    reportError(err);
  }
});

document.getElementById('modal').addEventListener('click', (ev) => { if (ev.target.id === 'modal') closeModal(); });
document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') closeModal(); });

// ------------------------------------------------------------------ assistant

const CHAT = { conversationId: null, busy: false, status: null, abort: null };
const chatLanguage = () => (document.getElementById('chat-lang') || {}).value || 'auto';
const SUGGESTIONS = {
  policy: ['Summarize this policy', 'Why is this premium so high?', 'What changed on this policy?'],
  job: ['Why is this job blocked?', 'Explain this quote', 'Who can approve the issues?'],
  default: ['What referrals are waiting?', 'Summarize the book of business', 'Top 5 homeowners premiums in Florida'],
};

// The record the user is looking at, so "this policy" / "this job" resolves.
function chatContext() {
  const hash = location.hash || '#/desktop';
  const page = hash.replace(/^#\//, '').split('/')[0] || 'desktop';
  let record = null;
  if (hash.startsWith('#/policy/') && S.policy) record = S.policy.policyNumber;
  else if (hash.startsWith('#/job/') && S.jv) record = S.jv.job.jobNumber;
  else if (hash.startsWith('#/account/')) record = decodeURIComponent(hash.split('/')[2] || '');
  return { page, record };
}

// A small, safe Markdown subset: paragraphs, bullets, tables, **bold**, `code`, record-number links.
function renderMarkdown(text) {
  const inline = (t) => esc(t)
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // Markdown links: keep the text; record numbers get linked below
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\b((?:PA|HO)-\d{7})\b/g, '<a href="#/policy/$1">$1</a>')
    .replace(/\b(J\d{7})\b/g, '<a href="#/job/$1">$1</a>')
    .replace(/\b(A\d{7})\b/g, '<a href="#/account/$1">$1</a>');
  const cells = (row) => row.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
  const lines = String(text).split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    if (line.startsWith('|')) {
      const rows = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) rows.push(lines[i++].trim());
      i--;
      const [head, ...rest] = rows.filter((r) => !/^[\s|:-]+$/.test(r));
      out.push(`<table><thead><tr>${cells(head).map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${rest.map((r) => `<tr>${cells(r).map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
    } else if (/^[-*•] /.test(line)) {
      const items = [];
      while (i < lines.length && /^[-*•] /.test(lines[i].trim())) items.push(lines[i++].trim().replace(/^[-*•] /, ''));
      i--;
      out.push(`<ul>${items.map((x) => `<li>${inline(x)}</li>`).join('')}</ul>`);
    } else if (/^#{1,4} /.test(line)) {
      out.push(`<p><strong>${inline(line.replace(/^#{1,4} /, ''))}</strong></p>`);
    } else {
      out.push(`<p>${inline(line)}</p>`);
    }
  }
  return out.join('');
}

function chatAppend(role, html, extra = '') {
  const log = document.getElementById('chat-log');
  const el = document.createElement('div');
  el.className = `msg ${role}`;
  el.innerHTML = html + extra;
  log.appendChild(el);
  log.scrollTop = log.scrollHeight;
  return el;
}

function chatSuggestions() {
  const list = SUGGESTIONS[chatContext().page] || SUGGESTIONS.default;
  document.getElementById('chat-suggest').innerHTML = list.map((q) => `<button type="button" data-q="${esc(q)}">${esc(q)}</button>`).join('');
}

function chatReset() {
  if (CHAT.abort) CHAT.abort.abort();
  stopVoice(true);
  CHAT.conversationId = null;
  document.getElementById('chat-log').innerHTML = '';
  const offline = CHAT.status && CHAT.status.mode === 'offline';
  chatAppend('bot', renderMarkdown(`Hi ${me().name.split(' ')[0]}, I can look up accounts, policies and jobs, explain premiums and underwriting issues, and summarize your book of business.${offline ? '\n**Offline mode:** no Anthropic API key is set, so I can only do lookups and summaries.' : ''}`));
  chatSuggestions();
}

async function chatStatus() {
  try {
    CHAT.status = await api('GET', '/chat/status');
  } catch {
    CHAT.status = { mode: 'offline' };
  }
  document.getElementById('chat-mode').textContent = CHAT.status.mode === 'claude' ? `Powered by Claude (${CHAT.status.model})` : 'Offline mode: lookups and summaries';
}

// Reads a Server-Sent Events body from fetch and calls onEvent(type, data) for each event.
async function readEventStream(res, onEvent) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let cut;
    while ((cut = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, cut);
      buf = buf.slice(cut + 2);
      let type = 'message';
      let data = '';
      for (const line of chunk.split('\n')) {
        if (line.startsWith('event: ')) type = line.slice(7);
        else if (line.startsWith('data: ')) data += line.slice(6);
      }
      if (data) onEvent(type, JSON.parse(data));
    }
  }
}

// Sends a message and renders the answer live as it streams in.
async function chatSend(text) {
  const message = text.trim();
  if (!message || CHAT.busy) return;
  CHAT.busy = true;
  CHAT.abort = new AbortController();
  chatUpdateSend();
  chatAppend('user', esc(message));
  const bubble = chatAppend('bot live', '<div class="steps-live"></div><div class="answer"><span class="cursor"></span></div>');
  const steps = bubble.querySelector('.steps-live');
  const answer = bubble.querySelector('.answer');
  const log = document.getElementById('chat-log');
  let textSoFar = '';
  let frame = 0;
  const paint = () => {
    frame = 0;
    const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
    answer.innerHTML = renderMarkdown(textSoFar) + (CHAT.busy ? '<span class="cursor"></span>' : '');
    if (nearBottom) log.scrollTop = log.scrollHeight;
  };
  const schedule = () => { if (!frame) frame = requestAnimationFrame(paint); };
  let result = null;
  let failure = null;
  try {
    const res = await fetch('/api/chat/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: CHAT.conversationId, message, context: chatContext(), language: chatLanguage() }),
      signal: CHAT.abort.signal,
    });
    if (!res.ok || !res.body) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || res.statusText);
    }
    await readEventStream(res, (type, data) => {
      if (type === 'delta') {
        textSoFar += data.text;
        schedule();
      } else if (type === 'reset') {
        textSoFar = '';
        schedule();
      } else if (type === 'tool') {
        const li = document.createElement('div');
        li.className = 'step';
        li.textContent = `${data.label}…`;
        steps.appendChild(li);
        log.scrollTop = log.scrollHeight;
      } else if (type === 'done') {
        result = data;
      } else if (type === 'error') {
        failure = data.error;
      }
    });
  } catch (err) {
    failure = err.name === 'AbortError' ? null : err.message;
    if (err.name === 'AbortError') textSoFar += textSoFar ? '\n\n(Stopped.)' : '(Stopped.)';
  } finally {
    CHAT.busy = false;
    CHAT.abort = null;
    if (frame) cancelAnimationFrame(frame);
    bubble.classList.remove('live');
    if (result) {
      CHAT.conversationId = result.conversationId;
      textSoFar = result.reply;
      steps.querySelectorAll('.step').forEach((s) => s.classList.add('done'));
      if (!CHAT.status || result.mode !== CHAT.status.mode) chatStatus();
    }
    if (failure && !textSoFar) {
      bubble.className = 'msg error';
      bubble.textContent = failure;
    } else {
      paint();
      if (failure) chatAppend('error', esc(failure));
    }
    chatUpdateSend();
  }
}

// The send arrow is only active when there is text to send and no reply is pending.
function chatUpdateSend() {
  const btn = document.getElementById('chat-send');
  btn.classList.toggle('stop', CHAT.busy);
  btn.setAttribute('aria-label', CHAT.busy ? 'Stop answering' : 'Send message');
  btn.title = CHAT.busy ? 'Stop' : 'Send';
  // While the mic is on, Send is available too: it finishes the speech and sends it.
  btn.disabled = !CHAT.busy && !document.getElementById('chat-input').value.trim() && !VOICE.active();
}

// Voice input. Two engines, chosen automatically:
//  - cloud: the mic records a WAV clip and the server sends it to Google Cloud Speech, which detects
//    whether it is English, Hindi or Telugu. Nobody has to pick a language. Text appears after the
//    user stops speaking (click the mic again, or send).
//  - browser: when cloud speech is not set up, the browser's own recognition is used (Chrome/Edge),
//    listening as English (India), which also covers Hinglish and Tenglish in Roman letters.
// Either way the mic stays on until the user stops it, sends the message, or closes the chat.
const VOICE = {
  active: () => false,
  // Stops listening. With discard the speech is dropped; otherwise it lands in the box first.
  stop: async () => {},
};
const stopVoice = (discard = false) => VOICE.stop(discard);

function encodeWav(chunks, sampleRate) {
  const length = chunks.reduce((n, c) => n + c.length, 0);
  const view = new DataView(new ArrayBuffer(44 + length * 2));
  const text = (offset, s) => { for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i)); };
  text(0, 'RIFF'); view.setUint32(4, 36 + length * 2, true); text(8, 'WAVE');
  text(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, 'data'); view.setUint32(40, length * 2, true);
  let offset = 44;
  for (const c of chunks) {
    for (let i = 0; i < c.length; i++, offset += 2) {
      const s = Math.max(-1, Math.min(1, c[i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
  }
  return new Blob([view], { type: 'audio/wav' });
}

async function setupVoice(input) {
  const mic = document.getElementById('chat-mic');
  const setButton = (state) => {
    mic.classList.toggle('listening', state === 'listening');
    mic.classList.toggle('working', state === 'working');
    const label = { listening: 'Stop and use what I said', working: 'Transcribing…', idle: 'Speak your question (English, हिंदी or తెలుగు)' }[state];
    mic.setAttribute('aria-label', label);
    mic.title = label;
    mic.disabled = state === 'working';
    chatUpdateSend();
  };
  const append = (said) => {
    if (!said) return;
    input.value = (input.value ? input.value.replace(/\s*$/, ' ') : '') + said;
    chatUpdateSend();
  };

  let status = { enabled: false };
  try {
    status = await api('GET', '/speech/status');
  } catch { /* fall back to browser recognition */ }

  if (status.enabled && navigator.mediaDevices && window.AudioContext) {
    // ---------------- cloud engine
    const MAX_SECONDS = 55; // Google's quick recognize call is for clips under a minute
    let rec = null;
    let pending = null;

    const finish = async (discard) => {
      if (!rec) return pending;
      const r = rec;
      rec = null;
      clearTimeout(r.timer);
      r.source.disconnect();
      r.node.disconnect();
      r.stream.getTracks().forEach((t) => t.stop());
      r.ctx.close();
      if (discard || !r.chunks.length) {
        setButton('idle');
        return null;
      }
      setButton('working');
      const placeholder = input.placeholder;
      input.placeholder = 'Transcribing…';
      pending = (async () => {
        try {
          const res = await fetch(`/api/speech?language=${encodeURIComponent(chatLanguage())}`, { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: encodeWav(r.chunks, r.ctx.sampleRate) });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || res.statusText);
          if (!data.text) toast('No speech was recognised. Try again a little closer to the mic.', 'error');
          append(data.text);
        } catch (err) {
          toast(`Voice input failed: ${err.message}`, 'error');
        } finally {
          input.placeholder = placeholder;
          setButton('idle');
          pending = null;
          input.focus();
        }
      })();
      return pending;
    };

    const start = async () => {
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
      } catch (err) {
        toast(err.name === 'NotAllowedError' ? 'Microphone access is blocked. Allow it in the browser to use voice input.' : 'No microphone was found. Check that one is connected.', 'error');
        return;
      }
      const ctx = new AudioContext({ sampleRate: 16000 });
      const source = ctx.createMediaStreamSource(stream);
      // ScriptProcessor is simple and widely supported; it copies raw samples as they arrive.
      const node = ctx.createScriptProcessor(4096, 1, 1);
      const chunks = [];
      node.onaudioprocess = (e) => chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
      source.connect(node);
      node.connect(ctx.destination);
      rec = { stream, ctx, source, node, chunks, timer: setTimeout(() => { toast('Stopped after 55 seconds; transcribing what you said.'); finish(false); }, MAX_SECONDS * 1000) };
      setButton('listening');
    };

    VOICE.active = () => !!rec || !!pending;
    VOICE.stop = async (discard) => { await finish(discard); if (pending) await pending; };
    mic.addEventListener('click', () => (rec ? finish(false) : start()));
    setButton('idle');
    return;
  }

  // ---------------- browser engine (fallback)
  // Chrome and Edge recognise one language per session and cannot detect it, so this engine
  // listens as English (India). Telugu and Hindi speech need the Google engine above.
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) {
    mic.hidden = true;
    return;
  }
  const englishOnlyLabel = 'Speak in English (Telugu and Hindi voice needs Google speech set up)';
  let listening = false;
  let rec = null;
  let base = '';
  let quickEnds = 0;
  let silentEnds = 0;
  let ended = null;
  let savedPlaceholder = input.placeholder;
  let toldEnglishOnly = false;

  const idle = () => {
    setButton('idle');
    mic.title = englishOnlyLabel;
    mic.setAttribute('aria-label', englishOnlyLabel);
    input.placeholder = savedPlaceholder;
  };

  const startSession = () => {
    base = input.value ? input.value.replace(/\s*$/, ' ') : '';
    const started = Date.now();
    rec = new Recognition();
    rec.lang = 'en-IN';
    rec.interimResults = true;
    rec.continuous = true;
    rec.onresult = (ev) => {
      silentEnds = 0;
      input.value = base + [...ev.results].map((r) => r[0].transcript).join('');
      chatUpdateSend();
    };
    rec.onerror = (ev) => {
      if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') {
        listening = false;
        toast('Chrome is blocking the microphone. Click the mic icon in the address bar, choose Allow, then try again.', 'error');
      } else if (ev.error === 'audio-capture') {
        listening = false;
        toast('No microphone was found. Check that one is connected and selected in Chrome.', 'error');
      } else if (ev.error === 'network') {
        listening = false;
        toast("Chrome's speech service could not be reached. Check the internet connection.", 'error');
      } else if (ev.error === 'no-speech') {
        // Chrome heard nothing for several seconds. Say so once, instead of failing silently.
        silentEnds += 1;
        if (silentEnds === 1) {
          toast("I can't hear any English speech. Check Chrome is using the right microphone (mic icon in the address bar). Telugu and Hindi speech need Google speech set up.", 'error');
        }
      }
    };
    rec.onend = () => {
      rec = null;
      quickEnds = Date.now() - started < 1000 ? quickEnds + 1 : 0;
      if (quickEnds >= 5) {
        listening = false;
        toast('Voice input keeps stopping. Check the microphone and try again.', 'error');
      }
      if (listening) {
        setTimeout(() => { if (listening && !rec) startSession(); }, 150);
      } else {
        idle();
        if (ended) { ended(); ended = null; }
        input.focus();
      }
    };
    try {
      rec.start();
    } catch {
      rec = null;
      listening = false;
      idle();
    }
  };

  VOICE.active = () => listening || !!rec;
  VOICE.stop = (discard) => new Promise((resolve) => {
    listening = false;
    if (!rec) {
      idle();
      return resolve();
    }
    ended = resolve;
    if (discard) {
      rec.onresult = null;
      rec.abort();
    } else {
      rec.stop();
    }
  });

  mic.addEventListener('click', () => {
    if (listening) return VOICE.stop(false);
    if (!toldEnglishOnly) {
      toldEnglishOnly = true;
      toast('Voice is in English mode. To speak Telugu or Hindi, set up Google speech (see README); typing in Telugu or Hindi works now.');
    }
    listening = true;
    quickEnds = 0;
    silentEnds = 0;
    savedPlaceholder = input.placeholder;
    input.placeholder = 'Listening in English… click the mic to stop';
    setButton('listening');
    startSession();
  });
  idle();
}

function setupChat() {
  const panel = document.getElementById('chat');
  const toggle = document.getElementById('chat-toggle');
  const input = document.getElementById('chat-input');
  // Remember the chosen language on this computer (a per-viewer convenience, not stored on the server).
  const langBox = document.getElementById('chat-lang');
  try { const saved = localStorage.getItem('chatLanguage'); if (saved) langBox.value = saved; } catch {}
  langBox.addEventListener('change', () => { try { localStorage.setItem('chatLanguage', langBox.value); } catch {} });
  const open = (show) => {
    if (!show) stopVoice(true);
    panel.hidden = !show;
    toggle.hidden = show;
    toggle.setAttribute('aria-expanded', String(show));
    if (show) {
      chatSuggestions();
      input.focus();
    }
  };
  toggle.addEventListener('click', async () => {
    if (!CHAT.status) await chatStatus();
    if (!document.getElementById('chat-log').children.length) chatReset();
    open(true);
  });
  document.getElementById('chat-close').addEventListener('click', () => open(false));
  document.getElementById('chat-new').addEventListener('click', chatReset);
  document.getElementById('chat-suggest').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-q]');
    if (b) chatSend(b.dataset.q);
  });
  document.getElementById('chat-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    if (CHAT.busy) {
      if (CHAT.abort) CHAT.abort.abort();
      return;
    }
    // If the mic is on, finish turning speech into text first, then send everything.
    const send = () => {
      const t = input.value;
      if (!t.trim() || CHAT.busy) return;
      input.value = '';
      chatSend(t);
    };
    if (VOICE.active()) stopVoice(false).then(send);
    else send();
  });
  input.addEventListener('input', chatUpdateSend);
  setupVoice(input);
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      // Enter only sends; stopping an answer in progress takes a click on the stop button.
      if (!CHAT.busy) document.getElementById('chat-form').requestSubmit();
    }
  });
  window.addEventListener('hashchange', () => { if (!panel.hidden) chatSuggestions(); });
}

// ------------------------------------------------------------------ sign-in

function setSignedOutChrome(on) {
  document.querySelector('.mainnav').hidden = on;
  document.getElementById('signout').hidden = on;
  if (on) document.getElementById('whoami').textContent = '';
}

function signInScreen(message) {
  setSignedOutChrome(true);
  view(`<div class="card" style="max-width:380px;margin:40px auto">
    <div class="eyebrow">PolicyCenter</div><h1>Sign in</h1>
    ${message ? `<div class="banner error">${esc(message)}</div>` : ''}
    <form data-form="signin"><div class="form-errors"></div>
      ${field('Username', '<input name="username" autocomplete="username" required>')}
      ${field('Password', '<input name="password" type="password" autocomplete="current-password" required>')}
      <div class="toolbar" style="margin-top:12px"><button class="btn primary">Sign in</button></div>
    </form></div>`);
}

function changePasswordScreen(first) {
  setSignedOutChrome(true);
  view(`<div class="card" style="max-width:420px;margin:40px auto">
    <div class="eyebrow">${first ? 'Your first sign-in' : 'Account'}</div><h1>Choose a new password</h1>
    <p class="muted">${first ? 'Your password was set by your manager. Choose your own password to continue.' : 'Enter your current password and choose a new one.'}</p>
    <form data-form="change-password"><div class="form-errors"></div>
      ${field('Current password', '<input name="current" type="password" autocomplete="current-password" required>')}
      ${field('New password (at least 8 characters)', '<input name="next" type="password" minlength="8" autocomplete="new-password" required>')}
      ${field('Repeat new password', '<input name="confirm" type="password" minlength="8" autocomplete="new-password" required>')}
      <div class="toolbar" style="margin-top:12px"><button class="btn primary">Save password</button></div>
    </form></div>`);
}

// First start: until the first account has a password, the first person chooses the username and password.
function setupScreen() {
  setSignedOutChrome(true);
  view(`<div class="card" style="max-width:420px;margin:40px auto">
    <div class="eyebrow">First start</div><h1>Create your account</h1>
    <p class="muted">Choose the username and password for the UW Manager account. You use it to sign in and to create the other accounts. Nobody else can sign in until this is done.</p>
    <form data-form="setup"><div class="form-errors"></div>
      ${field('Username (3 to 30 letters, numbers or dots)', '<input name="username" autocomplete="username" required>')}
      ${field('Password (at least 8 characters)', '<input name="password" type="password" minlength="8" autocomplete="new-password" required>')}
      ${field('Repeat password', '<input name="confirm" type="password" minlength="8" autocomplete="new-password" required>')}
      <div class="toolbar" style="margin-top:12px"><button class="btn primary">Create account and sign in</button></div>
    </form></div>`);
}

async function boot() {
  const status = await (await fetch('/api/auth/status')).json();
  if (status.setupNeeded) return setupScreen();
  const r = await fetch('/api/auth/me');
  if (r.status === 401) return signInScreen();
  const data = await r.json();
  S.me = data.user;
  if (data.mustChangePassword) return changePasswordScreen(true);
  S.meta = await api('GET', '/meta');
  setSignedOutChrome(false);
  document.getElementById('whoami').textContent = `${S.me.name} · ${S.me.role}`;
  document.querySelectorAll('[data-nav="staff"], [data-nav="finance"], [data-nav="insights"]').forEach((el) => { el.hidden = S.me.role !== 'UW Manager'; });
  document.getElementById('signout').onclick = async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    location.hash = '#/desktop';
    signInScreen('You have signed out.');
  };
  window.addEventListener('hashchange', router);
  setupChat();
  router();
}

boot().catch((err) => view(`<div class="banner error">Could not start: ${esc(err.message)}</div>`));
