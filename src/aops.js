'use strict';
// B2: an action is permitted only if a procedure covers it, and only within that procedure's limits.
//
// The refusal for an uncovered action is the important case: a new tool that nobody wrote a procedure for must not inherit
// permission by existing.

const { AOPS } = require('./aopData');

function createAops({ aops = AOPS } = {}) {
  const list = () => aops;
  const byAction = (action) => aops.filter((a) => a.action === action);
  const get = (id) => {
    const found = aops.find((a) => a.id === id);
    if (!found) throw new Error('No procedure ' + id);
    return found;
  };

  /**
   * @param {{action: string, role?: string, amount?: number, actor?: string, requestedBy?: string}} input
   * @returns {{allowed: boolean, procedure: object|null, reason: string, plainEnglish: string|null, limit: number|null}}
   */
  function check({ action, role, amount, actor, requestedBy } = {}) {
    const candidates = byAction(action);
    if (candidates.length === 0) {
      return {
        allowed: false, procedure: null, limit: null, plainEnglish: null,
        reason: 'No procedure covers "' + action + '"; it cannot be done until one is written and approved.',
      };
    }
    const procedure = candidates[0];
    if (procedure.may === false && procedure.requiresHuman) {
      return {
        allowed: false, procedure, limit: null, plainEnglish: procedure.plainEnglish,
        reason: procedure.id + ' reserves this to a person: ' + procedure.title.toLowerCase() + '.',
      };
    }
    // Separation of duties, in the procedure rather than in the caller.
    if (actor && requestedBy && actor === requestedBy) {
      return {
        allowed: false, procedure, limit: null, plainEnglish: procedure.plainEnglish,
        reason: procedure.id + ': the person who requested it cannot also decide it.',
      };
    }
    const limit = procedure.limits && role ? procedure.limits[role] : null;
    if (role && procedure.limits && Object.keys(procedure.limits).length && limit === undefined) {
      return {
        allowed: false, procedure, limit: null, plainEnglish: procedure.plainEnglish,
        reason: procedure.id + ': the role ' + role + ' carries no authority under this procedure.',
      };
    }
    if (limit !== null && limit !== undefined && Number(amount) > limit) {
      return {
        allowed: false, procedure, limit, plainEnglish: procedure.plainEnglish,
        reason: procedure.id + ': ' + Number(amount) + ' is above the ' + limit + ' this role may authorise.',
      };
    }
    return { allowed: true, procedure, limit: limit === undefined ? null : limit, plainEnglish: procedure.plainEnglish, reason: procedure.id + ' permits it.' };
  }

  return { list, get, check };
}

module.exports = { createAops };
