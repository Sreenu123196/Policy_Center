import { vi } from 'vitest';
import type { Api, PolicyAsOfView, PolicyFileView, ProductView, QuoteView } from './api.js';

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

export function fakeApi(overrides: Partial<Api> = {}): { [K in keyof Api]: ReturnType<typeof vi.fn<Api[K]>> } {
  const api: Api = {
    listAccounts: async () => ({ items: [], total: 0, limit: 200, offset: 0 }),
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
