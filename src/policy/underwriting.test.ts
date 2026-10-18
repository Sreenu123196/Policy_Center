import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Database } from '../platform/index.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createContact } from '../contacts/index.js';
import {
  assignRole,
  createProducerCode,
  createProducerOrganisation,
  createRole,
  createUser,
  getUserByUsername,
  listAuditEntries,
  PermissionError,
  ValidationError,
} from '../platform/index.js';
import { createTestDatabase, resetDatabase } from '../testing/database.js';
import { createAccount } from './account-repository.js';
import type { Account } from './account.js';
import { addCoverable, addCoverage, getBranch } from './policy-repository.js';
import { loadProductCatalogue } from './product-catalogue.js';
import type { Quoter } from './quote.js';
import { addQuoteOption, quoteBranch, startSubmission } from './submission.js';
import { checkUnderwriting, decideIssue, evaluateRules, listIssues, listReferrals, requestApproval } from './underwriting.js';
import { loadUnderwritingRules } from './uw-rules.js';

const configFolder = fileURLToPath(new URL('../../config/', import.meta.url));
const catalogue = loadProductCatalogue(`${configFolder}products/`);
const rules = loadUnderwritingRules(`${configFolder}underwriting/`, catalogue);
const PRODUCT = 'MOTOR_PRIVATE_CAR';
const START = '2026-10-15';
const TODAY = '2026-10-16';

const testQuoter: Quoter = () => ({ premiumPaise: 1000000, taxPaise: 180000, rateBook: 'TEST-PRICE', worksheet: [] });
const deps = { catalogue, quoter: testQuoter, underwriting: { rules } };
const uw = { rules };

let db: Database;
let person: Account;

beforeAll(async () => {
  db = await createTestDatabase();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await resetDatabase(db);
  const acme = await createProducerOrganisation(db, { name: 'Acme Insurance Agency' }, 'admin');
  await createProducerCode(db, { code: 'PC-100', organisationId: acme.id }, 'admin');
  const address = { line1: '12 Test Street', city: 'Hyderabad', state: 'Telangana', pinCode: '500081' };
  const asha = await createContact(db, { kind: 'person', name: 'Asha Rao', address }, 'admin');
  person = await createAccount(db, { namedInsuredContactId: asha.id, producerCode: 'PC-100' }, 'agent.one');

  await createRole(db, { code: 'junior_uw', name: 'Junior underwriter', permissions: ['uw.approve'] }, 'admin');
  await createRole(db, { code: 'senior_uw', name: 'Senior underwriter', permissions: ['uw.approve'] }, 'admin');
  await createRole(db, { code: 'agent', name: 'Agent', permissions: ['submission.create'] }, 'admin');
  for (const [username, role] of [['junior.uw', 'junior_uw'], ['senior.uw', 'senior_uw'], ['agent.one', 'agent']] as const) {
    await createUser(db, { username, displayName: username }, 'admin');
    const user = await getUserByUsername(db, username);
    await assignRole(db, user!.id, role, 'admin');
  }
});

const errorsOf = async (promise: Promise<unknown>): Promise<string[]> => {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ValidationError);
  return (error as ValidationError).errors;
};

// A branch ready to quote. Options set the facts the underwriting rules look at.
async function branchWith(options: { idv?: number; engineCc?: number; year?: number; driverBirth?: string } = {}) {
  const started = await startSubmission(db, catalogue, { accountId: person.id, productCode: PRODUCT, periodStart: START }, 'agent.one');
  const car = await addCoverable(
    db,
    started.branch.id,
    { kind: 'Vehicle', attributes: { make: 'Maruti', model: 'Swift', year: options.year ?? 2023, engineCc: options.engineCc ?? 1197 } },
    'agent.one',
  );
  for (const [code, terms] of [['MOTOR_TP', {}], ['PA_OWNER_DRIVER', {}], ['MOTOR_OD', { idv: options.idv ?? 50000000 }]] as const) {
    await addCoverage(db, started.branch.id, { coverableFixedId: car.fixedId, patternCode: code, terms }, 'agent.one');
  }
  if (options.driverBirth !== undefined) {
    await addCoverable(db, started.branch.id, { kind: 'Driver', attributes: { name: 'Test Driver', dateOfBirth: options.driverBirth } }, 'agent.one');
  }
  return started;
}

