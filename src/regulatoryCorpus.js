'use strict';
// B25: a small regulatory corpus.
//
// IMPORTANT: these entries are ILLUSTRATIVE. They are written to exercise the machinery - search, citation, abstain - and are marked
// `illustrative: true` so no screen or answer can present them as the text of a real regulation. The compliance team replaces this file
// with licensed, dated extracts before anyone relies on it. A citation that points at a made-up rule is worse than no citation at all.

const ENTRIES = [
  {
    id: 'REG-CLM-001',
    title: 'Claim settlement timelines',
    section: 'Settlement of claims',
    illustrative: true,
    text: 'An insurer shall settle a claim within thirty days of receiving the last necessary document, and where the claim requires further investigation, within forty-five days of that receipt.',
  },
  {
    id: 'REG-CLM-002',
    title: 'Communication of rejection',
    section: 'Repudiation',
    illustrative: true,
    text: 'Where a claim is rejected, the insurer shall communicate the reasons for rejection in writing to the claimant, referring to the specific policy clause relied upon.',
  },
  {
    id: 'REG-KYC-001',
    title: 'Customer identification',
    section: 'Know your customer',
    illustrative: true,
    text: 'The insurer shall verify the identity of the proposer before issuing a policy, and shall retain the records of that verification for the period required by law.',
  },
  {
    id: 'REG-DIS-001',
    title: 'Disclosure of material facts',
    section: 'Duties of the insured',
    illustrative: true,
    text: 'The proposer shall disclose all material facts likely to influence the acceptance of the risk or the premium, and a failure to do so may entitle the insurer to avoid the contract.',
  },
  {
    id: 'REG-GRV-001',
    title: 'Grievance redressal',
    section: 'Complaints',
    illustrative: true,
    text: 'The insurer shall resolve a grievance within fourteen days of receipt, and where it is not resolved, inform the complainant of the right to approach the appropriate authority.',
  },
  {
    id: 'REG-MND-001',
    title: 'Mandate notice before debit',
    section: 'Electronic mandates',
    illustrative: true,
    text: 'The insurer shall give the customer notice at least twenty-four hours before presenting an electronic mandate for payment, stating the amount and the date of the debit.',
  },
];

module.exports = { ENTRIES };
