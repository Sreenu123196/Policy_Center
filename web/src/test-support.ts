import { vi } from 'vitest';
import type { AccountView, Api, BillingView, ClaimView, ExposureView, FinancialsView, PolicyAsOfView, PolicyFileView, ProductView, QuoteView } from './api.js';

// Stand-ins for the API, so the screens can be tested without a server. Each call is a spy the test can look at.

export const product: ProductView = {
  product: 'MOTOR_PRIVATE_CAR',
  version: '2026.10',
  names: { en: 'Private car insurance' },
  coverages: [
    { code: 'MOTOR_TP', names: { en: 'Third-party liability' }, category: 'liability', existence: 'required' },
    {
      code: 'MOTOR_OD',
      names: { en: 'Own damage' },
      category: 'own_damage',
      existence: 'electable',
      terms: [
        { code: 'idv', type: 'direct', min: 5000000, max: 500000000 },
        { code: 'vol_deductible', type: 'option', options: [0, 250000, 500000], default: 0 },
      ],
    },
    { code: 'PA_OWNER_DRIVER', names: { en: 'Personal accident cover for owner-driver' }, category: 'personal_accident', existence: 'required' },
    { code: 'ZERO_DEP', names: { en: 'Zero depreciation' }, category: 'add_on', existence: 'electable' },
  ],
};

export const quote: QuoteView = {
  id: 'q1',
  premiumPaise: 1574600,
  taxPaise: 283428,
  totalPaise: 1858028,
  validUntil: '2026-11-15',
  rateBook: 'MPC-2026.10',
  worksheet: [
    { step: 'rate book', note: 'MPC-2026.10' },
    { step: 'cost MOTOR_OD', note: 'MOTOR_OD for the whole period', amountPaise: 1200000 },
  ],
};

export const policyFile: PolicyFileView = {
  policyNumber: 'PL-0000001',
  productCode: 'MOTOR_PRIVATE_CAR',
  cover: { status: 'in_force', version: 2, cancelledOn: null },
  versions: [
    { termNumber: 1, version: 1, periodStart: '2026-10-15', periodEnd: '2027-10-15', cancelledOn: null, jobType: 'submission', jobNumber: 'J-0000001' },
    { termNumber: 1, version: 2, periodStart: '2026-10-15', periodEnd: '2027-10-15', cancelledOn: null, jobType: 'policy_change', jobNumber: 'J-0000002' },
  ],
  transactions: [
    { version: 1, kind: 'new_business', effectiveDate: '2026-10-15', premiumPaise: 1574600, taxPaise: 283428, totalPaise: 1858028 },
    { version: 2, kind: 'change', effectiveDate: '2027-01-01', premiumPaise: 377424, taxPaise: 67936, totalPaise: 445360 },
  ],
  documents: [{ id: 'doc-1', kind: 'policy_schedule', createdAt: '2026-10-16T00:00:00.000Z' }],
  claims: [{ claimNumber: 'CL-0000001', lossDate: '2026-12-01', cause: 'collision', status: 'under_review', verification: 'verified' }],
};

export const asOf: PolicyAsOfView = {
  policyNumber: 'PL-0000001',
  date: '2026-12-01',
  status: 'in_force',
  message: 'The policy was in force on 01-12-2026',
  termNumber: 1,
  version: 1,
  vehicles: [{ make: 'Maruti', model: 'Swift', year: 2023, registrationNumber: 'TS09XX0001' }],
  coverages: [
    { patternCode: 'MOTOR_TP', terms: {} },
    { patternCode: 'MOTOR_OD', terms: { idv: 50000000 } },
  ],
};

export const accounts: AccountView[] = [
  { id: 'acc-1', accountNumber: 'AC-0000001', producerCode: 'PC-100', status: 'active', contacts: [{ contactId: 'c1', role: 'named_insured' }] },
  { id: 'acc-2', accountNumber: 'AC-0000002', producerCode: 'PC-200', status: 'closed', contacts: [] },
];

