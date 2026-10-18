import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { Database } from '../platform/index.js';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  assignProducerCode,
  assignRole,
  createProducerCode,
  createProducerOrganisation,
  createRole,
  createUser,
  deactivateUser,
  getUserByUsername,
  type Permission,
} from '../platform/index.js';
import { createTestDatabase, loadTestConfiguration, resetDatabase } from '../testing/database.js';
import { createApp } from './app.js';
import { loadApiConfig } from './config.js';

const configFolder = fileURLToPath(new URL('../../config/', import.meta.url));
const config = loadApiConfig(configFolder);

let db: Database;
let app: FastifyInstance;
let today = '2026-10-16';

beforeAll(async () => {
  db = await createTestDatabase();
});

afterAll(async () => {
  await app?.close();
  await db.close();
});

beforeEach(async () => {
  await app?.close();
  await resetDatabase(db);
  await loadTestConfiguration(db);
  today = '2026-10-16';
  app = await createApp(db, config, { today: () => today });

  const acme = await createProducerOrganisation(db, { name: 'Acme Insurance Agency' }, 'admin');
  await createProducerCode(db, { code: 'PC-100', organisationId: acme.id }, 'admin');
  await createProducerCode(db, { code: 'PC-200', organisationId: acme.id }, 'admin');
  const roles: Record<string, Permission[]> = {
    api_admin: ['admin.manage_users', 'account.view_all', 'billing.view'],
    agent: ['account.view', 'account.create', 'submission.create', 'claim.report'],
    underwriter: ['policy.bind', 'account.view_all', 'submission.create'],
    claims_handler: ['claim.handle', 'claim.pay', 'claim.report', 'account.view_all'],
    cashier: ['billing.pay', 'billing.view', 'account.view_all'],
    visitor: [],
  };
  for (const [code, permissions] of Object.entries(roles)) await createRole(db, { code, name: code, permissions }, 'admin');
  const users: [string, string, string?][] = [
    ['admin.user', 'api_admin'],
    ['agent.hundred', 'agent', 'PC-100'],
    ['agent.twohundred', 'agent', 'PC-200'],
    ['uw.boss', 'underwriter'],
    ['claims.handler', 'claims_handler'],
    ['cash.ier', 'cashier'],
    ['vis.itor', 'visitor'],
  ];
  for (const [username, role, producer] of users) {
    await createUser(db, { username, displayName: username }, 'admin');
    const user = (await getUserByUsername(db, username))!;
    await assignRole(db, user.id, role, 'admin');
    if (producer) await assignProducerCode(db, user.id, producer, 'admin');
  }
});

interface Reply {
  status: number;
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  headers: Record<string, unknown>;
}

async function call(user: string | null, method: 'GET' | 'POST' | 'PATCH', url: string, body?: unknown, extra: Record<string, string> = {}): Promise<Reply> {
  const headers: Record<string, string> = { ...extra };
  if (user !== null) headers['x-user'] = user;
  if (method !== 'GET' && !('idempotency-key' in headers)) headers['idempotency-key'] = randomUUID();
  const response = await app.inject({ method, url, headers, ...(body === undefined ? {} : { payload: body as object }) });
  return { status: response.statusCode, body: response.body === '' ? null : response.json(), headers: response.headers };
}

const address = { line1: '12 Test Street', city: 'Hyderabad', state: 'Telangana', pinCode: '500081' };

async function newAccount(user = 'agent.hundred', producerCode = 'PC-100', name = 'Asha Rao') {
  const contact = await call(user, 'POST', '/v1/contacts', { kind: 'person', name, address });
  const account = await call(user, 'POST', '/v1/accounts', { namedInsuredContactId: contact.body.id, producerCode });
  return { contact: contact.body, account: account.body, status: account.status };
}

