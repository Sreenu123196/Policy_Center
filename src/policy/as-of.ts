import type { Database } from '../platform/index.js';
import { isRealDate, ValidationError } from '../platform/index.js';
import { getBranchAsOf } from './policy-repository.js';
import { formatDate } from './schedule.js';

// The policy as it was on a date (document section 15). Claims asks this to know whether the policy was in force on the
// loss date, which vehicle it covered, which covers and which deductibles. It uses effective dating: the answer comes
// from the newest bound version of the term that contains the date, read as of that date. Versions that are not bound
// (open jobs) never count. This is Policy's public answer; Claims never reads Policy's tables.

export type NotInForceReason = 'outside_term' | 'cancelled' | 'gap_in_cover';

export interface PolicyAsOf {
  policyNumber: string;
  policyId: string;
  accountId: string;
  namedInsuredContactId: string | null;
  productCode: string;
  date: string;
  status: 'in_force' | 'not_in_force';
  reason: NotInForceReason | null;
  message: string;
  termNumber: number | null;
  version: number | null;
  productVersion: string | null;
  vehicles: { fixedId: string; make: string | null; model: string | null; year: number | null; registrationNumber: string | null }[];
  coverages: { fixedId: string; patternCode: string; terms: Record<string, number | string> }[];
}

const textOrNull = (value: unknown): string | null => (typeof value === 'string' ? value : null);

export async function getPolicyAsOf(db: Database, policyNumber: string, date: string): Promise<PolicyAsOf | null> {
  if (!isRealDate(date)) throw new ValidationError(['The date is not a real date (write it as yyyy-mm-dd)']);
  const policy = (
    await db.query<{ id: string; policy_number: string; account_id: string; product_code: string }>(
      'select id, policy_number, account_id, product_code from policy.policy where policy_number = $1',
      [policyNumber],
    )
  ).rows[0];
  if (!policy) return null;

  const insured = (await db.query<{ contact_id: string }>("select contact_id from policy.account_contact where account_id = $1 and role = 'named_insured'", [policy.account_id])).rows[0];
  const base = {
    policyNumber: policy.policy_number,
    policyId: policy.id,
    accountId: policy.account_id,
    namedInsuredContactId: insured?.contact_id ?? null,
    productCode: policy.product_code,
    date,
  };
  const empty = { termNumber: null, version: null, productVersion: null, vehicles: [], coverages: [] };

  // The newest bound version of the term that contains the date.
  const version = (
    await db.query<{ id: string; term_number: number; version: number; product_version: string; cancelled_on: string | null }>(
      `select id, term_number, version, product_version, to_char(cancelled_on, 'YYYY-MM-DD') as cancelled_on
         from policy.policy_period where policy_id = $1 and status = 'bound' and period_start <= $2::date and $2::date < period_end order by version desc limit 1`,
      [policy.id, date],
    )
  ).rows[0];
  if (!version) {
    return { ...base, ...empty, status: 'not_in_force', reason: 'outside_term', message: `No policy term covers ${formatDate(date)}` };
  }

  const snapshot = await getBranchAsOf(db, version.id, date);
  const known = { termNumber: version.term_number, version: version.version, productVersion: version.product_version };
  if (snapshot === null || snapshot.coverables.length === 0) {
    const cancelled = version.cancelled_on !== null && version.cancelled_on <= date;
    return {
      ...base,
      ...empty,
      ...known,
      status: 'not_in_force',
      reason: cancelled ? 'cancelled' : 'gap_in_cover',
      message: cancelled ? `The policy was cancelled from ${formatDate(version.cancelled_on as string)}` : `There was a gap in cover on ${formatDate(date)}`,
    };
  }
  return {
    ...base,
    ...known,
    status: 'in_force',
    reason: null,
    message: `The policy was in force on ${formatDate(date)}`,
    vehicles: snapshot.coverables
      .filter((c) => c.kind === 'Vehicle')
      .map((c) => ({
        fixedId: c.fixedId,
        make: textOrNull(c.attributes.make),
        model: textOrNull(c.attributes.model),
        year: typeof c.attributes.year === 'number' ? c.attributes.year : null,
        registrationNumber: textOrNull(c.attributes.registrationNumber),
      })),
    coverages: snapshot.coverages.map((c) => ({ fixedId: c.fixedId, patternCode: c.patternCode, terms: c.terms })),
  };
}

const normalise = (registration: string): string => registration.replace(/\s+/g, '').toUpperCase();

// The policies that were in force on a date for a vehicle with this registration number (a customer on the phone may
// know the car's number but not the policy's). Spaces and capitals do not matter.
export async function findPolicyNumbersByRegistration(db: Database, registrationNumber: string, date: string): Promise<string[]> {
  const wanted = normalise(registrationNumber);
  if (wanted === '' || !isRealDate(date)) return [];
  const candidates = await db.query<{ policy_number: string }>(
    `select distinct p.policy_number from policy.coverable c
       join policy.policy_period b on b.id = c.branch_id and b.status = 'bound'
       join policy.policy p on p.id = b.policy_id
      where c.kind = 'Vehicle' and upper(replace(c.attributes ->> 'registrationNumber', ' ', '')) = $1
        and b.period_start <= $2::date and $2::date < b.period_end
      order by p.policy_number`,
    [wanted, date],
  );
  const found: string[] = [];
  for (const { policy_number } of candidates.rows) {
    const onDate = await getPolicyAsOf(db, policy_number, date);
    if (onDate?.status === 'in_force' && onDate.vehicles.some((v) => normalise(v.registrationNumber ?? '') === wanted)) found.push(policy_number);
  }
  return found;
}

