'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, account, autoSubmission } = require('./helpers');
const { Documents, DOC_LABELS, DOC_NAMES } = require('../src/documents');
const { Messaging } = require('../src/messaging');

// Documents (Tier 3, item 8): the same document in English, Hindi or Telugu, an electronic signature that fixes what was
// signed, and delivery by email or WhatsApp. Names and numbers are never translated; the fixed wording is.

function world({ email = true, whatsapp = true } = {}) {
  const env = setup('2026-03-01');
  const { pc, users, run } = env;
  const acct = run(() => account(pc, users.agent, { firstName: 'Asha', lastName: 'Rao', email: 'asha@example.com', phone: '9876543210' }));
  const job = run(() => autoSubmission(pc, users.agent, acct, '2026-03-01'));
  run(() => pc.quote(job.id, users.agent));
  run(() => pc.bind(job.id, users.agent));
  const sent = { email: [], whatsapp: [] };
  const transport = (channel) => ({ status: () => ({ enabled: true }), send: (message) => { sent[channel].push(message); return { id: `${channel}-1` }; } });
  const messaging = new Messaging(pc, { transports: { ...(email ? { email: transport('email') } : {}), ...(whatsapp ? { whatsapp: transport('whatsapp') } : {}) } });
  const documents = new Documents(pc, messaging);
  const policy = pc.policy(job.policyId);
  const declarations = pc.db.documents.find((d) => d.policyId === policy.id && d.name === 'Declarations Page');
  return { ...env, acct, policy, documents, declarations, sent };
}

test('a document is made in English, Hindi or Telugu: the fixed words change, names and numbers do not', () => {
  const { documents, users, declarations, policy } = world();
  for (const language of ['en', 'hi', 'te']) {
    const doc = documents.render(users.agent, declarations.id, { language });
    const labels = DOC_LABELS[language];
    assert.equal(doc.language, language);
    assert.ok(doc.html.includes(labels.policyNumber), `${language}: policy number label`);
    assert.ok(doc.html.includes(DOC_NAMES[language]['Declarations Page']), `${language}: document name`);
    assert.ok(doc.html.includes(labels.total) && doc.html.includes(labels.premium), `${language}: premium labels`);
    assert.ok(doc.html.includes(policy.policyNumber) && doc.html.includes('Asha Rao'), `${language}: names and numbers stay`);
    assert.ok(doc.html.includes(`lang="${language}"`));
    assert.ok(doc.text.includes(policy.policyNumber));
  }
  assert.match(documents.render(users.agent, declarations.id, { language: 'hi' }).html, /[ऀ-ॿ]/);
  assert.match(documents.render(users.agent, declarations.id, { language: 'te' }).html, /[ఀ-౿]/);
  assert.throws(() => documents.render(users.agent, declarations.id, { language: 'fr' }), (e) => e.status === 422);
});

test('what a customer typed is shown as text, never as markup', () => {
  const { documents, users, declarations, pc } = world();
  pc.db.accounts[0].firstName = '<script>alert(1)</script>';
  const html = documents.render(users.agent, declarations.id, {}).html;
  assert.ok(!html.includes('<script>alert'));
  assert.ok(html.includes('&lt;script&gt;'));
});

test('an agent sees the documents of their own customers only', () => {
  const { documents, declarations, pc } = world();
  assert.throws(() => documents.render(pc.user('agent2'), declarations.id, {}), (e) => e.status === 404);
});

test('signing: the insured signs by typing their name and agreeing; it records who, when, in which language, and a fingerprint', () => {
  const env = world();
  const { documents, users, declarations, run } = env;
  const signature = run(() => documents.sign(users.agent, declarations.id, { signerName: '  asha   RAO ', consent: true, language: 'hi' }));
  assert.deepEqual([signature.signerName, signature.language, signature.method, signature.capturedBy], ['Asha Rao', 'hi', 'typed_name', users.agent.id]);
  assert.match(signature.contentHash, /^[0-9a-f]{64}$/);
  assert.ok(signature.signedAt);
  const doc = documents.render(users.agent, declarations.id, {});
  assert.equal(doc.signed, true);
  assert.ok(doc.html.includes(DOC_LABELS.hi.signedBy) && doc.html.includes('Asha Rao'));
});

