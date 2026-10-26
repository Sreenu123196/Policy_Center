'use strict';
// B22: an underwriting memo that separates what the file states from what someone assumed.
//
// The value is in the separation. A memo that blends an assumption into a fact cannot be reviewed, and a memo that omits the gaps reads as
// complete. So: facts carry their source, assumptions must name the fact they rest on or be flagged ungrounded, and missing requirements are
// listed as questions rather than left to be discovered after bind.

const { AppError } = require('./appError');

const REQUIRED = ['occupancy', 'construction', 'yearBuilt', 'protectionClass'];

/**
 * @param {{submission: string, facts?: Array<{name: string, value: any, source?: string}>, assumptions?: Array<{name: string, value: any, restsOn?: string}>, gaps?: string[]}} input
 */
function buildMemo({ submission, facts = [], assumptions = [], gaps = [] } = {}) {
  if (!submission) throw new AppError(422, 'a submission reference is required');
  const factNames = new Set(facts.map((f) => f.name));
  for (const fact of facts) {
    if (!fact.name) throw new AppError(422, 'every fact needs a name');
    if (!fact.source) throw new AppError(422, 'fact "' + fact.name + '" has no source, so it is an assumption');
  }

  const ungrounded = assumptions.filter((a) => !a.restsOn || !factNames.has(a.restsOn)).map((a) => ({ name: a.name, value: a.value, reason: a.restsOn ? 'It rests on "' + a.restsOn + '", which is not a fact in this file.' : 'It names no fact it rests on.' }));

  // A required item is satisfied by a fact or by an assumption; a gap is only real when neither mentions it.
  const covered = new Set([...facts.map((f) => f.name), ...assumptions.map((a) => a.name)]);
  const declaredGaps = gaps.filter((gap) => !covered.has(gap));
  const missingRequired = REQUIRED.filter((name) => !covered.has(name));
  const openQuestions = [...new Set([...declaredGaps, ...missingRequired])];

  const ready = ungrounded.length === 0 && openQuestions.length === 0;
  return {
    submission,
    facts: facts.map((f) => ({ name: f.name, value: f.value, source: f.source })),
    assumptions: assumptions.map((a) => ({ name: a.name, value: a.value, restsOn: a.restsOn || null, grounded: Boolean(a.restsOn && factNames.has(a.restsOn)) })),
    ungrounded,
    gaps: openQuestions,
    verdict: ready ? 'ready for decision' : 'not ready: ' + (ungrounded.length ? ungrounded.length + ' ungrounded assumption(s)' : '') + (ungrounded.length && openQuestions.length ? '; ' : '') + (openQuestions.length ? openQuestions.length + ' open question(s)' : ''),
    ready,
  };
}

module.exports = { buildMemo, REQUIRED };
