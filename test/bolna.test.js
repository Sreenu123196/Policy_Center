'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createBolna } = require('../src/bolna');

// Offline: the transport is a function, so nothing here reaches Bolna.

function fake(response = { ok: true, status: 200, body: '{"id":"call-1"}' }) {
  const calls = [];
  const impl = async (url, options) => {
    calls.push({ url, options });
    return { ok: response.ok, status: response.status, text: async () => response.body };
  };
  return { impl, calls };
}

test('a call is placed with the agent, the number and the script variables, and a bearer token', async () => {
  const { impl, calls } = fake();
  const bolna = createBolna({ apiKey: 'k-123', agentId: 'agent-9', fetchImpl: impl });
  const result = await bolna.startCall({ to: '+919990001111', variables: { claimNumber: 'CL-0000001' } });
  assert.equal(result.id, 'call-1');
  assert.equal(calls[0].url, 'https://api.bolna.ai/call');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer k-123');
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.agent_id, 'agent-9');
  assert.equal(body.recipient_phone_number, '+919990001111');
  assert.deepEqual(body.user_data, { claimNumber: 'CL-0000001' });
});

test('without a key nothing is attempted, and the refusal says which variable is missing', async () => {
  const { impl, calls } = fake();
  const bolna = createBolna({ apiKey: '', agentId: 'agent-9', fetchImpl: impl });
  await assert.rejects(() => bolna.startCall({ to: '+91' }), /BOLNA_API_KEY is missing/);
  assert.equal(calls.length, 0, 'no request was made');
  assert.equal(bolna.configured, false);
});

test('a missing recipient or call id is refused before any request', async () => {
  const { impl, calls } = fake();
  const bolna = createBolna({ apiKey: 'k', agentId: 'a', fetchImpl: impl });
  await assert.rejects(() => bolna.startCall({}), /recipient number is required/);
  await assert.rejects(() => bolna.getCall(''), /call id is required/);
  assert.equal(calls.length, 0);
});

test('an error from Bolna becomes a 502 carrying their message, not a silent null', async () => {
  const bolna = createBolna({ apiKey: 'k', agentId: 'a', fetchImpl: fake({ ok: false, status: 401, body: '{"message":"bad key"}' }).impl });
  await assert.rejects(() => bolna.getCall('call-1'), /Bolna refused the request \(401\): bad key/);
});

test('the webhook keeps the status verbatim and never invents a transcript', () => {
  const bolna = createBolna({ apiKey: 'k', agentId: 'a', fetchImpl: async () => ({ ok: true, status: 200, text: async () => '{}' }) });
  const parsed = bolna.parseWebhook({ call_id: 'c1', status: 'no-answer', duration: '12' });
  assert.equal(parsed.status, 'no-answer');
  assert.equal(parsed.transcript, null, 'nothing was said, so nothing is recorded');
  assert.equal(parsed.durationSeconds, 12);
  assert.throws(() => bolna.parseWebhook({ status: 'completed' }), /no call id/);
});
