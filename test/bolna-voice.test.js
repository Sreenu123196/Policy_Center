'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createBolnaVoice } = require('../src/bolnaVoice');

// The transport must fit the notifier's call({to, url}) shape while sending what Bolna actually needs.

test('a call is placed with the approver number and the approval token from the url', async () => {
  const calls = [];
  const fake = { configured: true, startCall: async (input) => { calls.push(input); return { id: 'call-1' }; } };
  const voice = createBolnaVoice({ bolna: fake });
  const result = await voice.call({ to: '+919990001111', url: 'https://api.example/api/webhooks/twilio/voice?n=SUG-1&t=abc123' });
  assert.equal(result.provider, 'bolna');
  assert.equal(result.sid, 'call-1');
  assert.equal(calls[0].to, '+919990001111');
  assert.equal(calls[0].variables.approvalToken, 'abc123');
});

test('an unconfigured client refuses rather than pretending to call', async () => {
  const voice = createBolnaVoice({ bolna: { configured: false, startCall: async () => ({}) } });
  await assert.rejects(() => voice.call({ to: '+91', url: 'https://x' }), /Bolna is not configured/);
  assert.equal(voice.configured, false);
});

test('an approver number is required', async () => {
  const voice = createBolnaVoice({ bolna: { configured: true, startCall: async () => ({}) } });
  await assert.rejects(() => voice.call({ url: 'https://x' }), /approver number is required/);
});

test('the id Bolna returns is the execution id, and the status is kept', async () => {
  const fake = { configured: true, startCall: async () => ({ status: 'queued', execution_id: 'exec-9' }) };
  const result = await createBolnaVoice({ bolna: fake }).call({ to: '+91', url: 'https://x?t=1' });
  assert.equal(result.sid, 'exec-9');
  assert.equal(result.status, 'queued');
});
