'use strict';
// B7 delivery: the Telegram transport behind the approval notifier.
//
// The notifier decided what to send and how often to retry; this decides how it leaves the building. The token and chat id come from the environment, the
// fetch is injected so no test dials out, and the message carries the signature so a receiver can tell a replay from a new approval.

const { AppError } = require('./appError');

const TELEGRAM_API = 'https://api.telegram.org';

const formatMessage = ({ payload, signature }) => [
  'Approval ' + payload.approvalId + (payload.jobNumber ? ' for job ' + payload.jobNumber : ''),
  payload.summary ? payload.summary : '',
  'Signature: ' + signature.slice(0, 16) + '…',
  'Sent: ' + payload.sentAt,
].filter(Boolean).join('\n');

function createTelegramTransport({ token = process.env.TELEGRAM_BOT_TOKEN, chatId = process.env.TELEGRAM_CHAT_ID, fetchImpl = globalThis.fetch, api = TELEGRAM_API } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('a fetch implementation is required');

  async function send({ payload, signature } = {}) {
    if (!token) throw new AppError(503, 'Telegram is not configured: TELEGRAM_BOT_TOKEN is missing.');
    if (!chatId) throw new AppError(503, 'Telegram is not configured: TELEGRAM_CHAT_ID is missing.');
    if (!payload || !payload.approvalId) throw new AppError(422, 'a payload with an approval id is required');
    const response = await fetchImpl(api + '/bot' + token + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: formatMessage({ payload, signature: signature || '' }), disable_web_page_preview: true }),
    });
    const text = await response.text();
    let body;
    try { body = text ? JSON.parse(text) : null; } catch { body = null; }
    if (!response.ok || (body && body.ok === false)) {
      throw new AppError(502, 'Telegram refused the message (' + response.status + '): ' + ((body && body.description) || text.slice(0, 100)));
    }
    return { delivered: true, messageId: body && body.result ? body.result.message_id : null };
  }

  return { send, configured: Boolean(token && chatId), formatMessage };
}

module.exports = { createTelegramTransport, formatMessage };
