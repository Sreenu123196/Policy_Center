'use strict';
// B8: enriching a commercial insured without inventing it.
//
// Each source contributes fields, and every field keeps the name of the source that said it. When two sources disagree, the disagreement is
// recorded rather than resolved silently - a conflict is information an underwriter needs, not noise to suppress. Fields nobody provides are
// listed as gaps, and risk flags are computed from rules that can be read.

const { AppError } = require('./appError');
const { validateGstin } = require('./registryVerifier');

const REQUIRED_FIELDS = ['legalName', 'sector', 'incorporatedOn', 'directors', 'registeredAddress'];

function enrich({ gstin, sources = [], asOf } = {}) {
  if (!gstin) throw new AppError(422, 'a GSTIN is required');
  const check = validateGstin(gstin);
  if (!check.valid) throw new AppError(422, check.reason);

  const facts = {};
  const conflicts = [];
  for (const source of sources) {
    if (!source || !source.name) throw new AppError(422, 'every source needs a name');
    for (const [field, value] of Object.entries(source.provides || {})) {
      if (value === undefined || value === null || value === '') continue;
      const existing = facts[field];
      if (!existing) { facts[field] = { value, source: source.name }; continue; }
      if (JSON.stringify(existing.value) !== JSON.stringify(value)) {
        conflicts.push({ field, sources: [existing.source, source.name], values: [existing.value, value] });
      }
    }
  }

  const missing = REQUIRED_FIELDS.filter((f) => !facts[f]);

  const flags = [];
  if (facts.incorporatedOn) {
    const incorporated = new Date(facts.incorporatedOn.value);
    const onDate = asOf ? new Date(asOf) : new Date();
    if (Number.isFinite(incorporated.getTime()) && Number.isFinite(onDate.getTime())) {
      const months = (onDate.getFullYear() - incorporated.getFullYear()) * 12 + (onDate.getMonth() - incorporated.getMonth());
      if (months < 18) flags.push({ code: 'recently-incorporated', detail: 'Incorporated ' + months + ' month(s) ago; short trading history.' });
    }
  }
  if (facts.sector && /construction|transport|chemical|mining/i.test(String(facts.sector.value))) {
    flags.push({ code: 'hazardous-sector', detail: 'Sector ' + facts.sector.value + ' is treated as higher hazard.' });
  }
  if (facts.gstStatus && /inactive|cancelled|suspended/i.test(String(facts.gstStatus.value))) {
    flags.push({ code: 'gst-not-active', detail: 'GST status is ' + facts.gstStatus.value + '.' });
  }

  return {
    gstin: check.gstin,
    facts,
    conflicts,
    missing,
    flags,
    ready: missing.length === 0 && conflicts.length === 0,
    verdict: missing.length === 0 && conflicts.length === 0 ? 'complete' : 'incomplete: ' + missing.length + ' gap(s), ' + conflicts.length + ' conflict(s)',
  };
}

module.exports = { enrich, REQUIRED_FIELDS };
