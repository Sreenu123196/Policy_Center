'use strict';
// A12's demo: one command that runs the triage sequence and prints its timeline.
//
// A demo that depends on clicking through a running server cannot be re-run by a reviewer at eleven at night; this can. It uses the same module the route uses, so what it prints is what the
// API returns.

const { triage } = require('../src/claimsTriage');

const CLAIMS = [
  { label: 'clean medium water claim', claim: { claimNumber: 'CL-DEMO-1', policyNumber: 'HO-0000001', incidentDate: '2026-03-01', cause: 'water', amount: 60000 }, sumInsured: 500000 },
  { label: 'injury, high severity', claim: { claimNumber: 'CL-DEMO-2', policyNumber: 'PA-0000001', incidentDate: '2026-03-02', cause: 'collision', amount: 120000, injuries: true }, sumInsured: 500000 },
  { label: 'reserve above the sum insured', claim: { claimNumber: 'CL-DEMO-3', policyNumber: 'HO-0000002', incidentDate: '2026-03-03', cause: 'fire', amount: 900000 }, sumInsured: 500000 },
  { label: 'missing amount', claim: { claimNumber: 'CL-DEMO-4', policyNumber: 'HO-0000003', incidentDate: '2026-03-04', cause: 'theft' }, sumInsured: 500000 },
];

for (const { label, claim, sumInsured } of CLAIMS) {
  const result = triage({ claim, sumInsured });
  console.log('\n' + label + '  (' + claim.claimNumber + ')');
  for (const step of result.steps) {
    console.log('  ' + step.name.padEnd(10) + step.status.padEnd(9) + String(step.ms || 0).padStart(4) + ' ms  ' + step.detail);
  }
  console.log('  -> ' + result.outcome + (result.blockedBy ? ' at ' + result.blockedBy : '') + ' | severity ' + (result.severity || '-') + ' | ' + (result.assignee || '-') + ' | ' + result.totalMs + ' ms total');
}
console.log('\nEvery step is named and timed; a refusal stops the run and the later steps are skipped.');
