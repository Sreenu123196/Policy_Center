'use strict';
// Who may read which passages.
//
// Audiences are ordered: public < agent < underwriting < manager < restricted. A role reads its own level and every
// level below it, and nothing above. The map lives here, in one table, because a filter that is derived differently in
// two places is how a leak happens.
//
// The Insurance Executive is read-only by design (the permission matrix pins that), so the executive reads at the
// underwriting level: enough to answer questions about the book, not the restricted material.

const LEVELS = ['public', 'agent', 'underwriting', 'manager', 'restricted'];

const ROLE_LEVEL = {
  Agent: 'agent',
  Underwriter: 'underwriting',
  'UW Manager': 'manager',
  'Insurance Executive': 'underwriting',
  ai: 'underwriting', // the agent accounts (ai-renewal, ai-billing, ...) read what an underwriter reads
};

/** The audiences a user may see, widest last. Unknown roles get the narrowest level, never the widest. */
function audiencesFor(user) {
  const level = ROLE_LEVEL[user && user.role] || 'public';
  const index = LEVELS.indexOf(level);
  return LEVELS.slice(0, index + 1);
}

/** The filter object the retrieval layer expects. */
function filtersForUser(user, { asOf = null } = {}) {
  const filters = { audiences: audiencesFor(user) };
  if (asOf) filters.asOf = asOf;
  return filters;
}

module.exports = { LEVELS, ROLE_LEVEL, audiencesFor, filtersForUser };
