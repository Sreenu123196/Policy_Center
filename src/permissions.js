'use strict';
// What each role may see. One place to change access for the whole app: the service, the API and the
// assistant all ask these functions.
//
//                         Agent        Underwriter   Insurance Executive   UW Manager
//   Accounts and policies own only     all           all                   all
//   Claim status, paid    own only     all           all                   all
//   Claim reserves        no           yes           no                    yes
//   Billing (invoices,    no           no            no                    yes
//     transactions)
//   Rating factors, UW    no           yes           no                    yes
//     notes
//   Sales analytics and   own only     no            all (read only)       all
//     lapsing lists
//   Logging follow-ups    own only     no            no                    all
//   Portfolio, claims and no           yes           no                    yes
//     billing reports                              (claims and billing:  (all)
//                                                   no; portfolio: no)
//
// Producer-code filtering for agents lives in policyCenter.js (canSee).

const levelOf = (user) => {
  if (user.role === 'Agent') return 'agent';
  if (user.role === 'UW Manager') return 'manager';
  if (user.role === 'Insurance Executive') return 'executive';
  return 'underwriter';
};

const isAgent = (user) => levelOf(user) === 'agent';
const isManager = (user) => levelOf(user) === 'manager';

const canSeeRatingFactors = (user) => ['underwriter', 'manager'].includes(levelOf(user));
const canSeeUnderwritingNotes = (user) => ['underwriter', 'manager'].includes(levelOf(user));
const canSeeClaimReserves = (user) => ['underwriter', 'manager'].includes(levelOf(user));
const canSeeBilling = (user) => levelOf(user) === 'manager';

// Sales figures: agents see their own; executives and managers see every salesperson (executives read only).
const canSeeSales = (user) => ['agent', 'executive', 'manager'].includes(levelOf(user));
const salesScope = (user) => (isAgent(user) ? 'own' : 'all');
// Writing follow-up notes: agents for their own sales, managers for all. Executives only read.
const canLogFollowUps = (user) => ['agent', 'manager'].includes(levelOf(user));

// Portfolio and claims reports: underwriters and managers. Billing reports: managers only.
const canSeePortfolioReport = (user) => ['underwriter', 'manager'].includes(levelOf(user));
const canSeeClaimsReport = (user) => ['underwriter', 'manager'].includes(levelOf(user));
const canSeeBillingReport = (user) => levelOf(user) === 'manager';

const roleLabel = (user) => ({ agent: 'Agent', underwriter: user.role, executive: 'Insurance Executive', manager: 'UW Manager' })[levelOf(user)];

module.exports = {
  levelOf, isAgent, isManager,
  canSeeRatingFactors, canSeeUnderwritingNotes, canSeeClaimReserves, canSeeBilling,
  canSeeSales, salesScope, canLogFollowUps, canSeePortfolioReport, canSeeClaimsReport, canSeeBillingReport,
  roleLabel,
};