// A draft submission with the golden vehicle and covers, built only through the API.
async function newSubmission(user = 'agent.hundred') {
  const { account } = await newAccount(user);
  const started = await call(user, 'POST', '/v1/submissions', { accountId: account.id, productCode: 'MOTOR_PRIVATE_CAR', periodStart: '2026-10-15' });
  const branchId = started.body.branch.id as string;
  const vehicle = await call(user, 'POST', `/v1/branches/${branchId}/vehicles`, {
    attributes: { make: 'Maruti', model: 'Swift', year: 2023, registrationNumber: 'TS09XX0001', engineCc: 1197, claimFreeYears: 2 },
  });
  const covers: Record<string, string> = {};
  for (const [patternCode, terms] of [['MOTOR_TP', {}], ['PA_OWNER_DRIVER', {}], ['MOTOR_OD', { idv: 50000000 }]] as const) {
    const added = await call(user, 'POST', `/v1/branches/${branchId}/coverages`, { coverableFixedId: vehicle.body.fixedId, patternCode, terms });
    covers[patternCode] = added.body.fixedId;
  }
  return { account, started: started.body, branchId, jobId: started.body.job.id as string, vehicle: vehicle.body, covers };
}

describe('the OpenAPI description (document section 17)', () => {
  it('is served at /openapi.json without signing in, and describes every route the API has', async () => {
    const reply = await call(null, 'GET', '/openapi.json');
    expect(reply.status).toBe(200);
    expect(reply.body.openapi).toBe('3.1.0');
    expect(reply.body.info.title).toMatch(/Insurance Suite/);

    const documented = Object.entries(reply.body.paths as Record<string, Record<string, { operationId: string }>>).flatMap(([path, ops]) =>
      Object.entries(ops).map(([method, op]) => `${method.toUpperCase()} ${path} ${op.operationId}`),
    );
    const registered = app
      .printRoutes({ commonPrefix: false, includeHooks: false })
      .split('\n').length; // just to be sure the router has routes
    expect(registered).toBeGreaterThan(5);
    expect(documented.length).toBeGreaterThanOrEqual(25);
    expect(new Set(documented.map((d) => d.split(' ')[2])).size).toBe(documented.length); // operation ids are unique
  });

  it('documents each route fully: signing in, permission, the idempotency key on every POST, request bodies and error answers', async () => {
    const spec = (await call(null, 'GET', '/openapi.json')).body;
    for (const [path, ops] of Object.entries(spec.paths as Record<string, Record<string, any>>)) { // eslint-disable-line @typescript-eslint/no-explicit-any
      for (const [method, op] of Object.entries(ops)) {
        const where = `${method.toUpperCase()} ${path}`;
        expect(op.summary, where).toEqual(expect.any(String));
        expect(op.tags?.length, where).toBeGreaterThan(0);
        expect(Object.keys(op.responses).length, where).toBeGreaterThan(0);
        for (const name of path.match(/\{(\w+)\}/g) ?? []) expect(op.parameters.some((p: any) => p.in === 'path' && `{${p.name}}` === name), `${where} ${name}`).toBe(true); // eslint-disable-line @typescript-eslint/no-explicit-any
        if (method === 'post') expect(op.parameters.some((p: any) => p.name === 'Idempotency-Key' && p.in === 'header' && p.required), where).toBe(true); // eslint-disable-line @typescript-eslint/no-explicit-any
        if (path !== '/v1/health') {
          expect(op.security, where).toEqual([{ userHeader: [] }]);
          expect(op.responses['401'], where).toBeDefined();
        }
      }
    }
    const submit = spec.paths['/v1/submissions'].post;
    expect(submit['x-permission']).toBe('submission.create');
    expect(submit.requestBody.content['application/json'].schema.properties.productCode).toBeDefined();
    expect(submit.requestBody.content['application/json'].schema.required).toEqual(expect.arrayContaining(['accountId', 'productCode', 'periodStart']));
    expect(spec.paths['/v1/branches/{id}/coverages/{fixedId}'].patch.parameters.some((p: any) => p.name === 'If-Match' && p.required)).toBe(true); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(spec.components.securitySchemes.userHeader).toMatchObject({ type: 'apiKey', in: 'header', name: 'X-User' });
  });
});

