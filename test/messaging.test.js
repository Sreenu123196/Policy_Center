'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, account, autoSubmission } = require('./helpers');
const { Messaging, TEMPLATES, normalizePhone, fill } = require('../src/messaging');

// Fake transports: record what would be sent. No network.
function fakeTransports({ emailOn = true, whatsappOn = true, fail = false } = {}) {
  const sent = { email: [], whatsapp: [] };
  const make = (channel, on) => ({
    status: () => (on ? { enabled: true } : { enabled: false, reason: 'not configured in test' }),
    send: (msg) => {
      if (fail) throw new Error('provider timed out');
      sent[channel].push(msg);
      return { id: `${channel}-${sent[channel].length}` };
    },
  });
  return { sent, transports: { email: make('email', emailOn), whatsapp: make('whatsapp', whatsappOn) } };
}

function customerWithPolicy() {
  const env = setup('2026-03-01');
  const { pc, users, run } = env;
  const acct = run(() => account(pc, users.agent, { phone: '98765 43210', email: 'ravi@example.com', firstName: 'Ravi' }));
  const job = run(() => autoSubmission(pc, users.agent, acct, '2026-03-01'));
  run(() => pc.quote(job.id, users.agent));
  run(() => pc.bind(job.id, users.agent));
  return { ...env, acct, policy: pc.policy(job.policyId) };
}

test('messages: templates exist in English, Hindi and Telugu and use only listed variables', () => {
  for (const t of Object.values(TEMPLATES)) {
    for (const lang of ['en', 'hi', 'te']) {
      assert.ok(t[lang].subject && t[lang].body, `${lang} text exists`);
      for (const m of t[lang].body.matchAll(/\{(\w+)\}/g)) assert.ok(t.params.includes(m[1]), `${m[1]} is listed in params`);
    }
  }
  assert.equal(fill('Hi {name}, {missing}', { name: 'Ravi' }), 'Hi Ravi, {missing}', 'unknown placeholders are left visible');
});

test('messages: phone numbers are normalised; 10 digits are treated as Indian mobiles', () => {
  assert.equal(normalizePhone('98765 43210'), '919876543210');
  assert.equal(normalizePhone('+1 (512) 555-0142'), '15125550142');
  assert.equal(normalizePhone('12345'), null);
});

test('messages: preview renders the message without sending anything', () => {
  const { pc, users, acct, policy } = customerWithPolicy();
  const { sent, transports } = fakeTransports();
  const m = new Messaging(pc, { transports });
  const p = m.preview({ accountId: acct.id, policyId: policy.id, channel: 'email', template: 'renewal', language: 'hi' }, users.agent);
  assert.match(p.body, /नमस्ते Ravi/);
  assert.match(p.body, new RegExp(policy.policyNumber));
  assert.equal(p.to, 'ravi@example.com');
  assert.equal(sent.email.length, 0);
  assert.equal(pc.db.messages.length, 0);
});

test('messages: nothing is sent without confirmation', () => {
  const { pc, users, acct, policy } = customerWithPolicy();
  const { sent, transports } = fakeTransports();
  const m = new Messaging(pc, { transports });
  assert.throws(() => m.send({ accountId: acct.id, policyId: policy.id, channel: 'email', template: 'renewal', language: 'en' }, users.agent), /confirm/);
  assert.equal(sent.email.length, 0);
});

test('messages: a confirmed email is sent in the chosen language and saved on the customer record', () => {
  const { pc, users, acct, policy } = customerWithPolicy();
  const { sent, transports } = fakeTransports();
  const m = new Messaging(pc, { transports });
  const rec = m.send({ accountId: acct.id, policyId: policy.id, channel: 'email', template: 'lapse', language: 'te', confirm: true }, users.agent);
  assert.equal(rec.status, 'Sent');
  assert.match(rec.messageNumber, /^MSG-\d{7}$/);
  assert.equal(sent.email.length, 1);
  assert.equal(sent.email[0].to, 'ravi@example.com');
  assert.match(sent.email[0].text, /నమస్కారం Ravi/);
  const onRecord = pc.accountDetail(acct.id, users.agent).messages;
  assert.equal(onRecord.length, 1);
  assert.equal(onRecord[0].sentByName, 'Alex Agent');
  assert.equal(onRecord[0].providerId, 'email-1');
});

