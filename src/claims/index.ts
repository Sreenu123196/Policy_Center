// Claims module (document section 15): first notice of loss, exposures, reserves and payments.
// It asks Policy for the policy as it was on the loss date. This file is the module's public door.
export { loadClaimsConfig } from './config.js';
export type { ClaimsConfig, ClaimsConfigCatalogue } from './config.js';
export { CHANNELS, INCIDENT_KINDS, getClaim, listClaims, reportLoss } from './fnol.js';
export type { Channel, Claim, ClaimsDependencies, IncidentKind, LossReport, Verification } from './fnol.js';