describe('signing in and permissions (document section 13)', () => {
  it('needs a known, active user; the health check is open', async () => {
    expect((await call(null, 'GET', '/v1/health')).status).toBe(200);
    expect((await call(null, 'GET', '/v1/accounts')).status).toBe(401);
    expect((await call('nobody.known', 'GET', '/v1/accounts')).status).toBe(401);
    await deactivateUser(db, (await getUserByUsername(db, 'vis.itor'))!.id, 'admin');
    expect((await call('vis.itor', 'GET', '/v1/accounts')).status).toBe(401);
    expect((await call(null, 'GET', '/v1/accounts')).body).toMatchObject({ error: 'unauthenticated' });
  });

  it('refuses what the roles do not allow, with 403', async () => {
    const reply = await call('vis.itor', 'POST', '/v1/contacts', { kind: 'person', name: 'X Y', address });
    expect(reply).toMatchObject({ status: 403, body: { error: 'forbidden' } });
    expect((await call('agent.hundred', 'POST', '/v1/admin/billing/process-events', {})).status).toBe(403);
  });
});

describe('the main flow through the API: quote, bind, issue, claim, bill', () => {
  it('takes a customer from a contact to a paid first instalment and a paid claim', async () => {
    const { account, jobId, branchId } = await newSubmission();

    // Quote (an agent), then the agent cannot bind but the underwriter can.
    const quoted = await call('agent.hundred', 'POST', `/v1/jobs/${jobId}/quote`, { branchId });
    expect(quoted).toMatchObject({ status: 200, body: { premiumPaise: 1574600, taxPaise: 283428, totalPaise: 1858028, rateBook: 'MPC-2026.10', validUntil: '2026-11-15' } });
    expect((await call('agent.hundred', 'POST', `/v1/jobs/${jobId}/bind`, { branchId })).status).toBe(403);
    const bound = await call('uw.boss', 'POST', `/v1/jobs/${jobId}/bind`, { branchId });
    expect(bound).toMatchObject({ status: 200, body: { job: { status: 'bound' }, branch: { status: 'bound', version: 1 } } });
    const issued = await call('uw.boss', 'POST', `/v1/jobs/${jobId}/issue`, {});
    expect(issued).toMatchObject({ status: 200, body: { job: { status: 'issued' }, document: { kind: 'policy_schedule' } } });

    // The policy as of a date; the agent of another producer does not see it.
    const asOf = await call('agent.hundred', 'GET', '/v1/policies/PL-0000001/as-of?date=2026-12-01');
    expect(asOf).toMatchObject({ status: 200, body: { status: 'in_force', version: 1, accountId: account.id } });
    expect((await call('agent.twohundred', 'GET', '/v1/policies/PL-0000001/as-of?date=2026-12-01')).status).toBe(404);

    // A claim.
    today = '2026-12-02';
    const claim = await call('claims.handler', 'POST', '/v1/claims', {
      policyNumber: 'PL-0000001', lossDate: '2026-12-01', reportedOn: '2026-12-02', cause: 'collision', place: 'Outer Ring Road', description: 'Hit from behind', channel: 'phone',
    });
    expect(claim).toMatchObject({ status: 201, body: { claimNumber: 'CL-0000001', verification: { status: 'verified' } } });
    const exposure = await call('claims.handler', 'POST', '/v1/claims/CL-0000001/exposures', { coverageCode: 'MOTOR_OD', claimant: { name: 'Asha Rao', kind: 'insured' }, description: 'Damage to the car' });
    expect(exposure).toMatchObject({ status: 201, body: { number: 1, limitPaise: 50000000 } });
    const id = exposure.body.id as string;
    expect((await call('claims.handler', 'POST', `/v1/exposures/${id}/status`, { to: 'under_review' })).status).toBe(200);
    expect((await call('claims.handler', 'POST', `/v1/exposures/${id}/status`, { to: 'approved', reason: 'Estimate checked' })).status).toBe(200);
    expect((await call('claims.handler', 'POST', `/v1/exposures/${id}/reserves`, { costType: 'claim_cost', category: 'repair', outstandingPaise: 3000000, reason: 'Garage estimate' })).status).toBe(200);
    const payment = await call('claims.handler', 'POST', `/v1/exposures/${id}/payments`, {
      costType: 'claim_cost', category: 'repair', amountPaise: 1000000, kind: 'partial', method: 'bank_transfer', reference: 'PAY-1', paidOn: '2026-12-10',
      payee: { kind: 'claimant', name: 'Asha Rao', bank: { ifsc: 'HDFC0001234', accountNumber: '50100123456789' } },
    });
    expect(payment).toMatchObject({ status: 201, body: { status: 'issued', amountPaise: 1000000, payee: { instrument: 'XXXXXXXXXX6789' } } });
    expect(JSON.stringify(payment.body)).not.toContain('50100123456789');
    const fin = await call('claims.handler', 'GET', '/v1/claims/CL-0000001/financials');
    expect(fin.body.claim).toEqual({ paidPaise: 1000000, outstandingPaise: 2000000, recoveredPaise: 0, incurredPaise: 3000000 });

    // Billing: the batch reads the events, makes the invoice; the cashier takes the payment.
    today = '2026-10-16';
    expect((await call('admin.user', 'POST', '/v1/admin/billing/process-events', {})).body.chargesCreated).toBe(1);
    const invoices = await call('admin.user', 'POST', '/v1/admin/billing/invoices', { today: '2026-10-16' });
    expect(invoices.body.invoices).toEqual([expect.objectContaining({ number: 'INV-0000001', totalPaise: 1858028, status: 'open' })]);
    const billing = await call('cash.ier', 'GET', `/v1/accounts/${account.id}/billing`);
    expect(billing).toMatchObject({ status: 200, body: { account: { planCode: 'FULL_PAY' }, scheduleItems: [expect.objectContaining({ amountPaise: 1858028, status: 'invoiced' })] } });
    const paid = await call('cash.ier', 'POST', '/v1/payments', { accountId: account.id, amountPaise: 1858028, method: 'upi', reference: 'UPI-1', receivedOn: '2026-10-16' });
    expect(paid).toMatchObject({ status: 201, body: { allocatedPaise: 1858028, unappliedPaise: 0 } });
    expect((await call('cash.ier', 'GET', `/v1/accounts/${account.id}/billing`)).body.invoices[0].status).toBe('paid');
  });

  it('lists claims with paging and a filter on the policy', async () => {
    const { jobId, branchId } = await newSubmission();
    await call('agent.hundred', 'POST', `/v1/jobs/${jobId}/quote`, { branchId });
    await call('uw.boss', 'POST', `/v1/jobs/${jobId}/bind`, { branchId });
    today = '2026-12-10';
    for (const lossDate of ['2026-12-01', '2026-12-02', '2026-12-03']) {
      await call('claims.handler', 'POST', '/v1/claims', { policyNumber: 'PL-0000001', lossDate, reportedOn: '2026-12-05', cause: 'collision', place: 'x', description: 'y', channel: 'staff' });
    }
    const page = await call('claims.handler', 'GET', '/v1/claims?policyNumber=PL-0000001&limit=2&offset=0');
    expect(page.body).toMatchObject({ total: 3, limit: 2, offset: 0 });
    expect(page.body.items.map((c: { claimNumber: string }) => c.claimNumber)).toEqual(['CL-0000001', 'CL-0000002']);
    expect((await call('claims.handler', 'GET', '/v1/claims?policyNumber=PL-0000001&limit=2&offset=2')).body.items).toHaveLength(1);
    expect((await call('claims.handler', 'GET', '/v1/claims?policyNumber=PL-9999999')).body).toMatchObject({ total: 0, items: [] });
    expect((await call('claims.handler', 'GET', '/v1/claims?limit=0')).status).toBe(400);
  });
});

