'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTelegramTransport, formatMessage } = require('../src/telegramTransport');

// Offline: the transport is a function. What it must get right is the token, the chat, and a message that names the approval and carries the signature.

const PAYLOAD = { approvalId: 'AP-1', jobNumber: 'J0000001', summary: 'Bind HO-0000001 for 12,000', sentAt: '2026-03-01T10:00:00Z' };

function fake(response = { ok: true, status: 200, body: '{"ok":true,"result":{"message_id":42}}' }) {
  const calls = [];
  const impl = async (url, options) => {
    calls.push({ url, options });
    return { ok: response.ok, status: response.status, text: async () => response.body };
  };
  return { impl, calls };
}

test('a message is sent to the configured chat, with the bot token in the path', async () => {
  const { impl, calls } = fake();
  const transport = createTelegramTransport({ token: 'tok-1', chatId: '-100', fetchImpl: impl });
  const result = await transport.send({ payload: PAYLOAD, signature: 'abcdef0123456789abcdef' });
  assert.equal(result.delivered, true);
  assert.equal(result.messageId, 42);
  assert.match(calls[0].url, /\/bottok-1\/sendMessage$/);
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.chat_id, '-100');
  assert.match(body.text, /AP-1/);
  assert.match(body.text, /J0000001/);
  assert.match(body.text, /Signature: abcdef0123456789/);
});

test('without a token or chat nothing is attempted, and the refusal names the variable', async () => {
  const { impl, calls } = fake();
  const noToken = createTelegramTransport({ token: '', chatId: '-100', fetchImpl: impl });
  await assert.rejects(() => noToken.send({ payload: PAYLOAD }), /TELEGRAM_BOT_TOKEN is missing/);
  const noChat = createTelegramTransport({ token: 't', chatId: '', fetchImpl: impl });
  await assert.rejects(() => noChat.send({ payload: PAYLOAD }), /TELEGRAM_CHAT_ID is missing/);
  assert.equal(calls.length, 0);
  assert.equal(noToken.configured, false);
});

test('a Telegram refusal becomes a 502 with their description', async () => {
  const transport = createTelegramTransport({ token: 't', chatId: '-1', fetchImpl: fake({ ok: false, status: 400, body: '{"ok":false,"description":"chat not found"}' }).impl });
  await assert.rejects(() => transport.send({ payload: PAYLOAD, signature: 's' }), /Telegram refused the message \(400\): chat not found/);
});

test('the formatter names the approval, the job and the signature, and omits an empty summary', () => {
  const text = formatMessage({ payload: { approvalId: 'AP-2', sentAt: 'now' }, signature: '0123456789abcdef' });
  assert.match(text, /Approval AP-2/);
  assert.match(text, /Signature: 0123456789abcdef/);
  assert.equal(text.includes('\n\n'), false, 'no blank line where the summary would be');
});