export const billing: BillingView = {
  account: { id: 'bill-1', planCode: 'ANNUAL', status: 'active' },
  charges: [
    { id: 'ch1', policyNumber: 'PL-0000001', kind: 'new_business', type: 'premium', effectiveDate: '2026-10-15', amountPaise: 1574600 },
    { id: 'ch2', policyNumber: 'PL-0000001', kind: 'new_business', type: 'tax', effectiveDate: '2026-10-15', amountPaise: 283428 },
  ],
  scheduleItems: [
    { id: 's1', policyNumber: 'PL-0000001', kind: 'new_business', sequence: 1, dueDate: '2026-10-15', amountPaise: 1858028, status: 'invoiced' },
    { id: 's2', policyNumber: 'PL-0000001', kind: 'change', sequence: 1, dueDate: '2027-01-01', amountPaise: 445360, status: 'scheduled' },
  ],
  credits: [{ id: 'cr1', policyNumber: 'PL-0000001', kind: 'cancellation', totalPaise: 100000, remainingPaise: 40000, status: 'open' }],
  invoices: [
    { id: 'i1', number: 'INV-0000001', invoiceDate: '2026-09-25', dueDate: '2026-10-15', totalPaise: 1858028, paidPaise: 1000000, outstandingPaise: 858028, status: 'open' },
    { id: 'i2', number: 'INV-0000002', invoiceDate: '2026-12-10', dueDate: '2027-01-01', totalPaise: 445360, paidPaise: 445360, outstandingPaise: 0, status: 'paid' },
  ],
};

export const claims: ClaimView[] = [
  { claimNumber: 'CL-0000001', policyNumber: 'PL-0000001', lossDate: '2026-12-01', reportedOn: '2026-12-02', cause: 'collision', place: 'Hyderabad', description: 'Rear-ended at a signal', status: 'under_review', verification: 'verified', lateReport: false, reporter: { name: 'Asha Rao', phone: null } },
  { claimNumber: 'CL-0000002', policyNumber: 'PL-0000002', lossDate: '2026-11-20', reportedOn: '2027-01-05', cause: 'theft', place: 'Warangal', description: 'Car stolen overnight', status: 'rejected', verification: 'not_verified', lateReport: true, reporter: null },
];

export const exposures: ExposureView[] = [
  { id: 'e1', number: 1, coverageCode: 'MOTOR_OD', claimant: { name: 'Asha Rao', kind: 'insured' }, description: 'Own car damage', status: 'approved', handler: 'carl.claims', limitPaise: 50000000, deductiblePaise: 100000 },
  { id: 'e2', number: 2, coverageCode: 'MOTOR_TP', claimant: { name: 'Ravi Kumar', kind: 'third_party' }, description: 'Damage to a motorcycle', status: 'under_review', handler: null, limitPaise: null, deductiblePaise: 0 },
];

export const financials: FinancialsView = {
  claim: { paidPaise: 3000000, outstandingPaise: 2000000, recoveredPaise: 500000, incurredPaise: 4500000 },
  exposures: [
    { number: 1, status: 'approved', paidPaise: 3000000, outstandingPaise: 1000000, recoveredPaise: 500000, incurredPaise: 3500000 },
    { number: 2, status: 'under_review', paidPaise: 0, outstandingPaise: 1000000, recoveredPaise: 0, incurredPaise: 1000000 },
  ],
  byCostType: {
    claim_cost: { paidPaise: 2800000, outstandingPaise: 2000000, recoveredPaise: 500000, incurredPaise: 4300000 },
    expense: { paidPaise: 200000, outstandingPaise: 0, recoveredPaise: 0, incurredPaise: 200000 },
  },
};

export function fakeApi(overrides: Partial<Api> = {}): { [K in keyof Api]: ReturnType<typeof vi.fn<Api[K]>> } {
  const api: Api = {
    listAccounts: async () => ({ items: accounts, total: accounts.length, limit: 200, offset: 0 }),
    account: async (id) => accounts.find((a) => a.id === id) ?? accounts[0]!,
    billing: async () => billing,
    listClaims: async () => ({ items: claims, total: claims.length, limit: 200, offset: 0 }),
    claim: async (number) => ({ ...(claims.find((c) => c.claimNumber === number) ?? claims[0]!), exposures }),
    claimFinancials: async () => financials,
    product: async () => product,
    createContact: async () => ({ id: 'contact-1' }),
    createAccount: async () => ({ id: 'account-1', accountNumber: 'AC-0000001', producerCode: 'PC-100' }),
    startSubmission: async () => ({ policy: { id: 'p1', policyNumber: 'PL-0000001' }, job: { id: 'job-1' }, branch: { id: 'branch-1' } }),
    addVehicle: async () => ({ fixedId: 'vehicle-1' }),
    addCoverage: async () => ({ fixedId: 'cover-1' }),
    quote: async () => quote,
    bind: async () => ({}),
    issue: async () => ({ document: { id: 'doc-1' } }),
    policyFile: async (number) => ({ ...policyFile, policyNumber: number }),
    policyAsOf: async () => asOf,
    downloadDocument: async () => new Blob(['%PDF-']),
    ...overrides,
  };
  return Object.fromEntries(Object.entries(api).map(([name, fn]) => [name, vi.fn(fn as never)])) as never;
}