// Stands in for "an edit": changes the insured value of a draft branch directly (editing functions arrive with policy change, step E1).
const setIdv = (branchId: string, idv: number) =>
  db.query(`update policy.coverage set terms = jsonb_set(terms, '{idv}', to_jsonb($2::bigint)) where branch_id = $1 and pattern_code = 'MOTOR_OD'`, [branchId, idv]);
const setDriverBirth = (branchId: string, dob: string) =>
  db.query(`update policy.coverable set attributes = jsonb_set(attributes, '{dateOfBirth}', to_jsonb($2::text)) where branch_id = $1 and kind = 'Driver'`, [branchId, dob]);

const HIGH_IDV = 450000000; // Rs 45,00,000: above the Rs 30,00,000 rule, and above a junior underwriter's limit of Rs 40,00,000

describe('loading underwriting rules (document section 10)', () => {
  it('loads the real rules for each product version', () => {
    const current = rules.forVersion(PRODUCT, '2026.10');
    expect(current?.issue_types.map((t) => t.code)).toEqual(['HIGH_IDV', 'DRIVER_AGE', 'VEHICLE_AGE', 'BIG_ENGINE']);
    expect(rules.forVersion(PRODUCT, '2099.01')).toBeNull();
  });

  describe('checks the file and reports every problem together', () => {
    const base = {
      product: PRODUCT,
      version: '2026.10',
      issue_types: [{ code: 'HIGH_IDV', description: 'High value', blocks: 'quote', compare: 'max' }],
      rules: [{ code: 'RULE_ONE', issue_type: 'HIGH_IDV', check_at: 'quote', when: 'idv > 5', value: 'idv', message: 'Too high' }],
      authority_profiles: [{ code: 'JUNIOR', roles: ['junior_uw'], users: [], grants: [{ issue_type: 'HIGH_IDV', limit: 10 }] }],
    };
    const load = (book: unknown, fileName = 'motor_private_car-2026.10.json') => {
      const folder = mkdtempSync(join(tmpdir(), 'uwrules-'));
      writeFileSync(join(folder, fileName), JSON.stringify(book));
      return () => loadUnderwritingRules(folder, catalogue);
    };
    const problems = (run: () => unknown): string[] => {
      try {
        run();
      } catch (error) {
        expect(error).toBeInstanceOf(ValidationError);
        return (error as ValidationError).errors;
      }
      throw new Error('expected the rules to be refused');
    };

    it('accepts a small valid file', () => {
      expect(load(base)()).toBeDefined();
    });

    it('refuses a rule for an unknown issue type, a bad expression, and a grant for an unknown issue type', () => {
      const bad = {
        ...base,
        rules: [
          { code: 'RULE_ONE', issue_type: 'NOPE', check_at: 'quote', when: 'idv > 5', value: 'idv', message: 'x' },
          { code: 'RULE_TWO', issue_type: 'HIGH_IDV', check_at: 'quote', when: 'idv >', value: 'idv', message: 'x' },
        ],
        authority_profiles: [{ code: 'JUNIOR', roles: [], users: ['a.user'], grants: [{ issue_type: 'GHOST' }] }],
      };
      expect(problems(load(bad))).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/RULE_ONE.*issue type NOPE/),
          expect.stringMatching(/RULE_TWO.*not a valid expression/),
          expect.stringMatching(/JUNIOR.*issue type GHOST/),
        ]),
      );
    });

    it('refuses a rule code used twice, a profile nobody can hold, and a wrong file name', () => {
      const twice = { ...base, rules: [...base.rules, ...base.rules] };
      expect(problems(load(twice))).toEqual(expect.arrayContaining([expect.stringMatching(/RULE_ONE.*more than once/)]));
      const nobody = { ...base, authority_profiles: [{ code: 'JUNIOR', roles: [], users: [], grants: [] }] };
      expect(problems(load(nobody))).toEqual(expect.arrayContaining([expect.stringMatching(/JUNIOR.*no role and no user/)]));
      expect(problems(load(base, 'rules.json'))).toEqual([expect.stringMatching(/should be named motor_private_car-2026.10.json/)]);
    });
  });
});