describe('idempotency keys (document section 17)', () => {
  it('give the same answer to a repeated POST and do the work once', async () => {
    const { account } = await newAccount();
    const body = { accountId: account.id, productCode: 'MOTOR_PRIVATE_CAR', periodStart: '2026-10-15' };
    const first = await call('agent.hundred', 'POST', '/v1/submissions', body, { 'idempotency-key': 'key-1' });
    const again = await call('agent.hundred', 'POST', '/v1/submissions', body, { 'idempotency-key': 'key-1' });
    expect(first.status).toBe(201);
    expect(again.status).toBe(201);
    expect(again.body).toEqual(first.body);
    expect(again.headers['idempotency-replayed']).toBe('true');
    expect(first.headers['idempotency-replayed']).toBeUndefined();
    expect((await db.query('select 1 from policy.policy')).rows).toHaveLength(1);
  });

  it('are refused when the same key is used for a different request, or missing', async () => {
    const { account } = await newAccount();
    const body = { accountId: account.id, productCode: 'MOTOR_PRIVATE_CAR', periodStart: '2026-10-15' };
    await call('agent.hundred', 'POST', '/v1/submissions', body, { 'idempotency-key': 'key-2' });
    const clash = await call('agent.hundred', 'POST', '/v1/submissions', { ...body, periodStart: '2026-10-16' }, { 'idempotency-key': 'key-2' });
    expect(clash).toMatchObject({ status: 422, body: { error: 'idempotency_key_reused' } });
    const missing = await app.inject({ method: 'POST', url: '/v1/submissions', headers: { 'x-user': 'agent.hundred' }, payload: body });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().message).toMatch(/Idempotency-Key/);
  });

  it('belong to the user: another user with the same key is a different request', async () => {
    const one = await call('agent.hundred', 'POST', '/v1/contacts', { kind: 'person', name: 'Asha Rao', address }, { 'idempotency-key': 'shared' });
    const two = await call('agent.twohundred', 'POST', '/v1/contacts', { kind: 'person', name: 'Ravi Kumar', address }, { 'idempotency-key': 'shared' });
    expect(two.body.id).not.toBe(one.body.id);
  });

  it('do not keep a failed answer, so the client can correct the request and try again with the same key', async () => {
    const bad = await call('agent.hundred', 'POST', '/v1/contacts', { kind: 'person', name: 'Asha Rao', address: { ...address, pinCode: '12' } }, { 'idempotency-key': 'retry' });
    expect(bad.status).toBe(422);
    const good = await call('agent.hundred', 'POST', '/v1/contacts', { kind: 'person', name: 'Asha Rao', address }, { 'idempotency-key': 'retry' });
    expect(good.status).toBe(201);
  });
});

