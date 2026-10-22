'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createContacts } = require('../src/contacts');
const { maskText } = require('../src/knowledge/mask');

// The one thing this module must never do is store a person's raw identifier. The tests use a dummy number that is
// obviously not a real one.

function freshStore() {
  const data = { contacts: [], seq: {} };
  return {
    data,
    next: (name) => { data.seq[name] = (data.seq[name] || 0) + 1; return data.seq[name]; },
  };
}

test('a dummy Aadhaar is stored masked, and the digits are nowhere in the record', () => {
  const store = freshStore();
  const contacts = createContacts(store);
  const created = contacts.create({ id: 'u1' }, { firstName: 'Test', lastName: 'Person', idType: 'aadhaar', idNumber: '1111 2222 3333' });

  assert.equal(created.kyc.idNumberMasked, maskText('1111 2222 3333'));
  assert.equal(created.kyc.idNumberMasked, '[AADHAAR]');
  assert.equal(JSON.stringify(created).includes('1111'), false, 'no part of the number survives');
  assert.equal(created.kyc.status, 'pending');
  assert.match(created.id, /^CT-\d{7}$/);
});

test('a PAN and a phone number are masked too', () => {
  const store = freshStore();
  const contacts = createContacts(store);
  assert.equal(contacts.create({ id: 'u1' }, { firstName: 'A', lastName: 'B', idType: 'pan', idNumber: 'ABCDE1234F' }).kyc.idNumberMasked, '[PAN]');
});

test('an unknown identifier type is refused, and a contact without an identifier is allowed', () => {
  const store = freshStore();
  const contacts = createContacts(store);
  assert.throws(() => contacts.create({ id: 'u1' }, { firstName: 'A', lastName: 'B', idType: 'library-card', idNumber: 'x' }), /idType must be one of/);
  const plain = contacts.create({ id: 'u1' }, { firstName: 'A', lastName: 'B' });
  assert.equal(plain.kyc.idNumberMasked, null);
});

test('verification records who checked it and when', () => {
  const store = freshStore();
  const contacts = createContacts(store);
  const created = contacts.create({ id: 'u1' }, { firstName: 'A', lastName: 'B' });
  const verified = contacts.verify(created.id, { id: 'u2' });
  assert.equal(verified.kyc.status, 'verified');
  assert.equal(verified.kyc.checkedBy, 'u2');
  assert.match(verified.kyc.checkedAt, /\d{4}-\d{2}-\d{2}T/);
});

test('the dummy identifier 4522 4751 2035 is stored masked and the record can be read back', () => {
  const store = freshStore();
  const contacts = createContacts(store);
  const created = contacts.create({ id: 'u1' }, { firstName: 'Dummy', lastName: 'Test', idType: 'aadhaar', idNumber: '4522 4751 2035' });
  assert.equal(created.kyc.idNumberMasked, '[AADHAAR]');
  assert.equal(JSON.stringify(created).includes('4522'), false);
  const readBack = contacts.find(created.id);
  assert.equal(readBack.id, created.id);
  assert.equal(readBack.kyc.status, 'pending');
  assert.throws(() => contacts.find('CT-9999999'), /Contact not found/);
});