describe('rules raise issues at fixed points (document section 10)', () => {
  it('raises nothing for an ordinary risk', async () => {
    const { branch } = await branchWith();
    expect(await evaluateRules(db, uw, branch.id, 'issuance', 'agent.one', { today: TODAY })).toEqual([]);
  });

  it('raises an issue with the value that caused it, and does not repeat it when the rules run again', async () => {
    const { branch } = await branchWith({ idv: HIGH_IDV });
    const first = await evaluateRules(db, uw, branch.id, 'quote', 'agent.one', { today: TODAY });
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ ruleCode: 'UW_HIGH_IDV', issueType: 'HIGH_IDV', blocks: 'quote', value: HIGH_IDV, status: 'open', decision: null });
    const second = await evaluateRules(db, uw, branch.id, 'quote', 'agent.one', { today: TODAY });
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
  });

  it('blocks the quote: the branch stays a draft, but the issue is saved so an underwriter can act', async () => {
    const { branch } = await branchWith({ idv: HIGH_IDV });
    expect(await errorsOf(quoteBranch(db, deps, branch.id, 'agent.one', { today: TODAY }))).toEqual([expect.stringMatching(/HIGH_IDV.*approval/i)]);
    expect((await getBranch(db, branch.id))?.status).toBe('draft');
    expect((await listIssues(db, branch.id)).map((i) => i.issueType)).toEqual(['HIGH_IDV']);
  });

  it('does not block when the product has no underwriting set up (the earlier steps still work)', async () => {
    const { branch } = await branchWith({ idv: HIGH_IDV });
    await expect(quoteBranch(db, { catalogue, quoter: testQuoter }, branch.id, 'agent.one', { today: TODAY })).resolves.toBeDefined();
  });

  it('blocks only the point it names: a driver-age issue lets the quote through but stops the bind', async () => {
    const { branch } = await branchWith({ driverBirth: '2007-03-01' }); // 19 years old at the start date
    await expect(quoteBranch(db, deps, branch.id, 'agent.one', { today: TODAY })).resolves.toBeDefined();
    expect((await listIssues(db, branch.id))[0]).toMatchObject({ issueType: 'DRIVER_AGE', blocks: 'bind', value: 19 });

    expect(await errorsOf(checkUnderwriting(db, uw, branch.id, 'bind', 'agent.one', { today: TODAY }))).toEqual([expect.stringMatching(/DRIVER_AGE/)]);
    expect(await errorsOf(checkUnderwriting(db, uw, branch.id, 'issuance', 'agent.one', { today: TODAY }))).toEqual([expect.stringMatching(/DRIVER_AGE/)]);
  });

  it('records a non-blocking issue without stopping anything', async () => {
    const { branch } = await branchWith({ engineCc: 3500 });
    await expect(quoteBranch(db, deps, branch.id, 'agent.one', { today: TODAY })).resolves.toBeDefined();
    await expect(checkUnderwriting(db, uw, branch.id, 'issuance', 'agent.one', { today: TODAY })).resolves.toHaveLength(1);
    expect((await listIssues(db, branch.id))[0]).toMatchObject({ issueType: 'BIG_ENGINE', blocks: 'none', status: 'open' });
  });

  it('clears an issue when the risk no longer triggers the rule', async () => {
    const { branch } = await branchWith({ idv: HIGH_IDV });
    await evaluateRules(db, uw, branch.id, 'quote', 'agent.one', { today: TODAY });
    await setIdv(branch.id, 50000000);
    const issues = await evaluateRules(db, uw, branch.id, 'quote', 'agent.one', { today: TODAY });
    expect(issues[0]?.status).toBe('cleared');
    await expect(quoteBranch(db, deps, branch.id, 'agent.one', { today: TODAY })).resolves.toBeDefined();
  });

  it('copies of a branch are checked on their own', async () => {
    const { job, branch } = await branchWith({ idv: HIGH_IDV });
    const copy = await addQuoteOption(db, job.id, { copyFrom: branch.id }, 'agent.one');
    await evaluateRules(db, uw, copy.id, 'quote', 'agent.one', { today: TODAY });
    expect(await listIssues(db, branch.id)).toEqual([]);
    expect(await listIssues(db, copy.id)).toHaveLength(1);
  });
});

