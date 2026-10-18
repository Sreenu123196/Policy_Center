import { z } from 'zod';
import { generateInvoices, getBillingAccount, handlePolicyEvent, getInvoice, listCharges, listCredits, listInvoices, listScheduleItems, PAYMENT_METHODS, processPolicyEvents, receivePayment } from '../billing/index.js';
import {
  addExposure,
  approvePayment,
  CHANNELS,
  CLAIMANT_KINDS,
  COST_TYPES,
  EXPOSURE_STATUSES,
  getClaim,
  getExposure,
  getFinancials,
  INCIDENT_KINDS,
  listClaims,
  makePayment,
  moveExposure,
  PAYEE_KINDS,
  PAYMENT_METHODS as CLAIM_PAYMENT_METHODS,
  reportLoss,
  setReserve,
  listExposures,
} from '../claims/index.js';
import { createContact } from '../contacts/index.js';
import { listDeadEvents, ValidationError as PlatformValidationError, redriveDeadEvent } from '../platform/index.js';
import {
  accountIdOfBranch,
  accountIdOfJob,
  accountIdOfPolicy,
  accountIdOfPolicyNumber,
  addCoverable,
  addCoverage,
  bindJob,
  branchFingerprint,
  changeCoverage,
  createAccount,
  getBranch,
  getBranchAsOf,
  getJob,
  getCoverStatus,
  getDocument,
  getPolicyAsOf,
  issueJob,
  listDocuments,
  listTransactions,
  listVersions,
  listAccounts,
  policyIdOfNumber,
  policySummary,
  quoteBranch,
  startCancellation,
  startSubmission,
  withdrawJob,
  handleBillingEvent,
} from '../policy/index.js';
import { defineRoute, notFound, type Route } from './registry.js';
import { compact, dateText, etagOf, pageQuery, paginate, requireIfMatch, uuid, visibleAccount } from './route-helpers.js';

// Every route of the API (document section 17). Each is described once; the OpenAPI description is made from this list.

const terms = z.record(z.string(), z.union([z.number(), z.string()]));
const address = z.object({ line1: z.string(), line2: z.string().optional(), city: z.string(), state: z.string(), pinCode: z.string() });

// ---------------------------------------------------------------- contacts and accounts

const core: Route[] = [
  defineRoute({
    method: 'GET', path: '/v1/health', operationId: 'health', summary: 'Is the API running?', tag: 'System', public: true, success: 200,
    handler: async () => ({ body: { status: 'ok' } }),
  }),
  defineRoute({
    method: 'POST', path: '/v1/contacts', operationId: 'createContact', summary: 'Create a person or a company', tag: 'Contacts', permission: 'account.create', success: 201,
    body: z.object({
      kind: z.enum(['person', 'company']),
      name: z.string(),
      dateOfBirth: dateText.optional(),
      phone: z.string().optional(),
      email: z.string().optional(),
      address,
      pan: z.string().optional(),
      gstin: z.string().optional(),
      aadhaar: z.string().optional(),
    }),
    handler: async ({ db, body, user }) => ({ body: await createContact(db, compact({ ...body, address: compact(body.address) }), user.username) }),
  }),
  defineRoute({
    method: 'POST', path: '/v1/accounts', operationId: 'createAccount', summary: 'Open an account for a named insured under a producer code', tag: 'Accounts', permission: 'account.create', success: 201,
    body: z.object({ namedInsuredContactId: uuid, producerCode: z.string() }),
    handler: async ({ db, body, user }) => ({ body: await createAccount(db, body, user.username) }),
  }),
  defineRoute({
    method: 'GET', path: '/v1/accounts', operationId: 'listAccounts', summary: 'List the accounts the user may see (paged)', tag: 'Accounts', success: 200, query: pageQuery,
    handler: async ({ db, query, visibility }) => ({ body: paginate(await listAccounts(db, visibility), query) }),
  }),
  defineRoute({
    method: 'GET', path: '/v1/accounts/{id}', operationId: 'getAccount', summary: 'Read one account', tag: 'Accounts', success: 200,
    handler: async (context) => ({ body: await visibleAccount(context, context.params.id ?? null) }),
  }),
];

// ---------------------------------------------------------------- policy

