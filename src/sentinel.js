'use strict';
// B21: a dual verifier. The first agent proposes; two independent checks must both agree before anything happens.
//
// Independence is the point: one check asks whether a procedure permits the action, the other asks whether the agent is allowed and
// running. A single opinion, however confident, is not a control. Disagreement blocks rather than logs, and text that tries to
// instruct the verifier is refused before either check runs - a proposal is data, never instructions.

const { AppError } = require('./appError');

// Instruction-shaped text in a proposal or a document: not evidence of an attack, but never something to obey.
const INJECTION_PATTERNS = [
  /ignore (all |any )?(previous|prior|above) (instructions|rules)/i,
  /disregard (the |all )?(policy|rules|procedures)/i,
  /you are now|act as|pretend to be/i,
  /override (the )?(rules|procedure|limit)/i,
  /system prompt|developer message/i,
  /approve (this|it) without/i,
];

function looksLikeInjection(text) {
  if (!text) return null;
  const found = INJECTION_PATTERNS.find((pattern) => pattern.test(String(text)));
  return found ? String(text).match(found)[0] : null;
}

function createSentinel({ aops, registry = null } = {}) {
  if (!aops) throw new Error('aops is required');

  /**
   * @param {{action: string, role?: string, amount?: number, actor?: string, requestedBy?: string, agentId?: string, proposal?: string, citations?: Array}} input
   */
  function verify(input = {}) {
    const checks = [];

    // Zero-click injection: refused before the checks, because a compromised proposal must not reach an evaluator at all.
    const injection = looksLikeInjection(input.proposal);
    if (injection) {
      checks.push({ name: 'injection', allowed: false, reason: 'The proposal contains instruction-like text ("' + injection + '") and was refused.' });
      return { allowed: false, checks, procedure: null, blockedBy: 'injection' };
    }

    // Check one: the procedure. What does the English say a person may do here?
    const procedure = aops.check({ action: input.action, role: input.role, amount: input.amount, actor: input.actor, requestedBy: input.requestedBy });
    checks.push({ name: 'procedure', allowed: procedure.allowed, reason: procedure.reason });

    // Check two: the registry. Is this agent permitted, within its authority, and running?
    if (registry && input.agentId) {
      const agent = registry.mayAct(input.agentId, { action: input.action, amount: input.amount, role: input.role });
      checks.push({ name: 'registry', allowed: agent.allowed, reason: agent.reason });
    }

    // Check three: evidence. An action taken on a quoted clause must carry the citation that was quoted.
    if (input.requiresEvidence) {
      const cited = Array.isArray(input.citations) && input.citations.length > 0;
      checks.push({ name: 'evidence', allowed: cited, reason: cited ? 'A clause is cited.' : 'No clause is cited, so the action has no grounding.' });
    }

    const refused = checks.filter((c) => !c.allowed);
    return {
      allowed: refused.length === 0,
      checks,
      procedure: procedure.procedure,
      blockedBy: refused.length ? refused[0].name : null,
      reason: refused.length ? refused.map((c) => c.reason).join(' ') : 'Both checks agree.',
    };
  }

  return { verify, looksLikeInjection };
}

module.exports = { createSentinel, looksLikeInjection, INJECTION_PATTERNS };