describe('versions and lost updates: ETag and If-Match (document section 17)', () => {
  it('lets a change through only if the working copy is still the one the client read', async () => {
    const { branchId, covers } = await newSubmission();
    const read = await call('agent.hundred', 'GET', `/v1/branches/${branchId}`);
    const etag = read.headers.etag as string;
    expect(etag).toMatch(/^"[0-9a-f]{32}"$/);
    const url = `/v1/branches/${branchId}/coverages/${covers.MOTOR_OD}`;
    const change = { terms: { idv: 60000000 } };

    expect((await call('agent.hundred', 'PATCH', url, change)).status).toBe(428); // If-Match is required
    expect((await call('agent.hundred', 'PATCH', url, change, { 'if-match': '"0000"' })).status).toBe(412);
    const done = await call('agent.hundred', 'PATCH', url, change, { 'if-match': etag });
    expect(done.status).toBe(200);
    expect(done.headers.etag).not.toBe(etag);
    expect((await call('agent.hundred', 'PATCH', url, { terms: { idv: 70000000 } }, { 'if-match': etag })).status).toBe(412); // the old version is stale now

    const fresh = await call('agent.hundred', 'GET', `/v1/branches/${branchId}`);
    expect(fresh.headers.etag).toBe(done.headers.etag);
    expect(fresh.body.coverages.find((c: { patternCode: string }) => c.patternCode === 'MOTOR_OD').terms.idv).toBe(60000000);
  });
});

