// Claims module (document section 15): first notice of loss, exposures, reserves and payments.
// It asks Policy for the policy as it was on the loss date. This file is the module's public door.
export { loadClaimsConfig } from './config.js';
export type { ClaimsConfig, ClaimsConfigCatalogue } from './config.js';
export { CHANNELS, INCIDENT_KINDS, getClaim, listClaims, reportLoss } from './fnol.js';
export type { Channel, Claim, ClaimsDependencies, IncidentKind, LossReport, Verification } from './fnol.js';
export { addExposure, allowedExposureMoves, assignHandler, CLAIMANT_KINDS, deriveClaimStatus, EXPOSURE_STATUSES, getExposure, listExposures, moveExposure } from './exposures.js';
export type { ClaimantKind, Exposure, ExposureStatus, NewExposure } from './exposures.js';
export { approvePayment, COST_TYPES, getFinancials, listPayments, listReserveHistory, makePayment, PAYEE_KINDS, PAYMENT_METHODS, recordRecovery, RECOVERY_KINDS, setReserve } from './financials.js';
export type { ClaimPayment, ClaimPaymentMethod, CostType, Money, PaymentInput, Recovery, ReserveLine } from './financials.js';
