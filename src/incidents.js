'use strict';
// Incidents: a loss reported before it becomes a claim.
//
// Not every incident becomes a claim - a burst pipe fixed for a few hundred rupees is reported and closed. Recording them
// separately keeps the claim register honest and gives the underwriting side a view of what is actually happening.
//
// An incident may name a policy; the application decides whether the person may see that policy.

const { AppError } = require('./appError');

const TYPES = ['water', 'fire', 'theft', 'collision', 'injury', 'weather', 'other'];
const STATUSES = ['reported', 'under-review', 'closed', 'converted'];

function createIncidents(store, pc) {
  const list = () => store.data.incidents;

  function create(user, input = {}) {
    const type = String(input.type || '').toLowerCase();
    if (!TYPES.includes(type)) throw new AppError(422, 'type must be one of ' + TYPES.join(', '));
    const occurredOn = String(input.occurredOn || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(occurredOn)) throw new AppError(422, 'occurredOn must be a date, YYYY-MM-DD');
    let policyNumber = null;
    if (input.policy) {
      // The access rule is the application's; an incident cannot be filed against a policy the person cannot see.
      const policy = pc.policy(String(input.policy), user);
      policyNumber = policy.policyNumber;
    }
    const incident = {
      id: 'IN-' + String(store.next('incident')).padStart(7, '0'),
      type,
      occurredOn,
      status: 'reported',
      description: String(input.description || '').trim() || null,
      policyNumber,
      reportedBy: user && user.id,
      reportedAt: new Date().toISOString(),
      closedAt: null,
    };
    list().push(incident);
    return incident;
  }

  function find(id) {
    const incident = list().find((i) => i.id === id);
    if (!incident) throw new AppError(404, 'Incident not found');
    return incident;
  }

  function setStatus(id, status) {
    if (!STATUSES.includes(status)) throw new AppError(422, 'status must be one of ' + STATUSES.join(', '));
    const incident = find(id);
    incident.status = status;
    if (status === 'closed') incident.closedAt = new Date().toISOString();
    return incident;
  }

  return { create, list, find, setStatus, TYPES, STATUSES };
}

module.exports = { createIncidents, TYPES, STATUSES };
