'use strict';
// The procedures, in the words a person would use, paired with the narrow machine rule that enforces them.
//
// The English is the part that gets read and approved; the rule is the part that is checked. Where the two disagree the English
// wins and the rule is a bug - which is why they sit side by side in one entry rather than in a document and a codebase.

const AOPS = [
  {
    id: 'UW-BIND-001',
    domain: 'underwriting',
    action: 'bind.approve',
    title: 'Approving a bind within your authority',
    plainEnglish: 'An underwriter may approve a bind up to the authority their role carries, and no further. Above that limit the file goes to someone with more authority. No agent may approve its own bind request.',
    may: true,
    limits: { Underwriter: 250000, 'UW Manager': 1000000 },
    requiresHuman: true,
  },
  {
    id: 'UW-DECLINE-001',
    domain: 'underwriting',
    action: 'policy.decline',
    title: 'Declining a risk',
    plainEnglish: 'An agent may recommend a decline and must record the reason. Only a person may decline; the assistant never refuses cover on its own.',
    may: false,
    limits: {},
    requiresHuman: true,
  },
  {
    id: 'CLM-RESERVE-001',
    domain: 'claims',
    action: 'claim.reserve',
    title: 'Setting a reserve',
    plainEnglish: 'A reserve may be drafted up to twenty-five thousand. Above that an adjuster sets it. The draft must name the incident it belongs to.',
    may: true,
    limits: { Adjuster: 25000, 'Claims Manager': 500000 },
    requiresHuman: true,
  },
  {
    id: 'CLM-SETTLE-001',
    domain: 'claims',
    action: 'claim.settle',
    title: 'Paying a claim',
    plainEnglish: 'Nothing is paid without a person. The assistant may assemble the settlement packet and check it, but the payment decision and the release are human acts.',
    may: false,
    limits: {},
    requiresHuman: true,
  },
  {
    id: 'CLM-REFER-001',
    domain: 'claims',
    action: 'claim.refer',
    title: 'Referring a claim for review',
    plainEnglish: 'A claim may be referred for fraud or recovery review at any value, with a reason. Referring is not deciding, so the assistant may do it.',
    may: true,
    limits: {},
    requiresHuman: false,
  },
];

module.exports = { AOPS };