const policy: Route[] = [
  defineRoute({
    method: 'POST', path: '/v1/submissions', operationId: 'startSubmission', summary: 'Start a new-business submission: policy, job and first option', tag: 'Policy', permission: 'submission.create', success: 201,
    body: z.object({ accountId: uuid, productCode: z.string(), periodStart: dateText }),
    handler: async (context) => {
      await visibleAccount(context, context.body.accountId);
      return { body: await startSubmission(context.db, context.config.catalogue, context.body, context.user.username) };
    },
  }),
  defineRoute({
    method: 'GET', path: '/v1/jobs/{id}', operationId: 'getJob', summary: 'Read a job', tag: 'Policy', success: 200,
    handler: async (context) => {
      await visibleAccount(context, await accountIdOfJob(context.db, context.params.id ?? ''), 'The job');
      const job = await getJob(context.db, context.params.id ?? '');
      if (job === null) throw notFound('The job');
      return { body: job };
    },
  }),
  defineRoute({
    method: 'GET', path: '/v1/branches/{id}', operationId: 'getBranch', summary: 'Read a working copy as of a date, with its ETag', tag: 'Policy', success: 200,
    query: z.object({ date: dateText.optional() }),
    handler: async (context) => {
      const id = context.params.id ?? '';
      await visibleAccount(context, await accountIdOfBranch(context.db, id), 'The branch');
      const branch = await getBranch(context.db, id);
      if (branch === null) throw notFound('The branch');
      const snapshot = await getBranchAsOf(context.db, id, context.query.date ?? branch.periodStart);
      return { body: { ...branch, date: snapshot?.date, coverables: snapshot?.coverables ?? [], coverages: snapshot?.coverages ?? [] }, headers: { ETag: etagOf(await branchFingerprint(context.db, id)) } };
    },
  }),
  defineRoute({
    method: 'POST', path: '/v1/branches/{id}/vehicles', operationId: 'addVehicle', summary: 'Add the vehicle to a working copy', tag: 'Policy', permission: 'submission.create', success: 201,
    body: z.object({ attributes: z.record(z.string(), z.unknown()), effFrom: dateText.optional(), effTo: dateText.optional() }),
    handler: async (context) => {
      const id = context.params.id ?? '';
      await visibleAccount(context, await accountIdOfBranch(context.db, id), 'The branch');
      return { body: await addCoverable(context.db, id, compact({ kind: 'Vehicle' as const, ...context.body }), context.user.username) };
    },
  }),
  defineRoute({
    method: 'POST', path: '/v1/branches/{id}/coverages', operationId: 'addCoverage', summary: 'Add a cover to a working copy, from a date', tag: 'Policy', permission: 'submission.create', success: 201,
    body: z.object({ coverableFixedId: uuid, patternCode: z.string(), terms: terms.optional(), effFrom: dateText.optional(), effTo: dateText.optional() }),
    handler: async (context) => {
      const id = context.params.id ?? '';
      await visibleAccount(context, await accountIdOfBranch(context.db, id), 'The branch');
      return { body: await addCoverage(context.db, id, compact(context.body), context.user.username) };
    },
  }),
  defineRoute({
    method: 'PATCH', path: '/v1/branches/{id}/coverages/{fixedId}', operationId: 'changeCoverage', summary: 'Change the terms of a cover from a date (needs If-Match)', tag: 'Policy', permission: 'submission.create', success: 200,
    ifMatch: true,
    body: z.object({ terms, effectiveDate: dateText.optional() }),
    handler: async (context) => {
      const id = context.params.id ?? '';
      await visibleAccount(context, await accountIdOfBranch(context.db, id), 'The branch');
      requireIfMatch(context, await branchFingerprint(context.db, id));
      await changeCoverage(context.db, id, compact({ coverageFixedId: context.params.fixedId ?? '', terms: context.body.terms, effectiveDate: context.body.effectiveDate }), context.user.username);
      const branch = await getBranch(context.db, id);
      const snapshot = branch ? await getBranchAsOf(context.db, id, branch.periodStart) : null;
      return { body: { ...branch, date: snapshot?.date, coverables: snapshot?.coverables ?? [], coverages: snapshot?.coverages ?? [] }, headers: { ETag: etagOf(await branchFingerprint(context.db, id)) } };
    },
  }),
  defineRoute({
    method: 'POST', path: '/v1/jobs/{id}/quote', operationId: 'quoteJob', summary: 'Price a working copy of the job (underwriting rules apply)', tag: 'Policy', permission: 'submission.create', success: 200,
    body: z.object({ branchId: uuid }),
    handler: async (context) => {
      const jobId = context.params.id ?? '';
      await visibleAccount(context, await accountIdOfJob(context.db, jobId), 'The job');
      const branch = await getBranch(context.db, context.body.branchId);
      if (branch === null || branch.jobId !== jobId) throw notFound('The branch of this job');
      const { catalogue, quoter, underwriting } = context.config;
      return { body: await quoteBranch(context.db, { catalogue, quoter, underwriting: { rules: underwriting } }, branch.id, context.user.username, { today: context.today() }) };
    },
  }),
  defineRoute({
    method: 'POST', path: '/v1/jobs/{id}/bind', operationId: 'bindJob', summary: 'Bind the chosen quoted option as the next policy version', tag: 'Policy', permission: 'policy.bind', success: 200,
    body: z.object({ branchId: uuid }),
    handler: async (context) => {
      const jobId = context.params.id ?? '';
      await visibleAccount(context, await accountIdOfJob(context.db, jobId), 'The job');
      const { catalogue, underwriting } = context.config;
      return { body: await bindJob(context.db, { catalogue, underwriting: { rules: underwriting } }, jobId, context.body, context.user.username, { today: context.today() }) };
    },
  }),
  defineRoute({
    method: 'POST', path: '/v1/jobs/{id}/issue', operationId: 'issueJob', summary: 'Issue a bound job and produce its document', tag: 'Policy', permission: 'policy.bind', success: 200,
    handler: async (context) => {
      const jobId = context.params.id ?? '';
      await visibleAccount(context, await accountIdOfJob(context.db, jobId), 'The job');
      const { catalogue, underwriting } = context.config;
      return { body: await issueJob(context.db, { catalogue, underwriting: { rules: underwriting } }, jobId, context.user.username, { today: context.today() }) };
    },
  }),
  defineRoute({
    method: 'POST', path: '/v1/jobs/{id}/withdraw', operationId: 'withdrawJob', summary: 'Withdraw a submission', tag: 'Policy', permission: 'submission.create', success: 200,
    body: z.object({ reason: z.string().optional() }),
    handler: async (context) => {
      const jobId = context.params.id ?? '';
      await visibleAccount(context, await accountIdOfJob(context.db, jobId), 'The job');
      return { body: await withdrawJob(context.db, jobId, context.user.username, context.body.reason) };
    },
  }),
  defineRoute({
    method: 'GET', path: '/v1/products/{code}', operationId: 'getProduct', summary: 'The product version in force on a date: its covers and their terms', tag: 'Policy', success: 200,
    query: z.object({ date: dateText }),
    handler: async (context) => {
      const version = context.config.catalogue.versionInForce(context.params.code ?? '', context.query.date);
      if (version === null) throw notFound('The product version');
      return { body: { product: version.product, version: version.version, effectiveFrom: version.effective_from, names: version.names, coverages: version.line.coverages } };
    },
  }),
  defineRoute({
    method: 'GET', path: '/v1/policies/{number}', operationId: 'getPolicyFile', summary: 'The policy file: versions, premium transactions, documents and claims', tag: 'Policy', success: 200,
    handler: async (context) => {
      const number = context.params.number ?? '';
      const summary = await policySummary(context.db, number);
      if (summary === null) throw notFound('The policy');
      await visibleAccount(context, summary.accountId, 'The policy');
      const policyId = summary.policyId;
      const [versions, transactions, documents, claims, cover] = await Promise.all([
        listVersions(context.db, policyId),
        listTransactions(context.db, policyId),
        listDocuments(context.db, policyId),
        listClaims(context.db, { policyNumber: number }),
        getCoverStatus(context.db, policyId),
      ]);
      return {
        body: {
          policyNumber: number,
          productCode: summary.productCode,
          accountId: summary.accountId,
          cover,
          versions,
          transactions,
          documents,
          claims: claims.map((c) => ({ claimNumber: c.claimNumber, lossDate: c.lossDate, cause: c.cause, status: c.status, verification: c.verification.status })),
        },
      };
    },
  }),
  defineRoute({
    method: 'GET', path: '/v1/documents/{id}', operationId: 'downloadDocument', summary: 'Download a document (the PDF itself)', tag: 'Policy', success: 200, produces: 'application/pdf',
    handler: async (context) => {
      const document = await getDocument(context.db, context.params.id ?? '');
      if (document === null) throw notFound('The document');
      await visibleAccount(context, await accountIdOfPolicy(context.db, document.policyId), 'The document');
      return {
        body: Buffer.from(document.content),
        headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${document.metadata.policyNumber}-${document.kind}.pdf"` },
      };
    },
  }),
  defineRoute({
    method: 'GET', path: '/v1/policies/{number}/as-of', operationId: 'getPolicyAsOf', summary: 'The policy as it was on a date: in force or not, the vehicle, the covers', tag: 'Policy', success: 200,
    query: z.object({ date: dateText }),
    handler: async (context) => {
      const number = context.params.number ?? '';
      await visibleAccount(context, await accountIdOfPolicyNumber(context.db, number), 'The policy');
      const found = await getPolicyAsOf(context.db, number, context.query.date);
      if (found === null) throw notFound('The policy');
      return { body: found };
    },
  }),
  defineRoute({
    method: 'POST', path: '/v1/policies/{number}/cancellations', operationId: 'startCancellation', summary: 'Start a cancellation and work out the refund', tag: 'Policy', permission: 'policy.bind', success: 201,
    body: z.object({ effectiveDate: dateText, reasonCode: z.string(), method: z.enum(['flat', 'pro_rata', 'short_rate']).optional() }),
    handler: async (context) => {
      const number = context.params.number ?? '';
      await visibleAccount(context, await accountIdOfPolicyNumber(context.db, number), 'The policy');
      const policyId = await policyIdOfNumber(context.db, number);
      if (policyId === null) throw notFound('The policy');
      const { catalogue, cancellation } = context.config;
      return { body: await startCancellation(context.db, { catalogue, cancellation }, compact({ policyId, ...context.body }), context.user.username, { today: context.today() }) };
    },
  }),
];

