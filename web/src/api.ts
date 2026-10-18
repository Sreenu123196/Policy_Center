// The screens talk to the REST API (src/api, described at /openapi.json). Every function here is one API call.
// A POST carries an idempotency key chosen by the screen, so a retry after a failure does not do the work twice.

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly errors: string[] = [],
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface AccountView {
  id: string;
  accountNumber: string;
  producerCode: string;
}

export type TermDef =
  | { code: string; type: 'direct'; min: number; max?: number; default?: number }
  | { code: string; type: 'option'; options: (number | string)[]; default?: number | string };

export interface CoverageDef {
  code: string;
  names: { en: string };
  category: string;
  existence: 'required' | 'electable' | 'suggested';
  terms?: TermDef[];
}

export interface ProductView {
  product: string;
  version: string;
  names: { en: string };
  coverages: CoverageDef[];
}

export interface Address {
  line1: string;
  city: string;
  state: string;
  pinCode: string;
}

export interface SubmissionView {
  policy: { id: string; policyNumber: string };
  job: { id: string };
  branch: { id: string };
}

export interface QuoteView {
  id: string;
  premiumPaise: number;
  taxPaise: number;
  totalPaise: number;
  validUntil: string;
  rateBook: string;
  worksheet: { step: string; note: string; amountPaise?: number }[];
}

export interface PolicyFileView {
  policyNumber: string;
  productCode: string;
  cover: { status: 'in_force' | 'cancelled' | 'none'; version: number | null; cancelledOn: string | null };
  versions: { termNumber: number; version: number; periodStart: string; periodEnd: string; cancelledOn: string | null; jobType: string; jobNumber: string }[];
  transactions: { version: number; kind: string; effectiveDate: string; premiumPaise: number; taxPaise: number; totalPaise: number }[];
  documents: { id: string; kind: string; createdAt: string }[];
  claims: { claimNumber: string; lossDate: string; cause: string; status: string; verification: string }[];
}

export interface PolicyAsOfView {
  policyNumber: string;
  date: string;
  status: 'in_force' | 'not_in_force';
  message: string;
  termNumber: number | null;
  version: number | null;
  vehicles: { make: string | null; model: string | null; year: number | null; registrationNumber: string | null }[];
  coverages: { patternCode: string; terms: Record<string, number | string> }[];
}

export interface Api {
  listAccounts(): Promise<Page<AccountView>>;
  product(code: string, date: string): Promise<ProductView>;
  createContact(body: { kind: 'person'; name: string; address: Address }, key: string): Promise<{ id: string }>;
  createAccount(body: { namedInsuredContactId: string; producerCode: string }, key: string): Promise<AccountView>;
  startSubmission(body: { accountId: string; productCode: string; periodStart: string }, key: string): Promise<SubmissionView>;
  addVehicle(branchId: string, body: { attributes: Record<string, unknown> }, key: string): Promise<{ fixedId: string }>;
  addCoverage(branchId: string, body: { coverableFixedId: string; patternCode: string; terms: Record<string, number | string> }, key: string): Promise<{ fixedId: string }>;
  quote(jobId: string, branchId: string, key: string): Promise<QuoteView>;
  bind(jobId: string, branchId: string, key: string): Promise<unknown>;
  issue(jobId: string, key: string): Promise<{ document: { id: string } }>;
  policyFile(policyNumber: string): Promise<PolicyFileView>;
  policyAsOf(policyNumber: string, date: string): Promise<PolicyAsOfView>;
  downloadDocument(id: string): Promise<Blob>;
}

export interface ApiOptions {
  baseUrl?: string;
  getUser: () => string | null; // the identity provider sets X-User in production; here the screen sends the chosen demo user
  fetch?: typeof fetch;
}

export function createApi(options: ApiOptions): Api {
  const call = options.fetch ?? ((input, init) => fetch(input, init));
  const base = options.baseUrl ?? '';

  async function request(method: 'GET' | 'POST', path: string, body?: unknown, key?: string): Promise<Response> {
    const headers: Record<string, string> = {};
    const user = options.getUser();
    if (user !== null) headers['X-User'] = user;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (method === 'POST') headers['Idempotency-Key'] = key ?? crypto.randomUUID();
    let response: Response;
    try {
      response = await call(`${base}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    } catch {
      throw new ApiError(0, 'network', 'The server could not be reached');
    }
    if (response.ok) return response;
    const detail = (await response.json().catch(() => ({}))) as { error?: string; message?: string; errors?: string[]; issues?: { path: string; message: string }[] };
    const errors = detail.errors ?? detail.issues?.map((i) => `${i.path}: ${i.message}`) ?? [];
    throw new ApiError(response.status, detail.error ?? 'error', detail.message ?? `The request failed (${response.status})`, errors);
  }

  const get = async <T>(path: string): Promise<T> => (await request('GET', path)).json() as Promise<T>;
  const post = async <T>(path: string, body: unknown, key: string): Promise<T> => (await request('POST', path, body, key)).json() as Promise<T>;

  return {
    listAccounts: () => get('/v1/accounts?limit=200'),
    product: (code, date) => get(`/v1/products/${encodeURIComponent(code)}?date=${date}`),
    createContact: (body, key) => post('/v1/contacts', body, key),
    createAccount: (body, key) => post('/v1/accounts', body, key),
    startSubmission: (body, key) => post('/v1/submissions', body, key),
    addVehicle: (branchId, body, key) => post(`/v1/branches/${branchId}/vehicles`, body, key),
    addCoverage: (branchId, body, key) => post(`/v1/branches/${branchId}/coverages`, body, key),
    quote: (jobId, branchId, key) => post(`/v1/jobs/${jobId}/quote`, { branchId }, key),
    bind: (jobId, branchId, key) => post(`/v1/jobs/${jobId}/bind`, { branchId }, key),
    issue: (jobId, key) => post(`/v1/jobs/${jobId}/issue`, {}, key),
    policyFile: (number) => get(`/v1/policies/${encodeURIComponent(number)}`),
    policyAsOf: (number, date) => get(`/v1/policies/${encodeURIComponent(number)}/as-of?date=${date}`),
    downloadDocument: async (id) => (await request('GET', `/v1/documents/${id}`)).blob(),
  };
}
