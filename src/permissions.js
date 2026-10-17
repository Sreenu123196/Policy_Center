'use strict';
// What each role may see through the assistant.
//
//   Agent                 Own producer code only: their accounts, policies, jobs and premiums.
//                         No rating factors and no underwriting notes (internal to underwriting).
//   Insurance Executive   All accounts and policies; underwriting issues and rating factors.
//   Underwriter           Same as Insurance Executive.
//   UW Manager            Same as Underwriter, plus sales figures for every producer.
//
// Producer-code filtering itself lives in policyCenter.js (canSee); these helpers decide the
// internal details that are shown on top of the records a user can already see.

const isAgent = (user) => user.role === 'Agent';

const canSeeRatingFactors = (user) => !isAgent(user);
const canSeeUnderwritingNotes = (user) => !isAgent(user);

// "all" for managers and underwriting staff, "own" for agents (their producer code only).
const salesScope = (user) => (isAgent(user) ? 'own' : 'all');

const roleLabel = (user) => (isAgent(user) ? 'Agent' : user.role);

// Claim reserves are the insurer's estimate of what a claim will cost: internal, so agents don't see them.
const canSeeClaimReserves = (user) => !isAgent(user);

module.exports = { isAgent, canSeeRatingFactors, canSeeUnderwritingNotes, salesScope, roleLabel, canSeeClaimReserves };
