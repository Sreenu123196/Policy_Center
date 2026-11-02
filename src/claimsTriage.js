'use strict';
// A12: claims triage as an orchestrated sequence, with a clock on it.
//
// The point of the exercise is not that several checks run - it is that each one is a named step with a duration and an outcome, so "triage in three minutes" is a measurement rather than
// a claim. A step that fails stops the sequence: an unvalidated claim must not reach severity routing, and a duplicate must not quietly become a reserve.

const { AppError } = require('./appError');

const REQUIRED = ['claimNumber', 'policyNumber', 'incidentDate', 'cause', 'amount'];

const STEP = (name, run) => ({ name, run });

function isDuplicate(claim, others = []) {
  return others.some((other) => other.claimNumber !== claim.claimNumber
    && other.incidentDate === claim.incidentDate
    && String(other.cause || '').toLowerCase() === String(claim.cause || '').toLowerCase()
    && Number(other.amount) === Number(claim.amount));
}

const STEPS = [
  STEP('validate', (claim) => {
    const missing = REQUIRED.filter((field) => claim[field] === undefined || claim[field] === null || claim[field] === '');
    if (missing.length) return { ok: false, detail: 'Missing ' + missing.join(', ') };
    if (!Number.isFinite(Number(claim.amount)) || Number(claim.amount) <= 0) return { ok: false, detail: 'The amount must be a positive number' };
    if (!Number.isFinite(Date.parse(claim.incidentDate))) return { ok: false, detail: 'The incident date is not a date' };
    return { ok: true, detail: 'Required fields present' };
  }),
  STEP('duplicate', (claim, ctx) => {
    if (isDuplicate(claim, ctx.openClaims || [])) return { ok: false, detail: 'The same loss is already on file' };
    return { ok: true, detail: 'No matching loss' };
  }),
  STEP('coverage', (claim, ctx) => {
    const cap = ctx.sumInsured;
    if (cap !== undefined && Number(claim.amount) > Number(cap)) return { ok: false, detail: 'The reserve exceeds the sum insured (' + cap + ')' };
    return { ok: true, detail: 'Within the sum insured' };
  }),
  STEP('severity', (claim) => {
    const amount = Number(claim.amount);
    const injuries = Boolean(claim.injuries);
    const level = injuries || amount >= 250000 ? 'high' : amount >= 50000 ? 'medium' : 'low';
    return { ok: true, detail: level, output: { severity: level } };
  }),
  STEP('assign', (claim, ctx) => {
    const severity = ctx.outputs.severity && ctx.outputs.severity.output ? ctx.outputs.severity.output.severity : 'low';
    const queue = severity === 'high' ? 'senior-adjuster' : severity === 'medium' ? 'adjuster' : 'general-queue';
    return { ok: true, detail: queue, output: { assignee: queue } };
  }),
  STEP('reserve', (claim) => ({ ok: true, detail: 'Reserve proposed at ' + Number(claim.amount), output: { reserve: Number(claim.amount), heldForPerson: true } })),
];

/**
 * @param {{claim: object, openClaims?: Array, sumInsured?: number, now?: () => number}} input
 */
function triage({ claim, openClaims = [], sumInsured, now = () => Date.now() } = {}) {
  if (!claim || typeof claim !== 'object') throw new AppError(422, 'a claim is required');
  const started = now();
  const ctx = { openClaims, sumInsured, outputs: {} };
  const steps = [];
  let blocked = false;
  for (const step of STEPS) {
    if (blocked) { steps.push({ name: step.name, status: 'skipped', detail: 'An earlier step refused' }); continue; }
    const t0 = now();
    let result;
    try { result = step.run(claim, ctx); } catch (err) { result = { ok: false, detail: err.message }; }
    const ms = now() - t0;
    steps.push({ name: step.name, status: result.ok ? 'ok' : 'refused', detail: result.detail, ms });
    if (result.output) ctx.outputs[step.name] = result;
    if (!result.ok) blocked = true;
  }
  const refused = steps.find((s) => s.status === 'refused');
  return {
    claimNumber: claim.claimNumber || null,
    steps,
    outcome: refused ? 'blocked' : 'triaged',
    blockedBy: refused ? refused.name : null,
    severity: ctx.outputs.severity ? ctx.outputs.severity.output.severity : null,
    assignee: ctx.outputs.assign ? ctx.outputs.assign.output.assignee : null,
    reserve: ctx.outputs.reserve ? ctx.outputs.reserve.output.reserve : null,
    totalMs: Math.max(0, now() - started),
    withinThreeMinutes: (now() - started) <= 180000,
  };
}

module.exports = { triage, STEPS, REQUIRED };