test('messages: WhatsApp uses the phone number and the template parameters in order', () => {
  const { pc, users, acct, policy } = customerWithPolicy();
  const { sent, transports } = fakeTransports();
  const m = new Messaging(pc, { transports });
  m.send({ accountId: acct.id, policyId: policy.id, channel: 'whatsapp', template: 'renewal', language: 'en', confirm: true }, users.agent);
  assert.equal(sent.whatsapp[0].to, '919876543210');
  assert.equal(sent.whatsapp[0].template, 'renewal');
  assert.equal(sent.whatsapp[0].params[0], 'Ravi Insured');
  assert.equal(sent.whatsapp[0].params[1], policy.policyNumber);
});

test('messages: a channel that is not set up refuses to send, with the reason', () => {
  const { pc, users, acct, policy } = customerWithPolicy();
  const { transports } = fakeTransports({ whatsappOn: false });
  const m = new Messaging(pc, { transports });
  assert.throws(() => m.send({ accountId: acct.id, policyId: policy.id, channel: 'whatsapp', template: 'renewal', language: 'en', confirm: true }, users.agent), /WhatsApp is not set up/);
  assert.equal(m.status().channels.whatsapp.enabled, false);
});

test('messages: a provider failure is saved as Failed, with the error', () => {
  const { pc, users, acct, policy } = customerWithPolicy();
  const { transports } = fakeTransports({ fail: true });
  const m = new Messaging(pc, { transports });
  const rec = m.send({ accountId: acct.id, policyId: policy.id, channel: 'email', template: 'renewal', language: 'en', confirm: true }, users.agent);
  assert.equal(rec.status, 'Failed');
  assert.equal(rec.error, 'provider timed out');
  assert.equal(pc.accountDetail(acct.id, users.agent).messages[0].status, 'Failed');
});

test('messages: agents message only their own customers', () => {
  const { pc, users, acct, policy } = customerWithPolicy();
  const { transports } = fakeTransports();
  const m = new Messaging(pc, { transports });
  assert.throws(() => m.send({ accountId: acct.id, policyId: policy.id, channel: 'email', template: 'renewal', language: 'en', confirm: true }, pc.user('agent2')), /not found/i);
  assert.throws(() => m.messagesFor(acct.id, pc.user('agent2')), /not found/i);
});

test('messages: claim updates use the claim, never show reserves, and write the status in the language', () => {
  const { pc, users, acct, policy } = customerWithPolicy();
  const claim = pc.openClaim(policy.id, { lossDate: '2026-03-01', lossType: 'Theft' }, users.agent);
  pc.setClaimReserve(claim.id, 5000, users.uw);
  pc.payClaim(claim.id, { amount: 300 }, users.uw);
  const { sent, transports } = fakeTransports();
  const m = new Messaging(pc, { transports });
  m.send({ accountId: acct.id, claimId: claim.id, channel: 'email', template: 'claim_update', language: 'hi', confirm: true }, users.agent);
  assert.match(sent.email[0].text, new RegExp(claim.claimNumber));
  assert.match(sent.email[0].text, /\$300\.00/);
  assert.doesNotMatch(sent.email[0].text, /5000/);
  assert.match(sent.email[0].text, /खुला है/, 'the status is written in Hindi');
});

test('messages: a template that needs a policy or a claim is refused without one', () => {
  const { pc, users, acct } = customerWithPolicy();
  const { transports } = fakeTransports();
  const m = new Messaging(pc, { transports });
  assert.throws(() => m.preview({ accountId: acct.id, channel: 'email', template: 'renewal', language: 'en' }, users.agent), /needs a policy/);
  assert.throws(() => m.preview({ accountId: acct.id, channel: 'email', template: 'claim_update', language: 'en' }, users.agent), /needs a claim/);
});
