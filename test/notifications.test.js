'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { setup } = require('./helpers');
const { AuditLog } = require('../src/audit');
const { AgentService } = require('../src/agents');
const { Notifier, validTwilioSignature } = require('../src/notifications');

// Telling a person that an agent is waiting: Telegram first, a phone call after ten minutes, and the decision carried back
// as the approver. The two outside services are fakes here — no bot, no phone account, no network.

function world() {
  const env = setup('2026-03-01');
  const audit = new AuditLog(env.pc);
  const agents = new AgentService(env.pc, { audit });
  env.run(() => agents.ensureAccounts()); // the agent accounts carry the names used in the messages
  const telegram = {
    channel: 'telegram', chatId: '4242', configured: true, sent: [],
    async send(message) { this.sent.push(message); return { messageId: 7 }; },
    async answerCallback() {},
  };
  const voice = {
    channel: 'voice', configured: true, calls: [],
    async call(call) { this.calls.push(call); return { sid: 'CA123' }; },
  };
  let now = Date.parse('2026-03-01T10:00:00Z');
  const notifier = new Notifier(env.pc, {
    telegram, voice, agents, clock: () => now, escalateMinutes: 10, approver: 'uwm', publicUrl: 'https://example.test',
  });
  // A suggestion that proposes an action — the kind that needs a person.
  const add = (over = {}) => env.run(() => env.pc.db.agentSuggestions.push({
    id: 'sug1', number: 'SUG-0000001', agentId: 'renewal', kind: 'start_renewal', status: 'Open',
    summary: 'Start the renewal of PA-0000001', reasons: ['The term ends in 30 days'], proposed: { action: 'contact', params: {} },
    subject: { policyNumber: 'PA-0000001' }, dedupeKey: 'k1', createdAt: '2026-03-01', ...over,
  }));
  const advance = (minutes) => { now += minutes * 60000; };
  const stored = () => env.pc.db.agentSuggestions.find((s) => s.number === 'SUG-0000001');
  return { ...env, agents, telegram, voice, notifier, add, advance, stored };
}

test('a suggestion that proposes an action is sent to Telegram, with the reasons and two buttons', async () => {
  const w = world();
  w.add();
  const summary = await w.notifier.work();
  assert.equal(summary.sent, 1);
  assert.equal(w.telegram.sent.length, 1);
  assert.match(w.telegram.sent[0].text, /Renewal agent/);
  assert.match(w.telegram.sent[0].text, /SUG-0000001/);
  assert.match(w.telegram.sent[0].text, /term ends in 30 days/);
  const buttons = w.telegram.sent[0].buttons[0];
  assert.deepEqual(buttons.map((b) => b.callback_data), ['d:SUG-0000001:accept', 'd:SUG-0000001:dismiss']);
  assert.equal(w.stored().notify.telegram.status, 'sent');
});

test('an escalation reaches the phone as a link to the app, and is never called', async () => {
  const w = world();
  w.add({ kind: 'escalate', proposed: null, summary: 'PA-0000002 is 171 days overdue: a cancellation notice needs a decision' });
  const summary = await w.notifier.work();
  assert.equal(summary.sent, 1);
  assert.deepEqual(w.telegram.sent[0].buttons[0], [{ text: 'Open the app', url: 'https://example.test' }], 'no approve button for something the phone cannot decide');
  w.advance(30);
  await w.notifier.work();
  assert.equal(w.voice.calls.length, 0, 'the decision belongs in the app, so nobody is called');
});

test('a compliance finding is information, so nobody is pinged', async () => {
  const w = world();
  w.add({ agentId: 'compliance', kind: 'finding', proposed: null, summary: 'A reason names a protected trait' });
  const summary = await w.notifier.work();
  assert.equal(summary.sent, 0);
  assert.equal(w.telegram.sent.length, 0);
});

test('no answer after ten minutes becomes one phone call, not two', async () => {
  const w = world();
  w.add();
  await w.notifier.work();
  await w.notifier.work();
  assert.equal(w.voice.calls.length, 0, 'nothing before the wait is over');

  w.advance(11);
  const escalated = await w.notifier.work();
  assert.equal(escalated.escalated, 1);
  assert.equal(w.voice.calls.length, 1);
  assert.match(w.voice.calls[0].url, /\/api\/webhooks\/twilio\/voice\?n=SUG-0000001&t=[0-9a-f]{32}$/);
  assert.equal(w.stored().notify.voice.status, 'called');

  w.advance(30);
  await w.notifier.work();
  assert.equal(w.voice.calls.length, 1, 'the call is made once');
});