describe('referral and authority (document section 10)', () => {
  async function raised(options: Parameters<typeof branchWith>[0] = { idv: HIGH_IDV }) {
    const { branch } = await branchWith(options);
    const [issue] = await evaluateRules(db, uw, branch.id, 'issuance', 'agent.one', { today: TODAY });
    if (!issue) throw new Error('test setup: no issue was raised');
    return { branch, issue };
  }

  it('"Request approval" puts the full context in the underwriter queue, and the issue becomes referred', async () => {
    const { branch, issue } = await raised();
    const referred = await requestApproval(db, issue.id, 'agent.one', 'Customer is a long-standing client');
    expect(referred.status).toBe('referred');

    const queue = await listReferrals(db);
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({
      issueId: issue.id,
      requestedBy: 'agent.one',
      note: 'Customer is a long-standing client',
      status: 'open',
      context: { branchId: branch.id, issueType: 'HIGH_IDV', value: HIGH_IDV, policyNumber: 'PL-0000001', jobNumber: 'J-0000001' },
    });
    expect(await errorsOf(requestApproval(db, issue.id, 'agent.one'))).toEqual([expect.stringMatching(/already.*referred/i)]);
  });

  it('lets a senior underwriter approve, keeping who decided and why, and the referral closes', async () => {
    const { branch, issue } = await raised();
    await requestApproval(db, issue.id, 'agent.one');
    const approved = await decideIssue(db, uw, issue.id, { decision: 'approved', reason: 'Good claims record' }, 'senior.uw', { today: TODAY });

    expect(approved.status).toBe('approved');
    expect(approved.decision).toMatchObject({ decision: 'approved', decidedBy: 'senior.uw', reason: 'Good claims record', limit: HIGH_IDV, validUntil: '2027-01-14' });
    expect(await listReferrals(db)).toEqual([]);
    await expect(quoteBranch(db, deps, branch.id, 'agent.one', { today: TODAY })).resolves.toBeDefined();

    const entries = await listAuditEntries(db, { entityType: 'uw_issue', entityId: issue.id });
    expect(entries.map((e) => e.action)).toEqual(['uw.issue_raised', 'uw.referred', 'uw.decision']);
    expect(entries.at(-1)).toMatchObject({ actor: 'senior.uw', reason: 'Good claims record' });
  });

  it('refuses a junior who is above their limit, and anyone with no authority profile', async () => {
    const { issue } = await raised(); // Rs 45,00,000; the junior limit is Rs 40,00,000
    await expect(decideIssue(db, uw, issue.id, { decision: 'approved', reason: 'ok' }, 'junior.uw', { today: TODAY })).rejects.toBeInstanceOf(PermissionError);
    await expect(decideIssue(db, uw, issue.id, { decision: 'approved', reason: 'ok' }, 'agent.one', { today: TODAY })).rejects.toBeInstanceOf(PermissionError);
    await expect(decideIssue(db, uw, issue.id, { decision: 'approved', reason: 'ok' }, 'nobody.known', { today: TODAY })).rejects.toBeInstanceOf(PermissionError);
    expect((await listIssues(db, (await db.query<{ branch_id: string }>('select branch_id from policy.uw_issue')).rows[0]!.branch_id))[0]?.status).toBe('open');
  });

  it('lets the junior approve inside their limit, but not an approval ceiling above their limit', async () => {
    const { issue } = await raised({ idv: 350000000 }); // Rs 35,00,000
    await expect(decideIssue(db, uw, issue.id, { decision: 'approved', reason: 'ok', limit: 450000000 }, 'junior.uw', { today: TODAY })).rejects.toBeInstanceOf(PermissionError);
    const approved = await decideIssue(db, uw, issue.id, { decision: 'approved', reason: 'ok', limit: 400000000 }, 'junior.uw', { today: TODAY });
    expect(approved.decision).toMatchObject({ limit: 400000000, decidedBy: 'junior.uw' });
  });

  it('needs a reason; approval with conditions needs the conditions; an approval ceiling must cover the value', async () => {
    const { issue } = await raised({ idv: 350000000 });
    expect(await errorsOf(decideIssue(db, uw, issue.id, { decision: 'approved', reason: '  ' }, 'senior.uw', { today: TODAY }))).toEqual([expect.stringMatching(/reason/i)]);
    expect(await errorsOf(decideIssue(db, uw, issue.id, { decision: 'approved_with_conditions', reason: 'ok' }, 'senior.uw', { today: TODAY }))).toEqual([expect.stringMatching(/conditions/i)]);
    expect(await errorsOf(decideIssue(db, uw, issue.id, { decision: 'approved', reason: 'ok', limit: 300000000 }, 'senior.uw', { today: TODAY }))).toEqual([expect.stringMatching(/ceiling.*cover/i)]);

    const done = await decideIssue(db, uw, issue.id, { decision: 'approved_with_conditions', reason: 'ok', conditions: 'Garage-kept vehicle only', validUntil: '2026-12-31' }, 'senior.uw', { today: TODAY });
    expect(done).toMatchObject({ status: 'approved', decision: { conditions: 'Garage-kept vehicle only', validUntil: '2026-12-31' } });
  });

  it('keeps a rejection as a blocking issue, which can be referred again', async () => {
    const { branch, issue } = await raised();
    const rejected = await decideIssue(db, uw, issue.id, { decision: 'rejected', reason: 'Outside appetite' }, 'junior.uw', { today: TODAY }); // rejecting needs a grant, not a limit
    expect(rejected.status).toBe('rejected');
    expect(await errorsOf(quoteBranch(db, deps, branch.id, 'agent.one', { today: TODAY }))).toEqual([expect.stringMatching(/HIGH_IDV/)]);
    expect((await requestApproval(db, issue.id, 'agent.one', 'New information')).status).toBe('referred');
  });

  it('refuses to decide an issue that is already decided or cleared', async () => {
    const { issue } = await raised({ idv: 350000000 });
    await decideIssue(db, uw, issue.id, { decision: 'approved', reason: 'ok' }, 'senior.uw', { today: TODAY });
    expect(await errorsOf(decideIssue(db, uw, issue.id, { decision: 'approved', reason: 'again' }, 'senior.uw', { today: TODAY }))).toEqual([expect.stringMatching(/only an open or referred issue/i)]);
  });
});