// ---------------------------------------------------------------- billing

const billing: Route[] = [
  defineRoute({
    method: 'GET', path: '/v1/accounts/{id}/billing', operationId: 'getBilling', summary: 'The billing account: charges, payment items, credits and invoices', tag: 'Billing', permission: 'billing.view', success: 200,
    handler: async (context) => {
      const account = await visibleAccount(context, context.params.id ?? null);
      const billingAccount = await getBillingAccount(context.db, account.id);
      if (billingAccount === null) throw notFound('The billing account');
      const invoices = await listInvoices(context.db, billingAccount.id);
      return {
        body: {
          account: billingAccount,
          charges: await listCharges(context.db, billingAccount.id),
          scheduleItems: await listScheduleItems(context.db, billingAccount.id),
          credits: await listCredits(context.db, billingAccount.id),
          invoices: await Promise.all(invoices.map(async (i) => (await getInvoice(context.db, i.id)) ?? i)),
        },
      };
    },
  }),
  defineRoute({
    method: 'POST', path: '/v1/payments', operationId: 'receivePayment', summary: 'Take a payment for an account and allocate it, oldest invoice first', tag: 'Billing', permission: 'billing.pay', success: 201,
    body: z.object({ accountId: uuid, amountPaise: z.number().int(), method: z.enum(PAYMENT_METHODS), reference: z.string(), receivedOn: dateText, policyNumber: z.string().optional(), note: z.string().optional() }),
    handler: async (context) => {
      await visibleAccount(context, context.body.accountId);
      return { body: await receivePayment(context.db, compact(context.body), context.user.username) };
    },
  }),
  defineRoute({
    method: 'POST', path: '/v1/admin/billing/process-events', operationId: 'processBillingEvents', summary: 'Run the billing consumer: turn policy events into charges', tag: 'Admin', permission: 'admin.manage_users', success: 200,
    handler: async (context) => ({ body: await processPolicyEvents(context.db, context.config.billing) }),
  }),
  defineRoute({
    method: 'POST', path: '/v1/admin/billing/invoices', operationId: 'generateInvoices', summary: 'Run the invoice batch for a date', tag: 'Admin', permission: 'admin.manage_users', success: 200,
    body: z.object({ today: dateText.optional() }),
    handler: async (context) => ({ body: { invoices: await generateInvoices(context.db, context.config.billing, { today: context.body.today ?? context.today() }, context.user.username) } }),
  }),
  defineRoute({
    method: 'GET', path: '/v1/admin/events/dead', operationId: 'listDeadEvents', summary: 'Events a consumer gave up on, waiting for a person', tag: 'Admin', permission: 'admin.manage_users', success: 200,
    handler: async (context) => ({ body: { items: await listDeadEvents(context.db) } }),
  }),
  defineRoute({
    method: 'POST', path: '/v1/admin/events/dead/{consumer}/{eventId}/redrive', operationId: 'redriveDeadEvent', summary: 'Run the consumer once more on a dead event, after the cause was fixed', tag: 'Admin', permission: 'admin.manage_users', success: 200,
    handler: async (context) => {
      const { consumer, eventId } = context.params;
      const { catalogue, cancellation, billing } = context.config;
      const handlers: Record<string, Parameters<typeof redriveDeadEvent>[1]['handle']> = {
        billing: async (event) => void (await handlePolicyEvent(context.db, billing, event)),
        'billing-requests': async (event) => void (await handleBillingEvent(context.db, { catalogue, cancellation }, context.user.username, context.today(), event)),
      };
      const handle = handlers[consumer ?? ''];
      if (handle === undefined) throw new PlatformValidationError([`There is no consumer called ${consumer}`]);
      return { body: await redriveDeadEvent(context.db, { consumer: consumer ?? '', eventId: Number(eventId), handle }, context.user.username) };
    },
  }),
];

