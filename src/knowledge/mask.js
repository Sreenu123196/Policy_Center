'use strict';
// Masking before logging.
//
// A knowledge query log is useful ("what do people ask, what do we fail to answer") and dangerous (the question may
// contain a customer's Aadhaar number, PAN, phone or account number). The log keeps the shape of the question and the
// citation outcome, never the identifiers: masking happens on the way in, so nothing downstream has to remember.
//
// Order matters: a bare twelve-digit number is ambiguous between an Aadhaar and a bank account, and it is masked as
// an Aadhaar because that is the more sensitive of the two. Anything 9-11 or 13-18 digits is treated as an account.
//
// The patterns are deliberately conservative. A false positive costs a masked digit in a log line; a false negative
// puts an identifier in a log file that is shipped elsewhere.

const RULES = [
  // Aadhaar: twelve digits, often grouped 4-4-4. Requires word boundaries so a policy number is not caught.
  { name: 'aadhaar', pattern: /\b\d{4}\s?\d{4}\s?\d{4}\b/g, replace: '[AADHAAR]' },
  // PAN: five letters, four digits, one letter (ABCDE1234F).
  { name: 'pan', pattern: /\b[A-Z]{5}\d{4}[A-Z]\b/g, replace: '[PAN]' },
  // Indian mobile numbers, with or without +91, and with spaces or dashes.
  { name: 'phone', pattern: /(?:\+91[\s-]?)?\b[6-9]\d{4}[\s-]?\d{5}\b/g, replace: '[PHONE]' },
  // Bank account numbers: 9 to 18 digits, not part of a longer number.
  { name: 'account', pattern: /\b\d{9,18}\b/g, replace: '[ACCOUNT]' },
  // Email addresses.
  { name: 'email', pattern: /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, replace: '[EMAIL]' },
];

function maskText(value) {
  if (value === null || value === undefined) return '';
  let text = String(value);
  for (const rule of RULES) text = text.replace(rule.pattern, rule.replace);
  return text;
}

/** The shape of a query, safe to store: masked text, a length bucket, and no raw identifiers. */
function safeQuery(query) {
  const masked = maskText(query).slice(0, 500);
  return { masked, length: String(query || '').length <= 80 ? 'short' : 'long', maskedCount: (maskText(query).match(/\[[A-Z]+\]/g) || []).length };
}

module.exports = { maskText, safeQuery, RULES };
