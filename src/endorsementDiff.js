'use strict';
// B5: what an endorsement actually changes, and what an exclusion takes away.
//
// An endorsement is a diff, and saying so plainly is the whole job: added, removed, and changed field by field. Without it a person compares two
// screens; with it the comparison is the answer, and an exclusion that removes something the customer just asked for is visible before it binds.

function flattenCoverage(coverage = {}) {
  const flat = { selected: Boolean(coverage.selected), ...(coverage.terms || {}) };
  for (const [key, value] of Object.entries(coverage)) {
    if (key !== 'terms') flat[key] = value && typeof value === 'object' ? JSON.stringify(value) : value;
  }
  return flat;
}

/** @returns {{added: string[], removed: string[], changed: Array<{code: string, field: string, from: any, to: any}>, unchanged: string[]}} */
function diffCoverages(before = {}, after = {}) {
  const codes = new Set([...Object.keys(before), ...Object.keys(after)]);
  const added = [];
  const removed = [];
  const changed = [];
  const unchanged = [];
  for (const code of [...codes].sort()) {
    const was = before[code];
    const now = after[code];
    const wasSelected = was && (was.selected === undefined ? true : Boolean(was.selected));
    const nowSelected = now && (now.selected === undefined ? true : Boolean(now.selected));
    if (!was && nowSelected) { added.push(code); continue; }
    if (wasSelected && !nowSelected) { removed.push(code); continue; }
    if (!was && !now) continue;
    const a = flattenCoverage(was);
    const b = flattenCoverage(now);
    const fields = new Set([...Object.keys(a), ...Object.keys(b)]);
    let touched = false;
    for (const field of [...fields].sort()) {
      if (String(a[field]) === String(b[field])) continue;
      touched = true;
      changed.push({ code, field, from: a[field] === undefined ? null : a[field], to: b[field] === undefined ? null : b[field] });
    }
    if (!touched) unchanged.push(code);
  }
  return { added, removed, changed, unchanged };
}

/** Which requested coverages an exclusion contradicts, with the exclusion's own words as the reason. */
function checkExclusions({ coverages = {}, exclusions = [] } = {}) {
  const conflicts = [];
  for (const exclusion of exclusions) {
    const terms = (exclusion.appliesTo || exclusion.coverage || '').toLowerCase();
    if (!terms) continue;
    for (const [code, coverage] of Object.entries(coverages)) {
      if (!coverage || coverage.selected === false) continue;
      const haystack = (code + ' ' + (coverage.name || coverage.label || '')).toLowerCase();
      if (haystack.includes(terms) || terms.includes(code.toLowerCase())) {
        conflicts.push({ coverage: code, excludedBy: exclusion.id || exclusion.title || 'exclusion', reason: exclusion.text || exclusion.title || 'Excluded by endorsement' });
      }
    }
  }
  return { excluded: conflicts.length > 0, conflicts };
}

module.exports = { diffCoverages, checkExclusions, flattenCoverage };
