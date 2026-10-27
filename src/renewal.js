'use strict';
// A10: renewal work that ends at a person, not a send button.
//
// Two things are missing from a renewal agent that only talks: a reason, and a stop. So each policy gets named risk reasons rather than a score, the message is
// drafted in the customer's language with no promise in it, and the send step returns "held for a person" every time - because a renewal message that goes out
// on its own is a decision nobody reviewed.

const { AppError } = require('./appError');

const LANGUAGES = ['en', 'hi', 'te'];

const TEMPLATE = {
  en: (name, policyNumber, date) => `Dear ${name}, your policy ${policyNumber} is due for renewal on ${date}. Our team can help you continue it; reply to this message and a person will call you.`,
  hi: (name, policyNumber, date) => `प्रिय ${name}, आपकी पॉलिसी ${policyNumber} का नवीनीकरण ${date} को देय है। हमारी टीम इसे जारी रखने में सहायता कर सकती है; इस संदेश का उत्तर दें और हमारा प्रतिनिधि आपको कॉल करेगा।`,
  te: (name, policyNumber, date) => `ప్రియమైన ${name}, మీ పాలసీ ${policyNumber} పునరుద్ధరణ ${date} తేదీన చెల్లుబాటు అవుతుంది. కొనసాగించడంలో మా బృందం సహాయం చేస్తుంది; ఈ సందేశానికి ప్రత్యుత్తరం ఇవ్వండి, మా ప్రతినిధి మీకు కాల్ చేస్తారు.`,
};

/**
 * @param {{policy: object, asOf: string, instalmentsDue?: number, contacts?: number}} input
 * @returns {{reasons: Array<{code: string, detail: string}>, level: 'low'|'medium'|'high'}}
 */
function lapseRisk({ policy, asOf, instalmentsDue = 0, contacts = 1 } = {}) {
  if (!policy || !policy.renewalDate) throw new AppError(422, 'a policy with a renewal date is required');
  const renews = Date.parse(policy.renewalDate);
  const onDate = Date.parse(asOf || new Date().toISOString());
  if (!Number.isFinite(renews) || !Number.isFinite(onDate)) throw new AppError(422, 'dates must be readable');

  const days = Math.round((renews - onDate) / 86400000);
  const reasons = [];
  if (days < 0) reasons.push({ code: 'already-lapsed', detail: 'The renewal date passed ' + Math.abs(days) + ' day(s) ago.' });
  else if (days <= 30) reasons.push({ code: 'renewal-due', detail: 'The renewal is due in ' + days + ' day(s).' });
  if (instalmentsDue > 0) reasons.push({ code: 'instalments-outstanding', detail: instalmentsDue + ' instalment(s) are outstanding.' });
  if (contacts === 0) reasons.push({ code: 'no-contact', detail: 'No contact details are recorded, so a reminder cannot reach the customer.' });
  if (policy.status && /cancelled|lapsed/i.test(policy.status)) reasons.push({ code: 'status-' + String(policy.status).toLowerCase(), detail: 'The policy is ' + policy.status + '.' });

  const level = reasons.some((r) => r.code === 'already-lapsed' || r.code === 'instalments-outstanding') ? 'high'
    : reasons.length ? 'medium' : 'low';
  return { reasons, level, daysToRenewal: days };
}

/** A draft, in the customer's language, with no promise of cover and no price. */
function draftRenewal({ policy, language = 'en', customerName } = {}) {
  if (!policy || !policy.policyNumber) throw new AppError(422, 'a policy number is required');
  const lang = LANGUAGES.includes(String(language).toLowerCase().split('-')[0]) ? String(language).toLowerCase().split('-')[0] : 'en';
  const date = policy.renewalDate ? new Date(policy.renewalDate).toISOString().slice(0, 10) : 'the renewal date';
  return {
    language: lang,
    fellBack: lang !== String(language).toLowerCase().split('-')[0],
    text: TEMPLATE[lang](customerName || 'customer', policy.policyNumber, date),
    // Held, always: a person releases it.
    send: { status: 'held_for_person', reason: 'A renewal message is sent by a person, never by the agent.' },
  };
}

module.exports = { lapseRisk, draftRenewal, LANGUAGES, TEMPLATE };