test('signing is refused without agreement, with another name, or a second time', () => {
  const env = world();
  const { documents, users, declarations, run } = env;
  assert.throws(() => run(() => documents.sign(users.agent, declarations.id, { signerName: 'Asha Rao', consent: false })), (e) => e.status === 422);
  assert.throws(() => run(() => documents.sign(users.agent, declarations.id, { signerName: 'Someone Else', consent: true })), (e) => e.status === 422 && /name/i.test(e.message));
  run(() => documents.sign(users.agent, declarations.id, { signerName: 'Asha Rao', consent: true }));
  assert.throws(() => run(() => documents.sign(users.agent, declarations.id, { signerName: 'Asha Rao', consent: true })), (e) => e.status === 409);
});

test('a signed document is fixed: later changes to the policy or a different language request do not change it', () => {
  const env = world();
  const { documents, users, declarations, run, pc } = env;
  run(() => documents.sign(users.agent, declarations.id, { signerName: 'Asha Rao', consent: true, language: 'en' }));
  const before = documents.render(users.agent, declarations.id, {}).html;
  pc.db.accounts[0].address.line1 = '99 Changed Road';
  assert.equal(documents.render(users.agent, declarations.id, { language: 'te' }).html, before);
  assert.ok(!before.includes('99 Changed Road'));
});

test('verification says whether a signed document still matches its fingerprint', () => {
  const env = world();
  const { documents, users, declarations, run, pc } = env;
  assert.deepEqual(documents.verify(users.agent, declarations.id), { signed: false });
  run(() => documents.sign(users.agent, declarations.id, { signerName: 'Asha Rao', consent: true }));
  assert.deepEqual(documents.verify(users.agent, declarations.id), { signed: true, valid: true, signerName: 'Asha Rao', signedAt: declarations.signature.signedAt, language: 'en' });
  pc.db.documents.find((d) => d.id === declarations.id).signature.signedHtml += ' tampered';
  assert.equal(documents.verify(users.agent, declarations.id).valid, false);
});

test('delivery by email sends the document in the chosen language and keeps a record', () => {
  const env = world();
  const { documents, users, declarations, sent, pc, run } = env;
  assert.throws(() => run(() => documents.deliver(users.agent, declarations.id, { channel: 'email', language: 'te' })), (e) => e.status === 422 && /confirm/i.test(e.message));
  const record = run(() => documents.deliver(users.agent, declarations.id, { channel: 'email', language: 'te', confirm: true }));
  assert.deepEqual([record.status, record.channel, record.template, record.language, record.to], ['Sent', 'email', 'document', 'te', 'asha@example.com']);
  assert.equal(sent.email.length, 1);
  assert.ok(sent.email[0].subject.includes(DOC_NAMES.te['Declarations Page']));
  assert.match(sent.email[0].html, /[ఀ-౿]/);
  assert.ok(pc.db.messages.some((m) => m.id === record.id && m.accountId === env.acct.id));
});

test('delivery by WhatsApp sends the approved template with the document name and policy number', () => {
  const env = world();
  const { documents, users, declarations, sent, policy, run } = env;
  const record = run(() => documents.deliver(users.agent, declarations.id, { channel: 'whatsapp', language: 'hi', confirm: true }));
  assert.equal(record.status, 'Sent');
  assert.deepEqual([sent.whatsapp[0].template, sent.whatsapp[0].language, sent.whatsapp[0].to], ['document_ready', 'hi', '919876543210']);
  assert.deepEqual(sent.whatsapp[0].params, ['Asha Rao', DOC_NAMES.hi['Declarations Page'], policy.policyNumber]);
});

test('delivery is refused when the channel is not set up or the customer has no address for it', () => {
  const none = world({ email: false });
  assert.throws(() => none.run(() => none.documents.deliver(none.users.agent, none.declarations.id, { channel: 'email', confirm: true })), (e) => e.status === 422 && /not set up/i.test(e.message));
  const env = world();
  env.pc.db.accounts[0].email = '';
  assert.throws(() => env.run(() => env.documents.deliver(env.users.agent, env.declarations.id, { channel: 'email', confirm: true })), (e) => e.status === 422 && /email address/i.test(e.message));
});

test('a failed delivery is recorded as failed, not lost', () => {
  const env = world();
  const failing = { status: () => ({ enabled: true }), send: () => { throw new Error('mailbox full'); } };
  const documents = new Documents(env.pc, new Messaging(env.pc, { transports: { email: failing } }));
  const record = env.run(() => documents.deliver(env.users.agent, env.declarations.id, { channel: 'email', confirm: true }));
  assert.deepEqual([record.status, record.error], ['Failed', 'mailbox full']);
});
