'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createApprovalNotifier } = require('../src/approvalNotifier');

// The transport is injected, so these tests describe the contract rather than a network.

const store = () => ({ data: {}, next(n) { this.data.seq = this.data.seq || {}; this.data.seq[n] = (this.data.seq[n] || 0) + 1; return this.data.seq[n]; } });

test('an approval is queued once, and queuing twice returns the first message', () => {
  const notifier = createApprovalNotifier({ store: store(), transport: async () => {}, secret: 'test-secret' });
  const first = notifier.enqueue({ approvalId: 'AP-1', jobNumber: 'J0000001' });
  const again = notifier.enqueue({ approvalId: 'AP-1' });
  assert.equal(again.id, first.id);
  assert.equal(notifier.list().length, 1);
  assert.equal(first.status, 'queued');
});

test('delivery signs the payload, and the signature verifies with the same secret', async () => {
  const seen = [];
  const notifier = createApprovalNotifier({ store: store(), secret: 'test-secret', transport: async (request) => { seen.push(request); } });
  notifier.enqueue({ approvalId: 'AP-1', summary: 'Bind PA-0000001 for 12,000' });
  await notifier.deliver();
  const expected = crypto.createHmac('sha256', 'test-secret').update(JSON.stringify(seen[0].payload)).digest('hex');
  assert.equal(seen[0].signature, expected);
  assert.equal(notifier.list()[0].status, 'delivered');
});

test('a failing transport retries, then gives up after the cap and records why', async () => {
  let calls = 0;
  const notifier = createApprovalNotifier({ store: store(), secret: 's', transport: async () => { calls += 1; throw new Error('channel down'); } });
  notifier.enqueue({ approvalId: 'AP-1' });
  for (let i = 0; i < 5; i += 1) await notifier.deliver();
  const message = notifier.list()[0];
  assert.equal(calls, 4, 'exactly the attempt cap, not five');
  assert.equal(message.status, 'failed');
  assert.equal(message.lastError, 'channel down');
});

test('a delivered message is not sent again', async () => {
  let calls = 0;
  const notifier = createApprovalNotifier({ store: store(), secret: 's', transport: async () => { calls += 1; } });
  notifier.enqueue({ approvalId: 'AP-1' });
  await notifier.deliver();
  await notifier.deliver();
  assert.equal(calls, 1);
});

test('no signing secret means no notification at all, refused at enqueue', () => {
  const notifier = createApprovalNotifier({ store: store(), transport: async () => {} });
  assert.throws(() => notifier.enqueue({ approvalId: 'AP-1' }), /signing secret is required/);
  assert.equal(notifier.list().length, 0, 'nothing was queued');
});

test('an approval id is required, and a transport must be supplied', () => {
  const notifier = createApprovalNotifier({ store: store(), transport: async () => {}, secret: 's' });
  assert.throws(() => notifier.enqueue({}), /approval id is required/);
  assert.throws(() => createApprovalNotifier({ store: store(), secret: 's' }), /transport function is required/);
});
