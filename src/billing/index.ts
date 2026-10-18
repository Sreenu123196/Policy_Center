// Billing module (document section 14): charges, payment plans, invoices and payments.
// It learns about policy changes only through events (the outbox). This file is the module's public door.
export { loadBillingConfig } from './config.js';
export type { BillingConfig, BillingConfigCatalogue, PaymentPlan } from './config.js';
export { splitCharge } from './plan-split.js';
export type { ScheduleItem } from './plan-split.js';
export { generateInvoices, getBillingAccount, getInvoice, listCharges, listCredits, listInvoices, listScheduleItems, handlePolicyEvent, processPolicyEvents, setPaymentPlan } from './billing.js';
export type { BillingAccount, BillingScheduleItem, Charge, Credit, Invoice, InvoiceLine } from './billing.js';
export { applyCredit, getPayment, listDelinquencySteps, listSuspense, matchSuspense, PAYMENT_METHODS, receivePayment, receiveUnmatchedPayment, refundCredit, runDelinquency } from './payments.js';
export type { DelinquencyAction, NewPayment, Payment, PaymentMethod, Payout } from './payments.js';
