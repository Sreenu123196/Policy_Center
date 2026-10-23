'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createAllocations } = require('../src/allocations');

function freshStore() {
  const data = { allocations: [], seq: {} };
  return { data, next: (n) => { data.seq[n] = (data.seq[n] || 0) + 1; return data.seq[n]; } };
}

const PLAN = { allocations: [{ invoiceNumber: 'INV-1', amount: 1000 }], suspense: 500, reason: 'allocated to the oldest open invoices; the remainder is in suspense' };

test('a plan is recorded with who decided it and what it did', () => {
  const store = freshStore();
  const allocations = createAllocations(store);
  const record = allocations.record({ id: 'uwm' }, PLAN, { amount: 1500, reference: 'CHQ-1' });
  assert.match(record.id, /^AL-\d{7}$/);
  assert.equal(record.allocatedBy, 'uwm');
  assert.equal(record.suspense, 500);
  assert.equal(record.allocations[0].invoiceNumber, 'INV-1');
  assert.match(record.allocatedAt, /\d{4}-\d{2}-\d{2}T/);
});

test('allocations can be read back and the suspense accumulated', () => {
  const store = freshStore();
  const allocations = createAllocations(store);
  const one = allocations.record({ id: 'a' }, PLAN, { amount: 1500 });
  allocations.record({ id: 'a' }, { ...PLAN, suspense: 250 }, { amount: 1250 });
  assert.equal(allocations.get(one.id).id, one.id);
  assert.equal(allocations.list().length, 2);
  assert.equal(allocations.suspenseTotal(), 750);
});

test('a missing plan is refused, and an unknown id looks missing', () => {
  const store = freshStore();
  const allocations = createAllocations(store);
  assert.throws(() => allocations.record({ id: 'u' }, null, {}), /allocation plan is required/);
  assert.throws(() => allocations.get('AL-9999999'), /Allocation not found/);
});
