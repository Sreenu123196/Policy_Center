'use strict';
// B7 (repository side): telling a person an approval is waiting.
//
// The Telegram bot lives in another service, so what belongs here is the contract: a signed payload, an attempt log, retries with a cap, and a queue
// that refuses to send the same approval twice. The transport is injected - tests never touch the network, and a real channel is wired in one place.

const crypto = require('node:crypto');
const { AppError } = require('./appError');

const MAX_ATTEMPTS = 4;

function createApprovalNotifier({ store, transport, secret, now = () => new Date().toISOString() } = {}) {
  if (typeof transport !== 'function') throw new Error('a transport function is required');
  const outbox = () => {
    store.data.approvalOutbox = store.data.approvalOutbox || [];
    return store.data.approvalOutbox;
  };

  function sign(payload) {
    if (!secret) throw new AppError(500, 'A signing secret is required to notify');
    return crypto.createHmac('sha256', secret).update(JSON.stringify(payload)).digest('hex');
  }

  /** Queue a notification for one approval. A second call for the same approval returns the first, so a retry cannot double-notify. */
  function enqueue({ approvalId, jobNumber, summary }) {
    if (!approvalId) throw new AppError(422, 'an approval id is required');
    // Fail here rather than at send time: a message queued without a secret would sit in the outbox looking deliverable.
    if (!secret) throw new AppError(500, 'A signing secret is required to notify');
    const existing = outbox().find((m) => m.approvalId === approvalId);
    if (existing) return existing;
    const message = {
      id: 'NTF-' + String(store.next('approvalNotification')).padStart(6, '0'),
      approvalId,
      jobNumber: jobNumber || null,
      summary: summary || null,
      status: 'queued',
      attempts: 0,
      lastError: null,
      createdAt: now(),
      deliveredAt: null,
    };
    outbox().push(message);
    return message;
  }

  /** Deliver everything queued. The payload is signed over the message's identity and content, so a receiver can tell a replay from a new request. */
  async function deliver() {
    const results = [];
    for (const message of outbox()) {
      if (message.status === 'delivered' || message.attempts >= MAX_ATTEMPTS) continue;
      const payload = { id: message.id, approvalId: message.approvalId, jobNumber: message.jobNumber, summary: message.summary, sentAt: now() };
      message.attempts += 1;
      try {
        await transport({ payload, signature: sign(payload) });
        message.status = 'delivered';
        message.deliveredAt = payload.sentAt;
        message.lastError = null;
        results.push({ id: message.id, status: 'delivered' });
      } catch (err) {
        message.lastError = err.message;
        message.status = message.attempts >= MAX_ATTEMPTS ? 'failed' : 'queued';
        results.push({ id: message.id, status: message.status, error: err.message });
      }
    }
    return results;
  }

  return { enqueue, deliver, list: () => outbox(), MAX_ATTEMPTS, sign };
}

module.exports = { createApprovalNotifier, MAX_ATTEMPTS };