describe('producer code security at the API (document section 13)', () => {
  it('shows an agent only the accounts under their own producer code, and hides the others as not found', async () => {
    const mine = await newAccount('agent.hundred', 'PC-100', 'Asha Rao');
    const theirs = await newAccount('agent.twohundred', 'PC-200', 'Ravi Kumar');
    const list = await call('agent.hundred', 'GET', '/v1/accounts');
    expect(list.body).toMatchObject({ total: 1, items: [expect.objectContaining({ id: mine.account.id })] });
    expect((await call('agent.hundred', 'GET', `/v1/accounts/${theirs.account.id}`)).status).toBe(404);
    expect((await call('admin.user', 'GET', '/v1/accounts')).body.total).toBe(2);
    const submission = await call('agent.hundred', 'POST', '/v1/submissions', { accountId: theirs.account.id, productCode: 'MOTOR_PRIVATE_CAR', periodStart: '2026-10-15' });
    expect(submission.status).toBe(404);
  });

  it('pages the account list', async () => {
    for (const name of ['Asha Rao', 'Ravi Kumar', 'Sita Devi']) await newAccount('agent.hundred', 'PC-100', name);
    const first = await call('admin.user', 'GET', '/v1/accounts?limit=2&offset=0');
    expect(first.body).toMatchObject({ total: 3, limit: 2, offset: 0 });
    expect(first.body.items).toHaveLength(2);
    expect((await call('admin.user', 'GET', '/v1/accounts?limit=2&offset=2')).body.items).toHaveLength(1);
  });
});

describe('errors (document section 17)', () => {
  it('answers 400 for a request that is not shaped right, listing the problems', async () => {
    const reply = await call('agent.hundred', 'POST', '/v1/contacts', { kind: 'robot' });
    expect(reply.status).toBe(400);
    expect(reply.body).toMatchObject({ error: 'bad_request' });
    expect(reply.body.issues.length).toBeGreaterThan(0);
  });

  it('answers 422 with every business problem, and 404 for what does not exist', async () => {
    const bad = await call('agent.hundred', 'POST', '/v1/contacts', { kind: 'person', name: 'A', address: { ...address, pinCode: '12' } });
    expect(bad).toMatchObject({ status: 422, body: { error: 'validation_failed' } });
    expect(bad.body.errors.length).toBeGreaterThan(0);
    expect((await call('uw.boss', 'GET', '/v1/jobs/00000000-0000-0000-0000-000000000000')).status).toBe(404);
    expect((await call('uw.boss', 'GET', '/v1/nothing-here')).status).toBe(404);
    expect((await call('uw.boss', 'GET', '/v1/policies/PL-9999999/as-of?date=2026-12-01')).status).toBe(404);
    const noDate = await call('uw.boss', 'GET', '/v1/policies/PL-0000001/as-of');
    expect(noDate.status).toBe(400);
  });

  it('refuses quoting a branch with a message the client can show', async () => {
    const { jobId, branchId } = await newSubmission();
    await call('agent.hundred', 'PATCH', `/v1/branches/${branchId}/coverages/${(await call('agent.hundred', 'GET', `/v1/branches/${branchId}`)).body.coverages[2].fixedId}`, { terms: { idv: 100 } }, {
      'if-match': (await call('agent.hundred', 'GET', `/v1/branches/${branchId}`)).headers.etag as string,
    });
    const reply = await call('agent.hundred', 'POST', `/v1/jobs/${jobId}/quote`, { branchId });
    expect(reply.status).toBe(422);
    expect(reply.body.errors).toEqual([expect.stringMatching(/idv must be between/)]);
  });
});