// ---------------------------------------------------------------- claims

const lossReport = z.object({
  policyNumber: z.string().optional(),
  registrationNumber: z.string().optional(),
  lossDate: dateText,
  lossTime: z.string().optional(),
  reportedOn: dateText,
  cause: z.string(),
  place: z.string(),
  description: z.string(),
  channel: z.enum(CHANNELS),
  reporter: z.object({ name: z.string(), phone: z.string().optional() }).optional(),
  incidents: z.array(z.object({ kind: z.enum(INCIDENT_KINDS), description: z.string() })).optional(),
  attachments: z.array(z.object({ reference: z.string(), caption: z.string().optional() })).optional(),
});

async function claimOf(context: Parameters<typeof visibleAccount>[0], number: string) {
  const claim = await getClaim(context.db, number);
  if (claim === null) throw notFound('The claim');
  await visibleAccount(context, claim.accountId, 'The claim');
  return claim;
}

async function exposureOf(context: Parameters<typeof visibleAccount>[0], id: string) {
  const exposure = await getExposure(context.db, id);
  if (exposure === null) throw notFound('The exposure');
  await claimOf(context, exposure.claimId);
  return exposure;
}

const claims: Route[] = [
  defineRoute({
    method: 'POST', path: '/v1/claims', operationId: 'reportLoss', summary: 'First notice of loss', tag: 'Claims', permission: 'claim.report', success: 201, body: lossReport,
    handler: async (context) => {
      const policyAccount = context.body.policyNumber === undefined ? null : await accountIdOfPolicyNumber(context.db, context.body.policyNumber);
      if (policyAccount !== null) await visibleAccount(context, policyAccount, 'The policy');
      return { body: await reportLoss(context.db, { config: context.config.claims }, compact(context.body), context.user.username, { today: context.today() }) };
    },
  }),
  defineRoute({
    method: 'GET', path: '/v1/claims', operationId: 'listClaims', summary: 'List claims the user may see (paged), optionally for one policy', tag: 'Claims', success: 200,
    query: pageQuery.extend({ policyNumber: z.string().optional() }),
    handler: async (context) => {
      const all = await listClaims(context.db, compact({ policyNumber: context.query.policyNumber }));
      const visible = [];
      for (const claim of all) if (context.visibility === 'all' || (await visibleAccount(context, claim.accountId).then(() => true, () => false))) visible.push(claim);
      return { body: paginate(visible, context.query) };
    },
  }),
  defineRoute({
    method: 'GET', path: '/v1/claims/{number}', operationId: 'getClaim', summary: 'Read a claim with its exposures', tag: 'Claims', success: 200,
    handler: async (context) => {
      const claim = await claimOf(context, context.params.number ?? '');
      return { body: { ...claim, exposures: await listExposures(context.db, claim.id) } };
    },
  }),
  defineRoute({
    method: 'GET', path: '/v1/claims/{number}/financials', operationId: 'getClaimFinancials', summary: 'Paid, outstanding, recovered and incurred, by exposure and cost type', tag: 'Claims', success: 200,
    handler: async (context) => {
      const claim = await claimOf(context, context.params.number ?? '');
      return { body: await getFinancials(context.db, claim.id) };
    },
  }),
  defineRoute({
    method: 'POST', path: '/v1/claims/{number}/exposures', operationId: 'addExposure', summary: 'Add an exposure: one claimant against one cover', tag: 'Claims', permission: 'claim.handle', success: 201,
    body: z.object({ coverageCode: z.string(), claimant: z.object({ name: z.string(), kind: z.enum(CLAIMANT_KINDS) }), description: z.string(), overrideReason: z.string().optional() }),
    handler: async (context) => {
      const claim = await claimOf(context, context.params.number ?? '');
      return { body: await addExposure(context.db, { config: context.config.claims }, claim.id, compact(context.body), context.user.username) };
    },
  }),
  defineRoute({
    method: 'POST', path: '/v1/exposures/{id}/status', operationId: 'moveExposure', summary: 'Move an exposure along its life cycle', tag: 'Claims', permission: 'claim.handle', success: 200,
    body: z.object({ to: z.enum(EXPOSURE_STATUSES), reason: z.string().optional() }),
    handler: async (context) => {
      const exposure = await exposureOf(context, context.params.id ?? '');
      return { body: await moveExposure(context.db, exposure.id, context.body.to, context.user.username, context.body.reason) };
    },
  }),
  defineRoute({
    method: 'POST', path: '/v1/exposures/{id}/reserves', operationId: 'setReserve', summary: 'Set the outstanding reserve of a line (limited by financial authority)', tag: 'Claims', permission: 'claim.handle', success: 200,
    body: z.object({ costType: z.enum(COST_TYPES), category: z.string(), outstandingPaise: z.number().int(), reason: z.string() }),
    handler: async (context) => {
      const exposure = await exposureOf(context, context.params.id ?? '');
      return { body: await setReserve(context.db, { config: context.config.claims }, exposure.id, context.body, context.user.username) };
    },
  }),
  defineRoute({
    method: 'POST', path: '/v1/exposures/{id}/payments', operationId: 'makeClaimPayment', summary: 'Pay from a reserve line (above the requester\'s limit it waits for approval)', tag: 'Claims', permission: 'claim.pay', success: 201,
    body: z.object({
      costType: z.enum(COST_TYPES),
      category: z.string(),
      amountPaise: z.number().int(),
      kind: z.enum(['partial', 'final']),
      payee: z.object({ kind: z.enum(PAYEE_KINDS), name: z.string(), bank: z.object({ ifsc: z.string(), accountNumber: z.string() }).optional(), upi: z.string().optional() }),
      method: z.enum(CLAIM_PAYMENT_METHODS),
      reference: z.string(),
      paidOn: dateText,
      note: z.string().optional(),
    }),
    handler: async (context) => {
      const exposure = await exposureOf(context, context.params.id ?? '');
      const body = { ...context.body, payee: compact(context.body.payee) };
      return { body: await makePayment(context.db, { config: context.config.claims }, exposure.id, compact(body), context.user.username) };
    },
  }),
  defineRoute({
    method: 'POST', path: '/v1/claim-payments/{id}/approve', operationId: 'approveClaimPayment', summary: 'A second person approves a payment that was above the requester\'s limit', tag: 'Claims', permission: 'claim.pay', success: 200,
    body: z.object({ reason: z.string() }),
    handler: async (context) => ({ body: await approvePayment(context.db, { config: context.config.claims }, context.params.id ?? '', context.user.username, context.body.reason) }),
  }),
];

export const allRoutes: Route[] = [...core, ...policy, ...billing, ...claims];
