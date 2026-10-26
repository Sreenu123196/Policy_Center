'use strict';
// Contacts and KYC.
//
// A contact is a person the business deals with: the insured, the driver, the claimant. KYC records an identity check
// against them. The identifier a person presents is stored masked - the simulator never needs the raw Aadhaar or PAN to
// demonstrate a KYC workflow, and storing one would be the single careless thing this module could do.

const { AppError } = require('./appError');
const { maskText } = require('./knowledge/mask');

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
    const idType = String(input.idType || '').toLowerCase();
    if (idType && !ID_TYPES.includes(idType)) throw new AppError(422, 'idType must be one of ' + ID_TYPES.join(', '));
    const idNumber = String(input.idNumber || '').trim();
    const contact = {
      id: 'CT-' + String(store.next('contact')).padStart(7, '0'),
      firstName,
      lastName,
      email: input.email ? String(input.email).trim() : null,
      phone: input.phone ? String(input.phone).trim() : null,
      dateOfBirth: input.dateOfBirth || null,
      kyc: {
        status: 'pending',
        checkedAt: null,
        checkedBy: null,
        idType: idType || null,
        idNumberMasked: idNumber ? maskText(idNumber) : null,
      },
      createdBy: user && user.id,
      createdAt: new Date().toISOString(),
    };
    list().push(contact);
    return contact;
  }

  function verify(id, user) {
    const contact = find(id);
    // Separation of duties: the person who entered an identity check must not be the person who approves it. Without this,
    // verification is a formality one teammate performs for themselves.
    if (contact.createdBy && user && contact.createdBy === user.id) {
      throw new AppError(403, 'You cannot verify your own record');
    }
    contact.kyc.status = 'verified';
    contact.kyc.checkedAt = new Date().toISOString();
    contact.kyc.checkedBy = user && user.id;
    return contact;
  }

  return { create, list, find, verify, ID_TYPES };
}

module.exports = { createContacts, ID_TYPES };