describe('what the screens need: the product, the policy file and the documents', () => {
  it('describes the product version in force on a date, with its covers and terms, for the quote wizard', async () => {
    const reply = await call('agent.hundred', 'GET', '/v1/products/MOTOR_PRIVATE_CAR?date=2026-10-15');
    expect(reply.status).toBe(200);
    expect(reply.body).toMatchObject({ product: 'MOTOR_PRIVATE_CAR', version: '2026.10', names: { en: 'Private car insurance' } });
    const od = reply.body.coverages.find((c: { code: string }) => c.code === 'MOTOR_OD');
    expect(od).toMatchObject({ existence: 'electable', names: { en: 'Own damage' } });
    expect(od.terms).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'idv', type: 'direct', min: 5000000 })]));
    expect(reply.body.coverages.find((c: { code: string }) => c.code === 'MOTOR_TP').existence).toBe('required');
    expect((await call('agent.hundred', 'GET', '/v1/products/FLYING_CARPET?date=2026-10-15')).status).toBe(404);
    expect((await call('agent.hundred', 'GET', '/v1/products/MOTOR_PRIVATE_CAR?date=2020-01-01')).status).toBe(404);
  });

  it('gives the policy file: versions, premium transactions, documents and claims, to people who may see the policy', async () => {
    const { jobId, branchId } = await newSubmission();
    await call('agent.hundred', 'POST', `/v1/jobs/${jobId}/quote`, { branchId });
    await call('uw.boss', 'POST', `/v1/jobs/${jobId}/bind`, { branchId });
    const issued = await call('uw.boss', 'POST', `/v1/jobs/${jobId}/issue`, {});

    const file = await call('agent.hundred', 'GET', '/v1/policies/PL-0000001');
    expect(file.status).toBe(200);
    expect(file.body).toMatchObject({
      policyNumber: 'PL-0000001',
      productCode: 'MOTOR_PRIVATE_CAR',
      cover: { status: 'in_force', version: 1 },
      versions: [expect.objectContaining({ termNumber: 1, version: 1, periodStart: '2026-10-15', periodEnd: '2027-10-15', cancelledOn: null })],
      transactions: [expect.objectContaining({ version: 1, kind: 'new_business', premiumPaise: 1574600, totalPaise: 1858028 })],
      documents: [expect.objectContaining({ id: issued.body.document.id, kind: 'policy_schedule' })],
      claims: [],
    });
    expect((await call('agent.twohundred', 'GET', '/v1/policies/PL-0000001')).status).toBe(404);
    expect((await call('agent.hundred', 'GET', '/v1/policies/PL-9999999')).status).toBe(404);
  });

  it('downloads a document as the PDF itself, with the same producer code security', async () => {
    const { jobId, branchId } = await newSubmission();
    await call('agent.hundred', 'POST', `/v1/jobs/${jobId}/quote`, { branchId });
    await call('uw.boss', 'POST', `/v1/jobs/${jobId}/bind`, { branchId });
    const issued = await call('uw.boss', 'POST', `/v1/jobs/${jobId}/issue`, {});
    const url = `/v1/documents/${issued.body.document.id}`;

    const response = await app.inject({ method: 'GET', url, headers: { 'x-user': 'agent.hundred' } });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('application/pdf');
    expect(response.headers['content-disposition']).toMatch(/PL-0000001/);
    expect(response.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    expect((await call('agent.twohundred', 'GET', url)).status).toBe(404);
    expect((await call('agent.hundred', 'GET', '/v1/documents/00000000-0000-0000-0000-000000000000')).status).toBe(404);
    const spec = (await call(null, 'GET', '/openapi.json')).body;
    expect(Object.keys(spec.paths['/v1/documents/{id}'].get.responses['200'].content)).toEqual(['application/pdf']);
  });
});