describe('re-checking after edits (document section 10)', () => {
  it('keeps an approval while the new value stays inside what was approved, and reopens the issue when it does not', async () => {
    const { branch } = await branchWith({ idv: HIGH_IDV });
    const [issue] = await evaluateRules(db, uw, branch.id, 'quote', 'agent.one', { today: TODAY });
    await decideIssue(db, uw, issue!.id, { decision: 'approved', reason: 'ok' }, 'senior.uw', { today: TODAY }); // approved up to Rs 45,00,000

    await setIdv(branch.id, 420000000);
    expect((await evaluateRules(db, uw, branch.id, 'quote', 'agent.one', { today: TODAY }))[0]).toMatchObject({ status: 'approved', value: 420000000 });

    await setIdv(branch.id, 480000000);
    const reopened = (await evaluateRules(db, uw, branch.id, 'quote', 'agent.one', { today: TODAY }))[0];
    expect(reopened).toMatchObject({ status: 'open', value: 480000000 });
    expect(reopened?.decision).toMatchObject({ decidedBy: 'senior.uw' }); // the earlier decision stays as history

    const entries = await listAuditEntries(db, { entityType: 'uw_issue', entityId: issue!.id });
    expect(entries.map((e) => e.action)).toContain('uw.reopened');
  });

  it('compares in the right direction: a "minimum" issue such as driver age is covered by an older driver, not a younger one', async () => {
    const { branch } = await branchWith({ driverBirth: '2007-03-01' }); // 19
    const [issue] = await evaluateRules(db, uw, branch.id, 'bind', 'agent.one', { today: TODAY });
    await decideIssue(db, uw, issue!.id, { decision: 'approved', reason: 'ok' }, 'senior.uw', { today: TODAY }); // approved down to age 19

    await setDriverBirth(branch.id, '2006-03-01'); // 20: still inside what was approved
    expect((await evaluateRules(db, uw, branch.id, 'bind', 'agent.one', { today: TODAY }))[0]?.status).toBe('approved');

    await setDriverBirth(branch.id, '2008-03-01'); // 18: younger than approved
    expect((await evaluateRules(db, uw, branch.id, 'bind', 'agent.one', { today: TODAY }))[0]?.status).toBe('open');
  });

  it('lets an approval run out: after its last day the issue reopens', async () => {
    const { branch } = await branchWith({ idv: HIGH_IDV });
    const [issue] = await evaluateRules(db, uw, branch.id, 'quote', 'agent.one', { today: TODAY });
    await decideIssue(db, uw, issue!.id, { decision: 'approved', reason: 'ok', validUntil: '2026-11-01' }, 'senior.uw', { today: TODAY });

    expect((await evaluateRules(db, uw, branch.id, 'quote', 'agent.one', { today: '2026-11-01' }))[0]?.status).toBe('approved'); // the last day still counts
    expect((await evaluateRules(db, uw, branch.id, 'quote', 'agent.one', { today: '2026-11-02' }))[0]?.status).toBe('open');
  });
});
