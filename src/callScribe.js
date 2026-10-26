'use strict';
// B9: an adjuster's call, turned into a structured reserve and incident form.
//
// Every extracted field carries the words it came from, and a field that is not in the transcript is reported as missing rather than guessed. A
// scribe that invents a reserve amount is worse than no scribe: the number would be entered, approved and paid without anyone noticing where it
// came from.

const MONTHS = 'january|february|march|april|may|june|july|august|september|october|november|december';

const PATTERNS = {
  date: new RegExp('\\b(\\d{1,2}[\\s/-](?:' + MONTHS + ')[\\s/-]\\d{2,4}|\\d{4}-\\d{2}-\\d{2}|\\d{1,2}/\\d{1,2}/\\d{2,4})\\b', 'i'),
  amount: /(?:rs\.?|inr|rupees?|₹)\s*([\d,]+(?:\.\d{1,2})?)|([\d,]{4,}(?:\.\d{1,2})?)\s*(?:rupees|rs\.?|inr)/i,
  cause: /\b(fire|flood|water damage|theft|burglary|accident|collision|storm|hail|lightning|vandalism)\b/i,
  injuries: /\b(injur(?:y|ies|ed)|hospitali[sz]ed|ambulance|fracture|burn(?:s|ed)?)\b/i,
  thirdParty: /\b(third party|another vehicle|other driver|pedestrian|neighbour|neighbor)\b/i,
  property: /\b(dwelling|kitchen|roof|garage|living room|basement|wall|ceiling|vehicle|car|bike|shop|godown)\b/i,
};

const missingField = (name) => ({ field: name, reason: 'Not stated in the transcript; a person must ask.' });

// "Nobody was injured" contains the word injured and means the opposite. A scribe that records the word without its negation would enter an
// injury that does not exist, so the words before the match decide the value.
const NEGATIONS = /\b(no|not|nobody|none|without|never|n't)\b/i;
function isNegated(text, index) {
  return NEGATIONS.test(text.slice(Math.max(0, index - 40), index));
}

function pickAmount(text) {
  const match = text.match(PATTERNS.amount);
  if (!match) return null;
  const raw = (match[1] || match[2] || '').replace(/,/g, '');
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/**
 * @param {string} transcript
 * @returns {{fields: object, missing: Array<{field: string, reason: string}>, complete: boolean, transcript: string}}
 */
function extract(transcript) {
  const text = String(transcript || '');
  const fields = {};
  const missing = [];
  if (!text.trim()) {
    return { fields: {}, missing: ['date', 'cause', 'reserveAmount'].map(missingField), complete: false, transcript: text };
  }

  const dateMatch = text.match(PATTERNS.date);
  if (dateMatch) fields.incidentDate = { value: dateMatch[0], evidence: dateMatch[0] };
  else missing.push(missingField('incidentDate'));

  const causeMatch = text.match(PATTERNS.cause);
  if (causeMatch) fields.cause = { value: causeMatch[0].toLowerCase(), evidence: causeMatch[0] };
  else missing.push(missingField('cause'));

  const amount = pickAmount(text);
  if (amount !== null) {
    const evidence = text.match(PATTERNS.amount)[0];
    fields.reserveAmount = { value: amount, evidence };
  } else missing.push(missingField('reserveAmount'));

  // Presence flags are recorded only when the words are there; absence of the words is reported as unknown, not as "no".
  const injuryMatch = PATTERNS.injuries.exec(text);
  if (injuryMatch) {
    const denied = isNegated(text, injuryMatch.index);
    fields.injuries = { value: !denied, denied, evidence: text.slice(Math.max(0, injuryMatch.index - 20), injuryMatch.index + injuryMatch[0].length).trim() };
  } else missing.push(missingField('injuries'));

  const partyMatch = PATTERNS.thirdParty.exec(text);
  if (partyMatch) {
    const denied = isNegated(text, partyMatch.index);
    fields.thirdParty = { value: !denied, denied, evidence: text.slice(Math.max(0, partyMatch.index - 20), partyMatch.index + partyMatch[0].length).trim() };
  } else missing.push(missingField('thirdParty'));

  const propertyMatch = text.match(PATTERNS.property);
  if (propertyMatch) fields.property = { value: propertyMatch[0].toLowerCase(), evidence: propertyMatch[0] };

  return { fields, missing, complete: missing.length === 0, transcript: text };
}

/** The draft the incidents form expects, built only from fields that were actually present. */
function toIncidentDraft(result) {
  const draft = {};
  if (result.fields.cause) draft.cause = result.fields.cause.value;
  if (result.fields.incidentDate) draft.occurredOn = result.fields.incidentDate.value;
  if (result.fields.property) draft.property = result.fields.property.value;
  // A stated denial is recorded as false - the difference between "no injury" and "not discussed" matters on a claim file.
  if (result.fields.injuries) draft.injuries = result.fields.injuries.value;
  if (result.fields.thirdParty) draft.thirdParty = result.fields.thirdParty.value;
  return draft;
}

/** A reserve proposal, refused when the amount was never stated. */
function proposeReserve(result) {
  if (!result.fields.reserveAmount) return { proposed: false, reason: 'No amount was stated in the call; a person must set the reserve.' };
  return { proposed: true, amount: result.fields.reserveAmount.value, evidence: result.fields.reserveAmount.evidence };
}

module.exports = { extract, toIncidentDraft, proposeReserve, PATTERNS };