test('a decision in the app stops the call', async () => {
  const w = world();
  w.add();
  await w.notifier.work();
  w.run(() => w.agents.decide('SUG-0000001', { decision: 'dismiss' }, w.users.uwm));
  w.advance(11);
  await w.notifier.work();
  assert.equal(w.voice.calls.length, 0);
});

test('a tapped Telegram button decides as the approver, and only from the configured chat', async () => {
  const w = world();
  w.add();
  const update = { callback_query: { message: { chat: { id: 4242 } }, data: 'd:SUG-0000001:dismiss' } };
  const result = w.notifier.handleTelegramUpdate(update, { secret: 's3cret', expectedSecret: 's3cret' });
  assert.equal(result.status, 'Dismissed');
  assert.equal(w.stored().decidedBy, 'uwm', 'the decision runs as the approver, not as a bot');
  assert.equal(w.stored().notify.telegram.answeredBy, 'uwm');
  assert.ok(w.pc.db.auditLog.some((entry) => entry.action === 'suggestion.dismissed'));

  w.add({ id: 'sug2', number: 'SUG-0000002', dedupeKey: 'k2' });
  assert.throws(() => w.notifier.handleTelegramUpdate({ callback_query: { message: { chat: { id: 4242 } }, data: 'd:SUG-0000002:accept' } }, { secret: 'wrong', expectedSecret: 's3cret' }), (error) => error.status === 401);
  assert.throws(() => w.notifier.handleTelegramUpdate({ callback_query: { message: { chat: { id: 9999 } }, data: 'd:SUG-0000002:accept' } }, { secret: 's3cret', expectedSecret: 's3cret' }), (error) => error.status === 403);
});

test('the phone call speaks the summary, and a keypress decides', async () => {
  const w = world();
  w.add();
  await w.notifier.work();
  w.advance(11);
  await w.notifier.work();
  const token = w.stored().notify.voice.token;

  const script = w.notifier.voiceScript('SUG-0000001', token);
  assert.match(script.twiml, /Start the renewal of PA-0000001/);
  assert.match(script.twiml, /Press 1 to approve/);
  assert.match(script.twiml, new RegExp(`action="https://example.test/api/webhooks/twilio/decision\\?n=SUG-0000001&amp;t=${token}"`));

  assert.equal(w.notifier.voiceScript('SUG-0000001', 'wrong'), null, 'a guessed token gets nothing');
  const decided = w.notifier.handleVoiceKeypress({ number: 'SUG-0000001', token, digits: '1' });
  assert.equal(decided.status, 'Accepted');
  assert.equal(w.stored().decidedBy, 'uwm');

  w.add({ id: 'sug2', number: 'SUG-0000002', dedupeKey: 'k2' });
  await w.notifier.work();
  w.advance(11);
  await w.notifier.work();
  const second = w.pc.db.agentSuggestions.find((candidate) => candidate.number === 'SUG-0000002');
  const status = w.notifier.handleVoiceKeypress({ number: 'SUG-0000002', token: second.notify.voice.token, digits: '2' }).status;
  assert.equal(status, 'Dismissed');
});

test('a keypress is accepted only when it carries a valid Twilio signature', () => {
  const authToken = 'test-token';
  const url = 'https://example.test/api/webhooks/twilio/decision?n=SUG-0000001&t=abc';
  const params = { Digits: '1', CallSid: 'CA1' };
  // Twilio's rule: the full URL, then every form field sorted by name as name + value.
  const data = url + Object.keys(params).sort().map((key) => key + params[key]).join('');
  const signature = crypto.createHmac('sha1', authToken).update(Buffer.from(data, 'utf8')).digest('base64');
  assert.equal(validTwilioSignature({ authToken, url, params, signature }), true);
  assert.equal(validTwilioSignature({ authToken, url, params, signature: 'nope' }), false);
  assert.equal(validTwilioSignature({ authToken: '', url, params, signature }), false);
});
