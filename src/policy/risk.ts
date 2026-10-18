import type { Database } from '../platform/index.js';
import { getContact } from '../contacts/index.js';
import { isRealDate } from '../platform/index.js';
import type { BranchAsOf } from './policy.js';
import type { Facts, Selection } from './product-selection.js';

// Whole years between a birth date and a date (both yyyy-mm-dd): the birthday counts on the day it falls.
export function ageOn(dateOfBirth: string, date: string): number {
  const years = Number(date.slice(0, 4)) - Number(dateOfBirth.slice(0, 4));
  return date.slice(5) < dateOfBirth.slice(5) ? years - 1 : years;
}

// What we know about a risk on the start date of a branch, for availability rules, rating and underwriting rules.
// Facts come from the branch and from the account's named insured. Anything that cannot be worked out is reported
// in "errors", and its fact is left out, so a rule on a missing fact is simply false.
export async function buildRisk(db: Database, accountId: string, asOf: BranchAsOf): Promise<{ facts: Facts; selection: Selection; errors: string[] }> {
  const errors: string[] = [];
  const facts: Facts = {};
  const start = asOf.branch.periodStart;

  const vehicles = asOf.coverables.filter((c) => c.kind === 'Vehicle');
  const vehicle = vehicles.length === 1 ? vehicles[0] : undefined;
  if (vehicles.length !== 1) errors.push('A quote needs exactly one vehicle');
  if (vehicle !== undefined) {
    const year = vehicle.attributes.year;
    const engineCc = vehicle.attributes.engineCc;
    const facts_vehicle: Record<string, number> = {};
    if (typeof year !== 'number' || !Number.isInteger(year)) errors.push('The vehicle needs a model year');
    else facts_vehicle.ageYears = Number(start.slice(0, 4)) - year;
    if (typeof engineCc === 'number') facts_vehicle.engineCc = engineCc;
    facts.vehicle = facts_vehicle;
    const claimFree = vehicle.attributes.claimFreeYears;
    if (typeof claimFree === 'number') facts.claimFreeYears = claimFree;
  }

  const birthDates = asOf.coverables
    .filter((c) => c.kind === 'Driver')
    .map((c) => c.attributes.dateOfBirth)
    .filter((d): d is string => typeof d === 'string' && isRealDate(d));
  if (birthDates.length > 0) facts.driver = { youngestAgeYears: Math.min(...birthDates.map((d) => ageOn(d, start))) };

  const insured = (await db.query<{ contact_id: string }>("select contact_id from policy.account_contact where account_id = $1 and role = 'named_insured'", [accountId])).rows[0];
  const contact = insured ? await getContact(db, insured.contact_id) : null;
  if (contact === null) errors.push('The account has no named insured');
  else facts.ownerType = contact.kind === 'person' ? 'individual' : 'company';

  const selection: Selection = {};
  for (const coverage of asOf.coverages) selection[coverage.patternCode] = coverage.terms;
  const idv = selection.MOTOR_OD?.idv;
  if (typeof idv === 'number') facts.idv = idv;
  return { facts, selection, errors };
}
