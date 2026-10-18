// Support for billing tests only: sets up a customer with a golden policy, so each test starts from the same place.
// It uses the other modules only through their public doors, like the real application.
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { createContact } from '../contacts/index.js';
import { createProducerCode, createProducerOrganisation } from '../platform/index.js';
import {
  addCoverable,
  addCoverage,
  bindJob,
  createAccount,
  createQuoter,
  issueJob,
  loadCancellationRules,
  loadProductCatalogue,
  loadRateBooks,
  loadRenewalRules,
  quoteBranch,
  startSubmission,
} from '../policy/index.js';
import type { Account } from '../policy/index.js';
import { loadBillingConfig } from './config.js';

const configFolder = fileURLToPath(new URL('../../config/', import.meta.url));
export const catalogue = loadProductCatalogue(`${configFolder}products/`);
export const billingConfig = loadBillingConfig(`${configFolder}billing/`);
export const quoteDeps = { catalogue, quoter: createQuoter(loadRateBooks(`${configFolder}ratebooks/`, catalogue)) };
export const bindDeps = { catalogue };
export const cancelDeps = { catalogue, cancellation: loadCancellationRules(`${configFolder}cancellation/`, catalogue) };
export const renewDeps = { catalogue, renewal: loadRenewalRules(`${configFolder}renewal/`, catalogue) };
export const START = '2026-10-15';

// A producer, a person and an account. Returns the account.
export async function createCustomer(db: PGlite, name = 'Asha Rao'): Promise<Account> {
  const acme = await createProducerOrganisation(db, { name: 'Acme Insurance Agency' }, 'admin');
  await createProducerCode(db, { code: 'PC-100', organisationId: acme.id }, 'admin');
  const address = { line1: '12 Test Street', city: 'Hyderabad', state: 'Telangana', pinCode: '500081' };
  const contact = await createContact(db, { kind: 'person', name, address }, 'admin');
  return createAccount(db, { namedInsuredContactId: contact.id, producerCode: 'PC-100' }, 'agent.one');
}

// The golden policy (premium 1,574,600 + GST 283,428 = 1,858,028 paise), bound and issued, for an account.
export async function issueGoldenPolicy(db: PGlite, account: Account) {
  const started = await startSubmission(db, catalogue, { accountId: account.id, productCode: 'MOTOR_PRIVATE_CAR', periodStart: START }, 'agent.one');
  const car = await addCoverable(
    db,
    started.branch.id,
    { kind: 'Vehicle', attributes: { make: 'Maruti', model: 'Swift', year: 2023, registrationNumber: 'TS09XX0001', engineCc: 1197, claimFreeYears: 2 } },
    'agent.one',
  );
  for (const [code, terms] of [['MOTOR_TP', {}], ['PA_OWNER_DRIVER', {}], ['MOTOR_OD', { idv: 50000000 }]] as const) {
    await addCoverage(db, started.branch.id, { coverableFixedId: car.fixedId, patternCode: code, terms }, 'agent.one');
  }
  await quoteBranch(db, quoteDeps, started.branch.id, 'agent.one', { today: '2026-10-16' });
  await bindJob(db, bindDeps, started.job.id, { branchId: started.branch.id }, 'agent.one', { today: '2026-10-16' });
  await issueJob(db, bindDeps, started.job.id, 'agent.one', { today: '2026-10-16' });
  return { ...started, car };
}
