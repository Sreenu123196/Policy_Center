'use strict';
const { AppError } = require('./appError');

const ID_TYPES = ['aadhaar', 'pan', 'passport', 'driving-licence', 'voter-id'];

function createContacts(store) {
  const list = () => store.data.contacts;
  function find(id) {
    const contact = list().find((c) => c.id === id);
    if (!contact) throw new AppError(404, 'Contact not found');
    return contact;
  }
  function create(user, input = {}) {
    const firstName = String(input.firstName || '').trim();
    const lastName = String(input.lastName || '').trim();
    if (!firstName || !lastName) throw new AppError(422, 'A first name and a last name are required');
    const contact = {
      id: 'CT-' + String(store.next('contact')).padStart(7, '0'),
      firstName, lastName,
      kyc: { status: 'pending', checkedAt: null, checkedBy: null, idType: null, idNumberMasked: null },
      createdBy: user && user.id,
      createdAt: new Date().toISOString(),
    };
    list().push(contact);
    return contact;
  }
  function verify(id, user) {
    const contact = find(id);
    contact.kyc.status = 'verified';
    contact.kyc.checkedAt = new Date().toISOString();
    contact.kyc.checkedBy = user && user.id;
    return contact;
  }
  return { create, list, find, verify, ID_TYPES };
}

module.exports = { createContacts, ID_TYPES };
