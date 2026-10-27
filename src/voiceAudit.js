'use strict';
// B15: a call that mixes languages, and a record a regulator can read.
//
// Code-mixing is the normal way people speak: "claim ki details cheppandi" is one sentence in two languages. The normaliser maps the common function words
// to English so the intake can read the sentence, and reports how mixed it was rather than pretending the call was monolingual.
//
// The audit is the part that matters legally: consent before recording, a masked caller number, a retention date, and a flag when an outbound service call
// does not come from the 1600 series TRAI reserves for it.

const { AppError } = require('./appError');

// The handful of words that carry the meaning of a claim call, in the forms people actually type and speak.
const GLOSSARY = {
  'cheppandi': 'tell', 'చెప్పండి': 'tell',
  'jarigindi': 'happened', 'జరిగింది': 'happened', 'hua': 'happened', 'हुआ': 'happened',
  'kaavalani': 'needed', 'కావాలి': 'needed', 'chahiye': 'needed', 'चाहिए': 'needed',
  'gayam': 'injury', 'గాయం': 'injury', 'chot': 'injury', 'चोट': 'injury',
  'agni': 'fire', 'అగ్ని': 'fire', 'aag': 'fire', 'आग': 'fire',
  'neellu': 'water', 'నీరు': 'water', 'paani': 'water', 'पानी': 'water',
  'dongatanam': 'theft', 'దొంగతనం': 'theft', 'chori': 'theft', 'चोरी': 'theft',
  'rupayalu': 'rupees', 'రూపాయలు': 'rupees', 'rupaye': 'rupees', 'रुपये': 'rupees',
};

const NON_LATIN = /[\u0900-\u097F]|[\u0C00-\u0C7F]/;
const LATIN = /[A-Za-z]/;

function normaliseCodeMixed(text = '') {
  const source = String(text);
  const words = source.split(/\s+/).filter(Boolean);
  let mapped = 0;
  const out = words.map((word) => {
    const bare = word.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
    const hit = GLOSSARY[bare];
    if (hit) { mapped += 1; return word.replace(new RegExp(bare, 'i'), hit); }
    return word;
  });
  const normalised = out.join(' ');
  const hasLatin = LATIN.test(source);
  const hasIndic = NON_LATIN.test(source);
  const languages = [hasLatin ? 'en' : null, hasIndic ? 'indic' : null].filter(Boolean);
  return {
    normalised,
    mappedWords: mapped,
    // Tenglish is written in Latin letters, so two scripts is not the test: a Latin sentence carrying Indic-origin words is code-mixed, and so is a
    // sentence that changes script.
    mixed: hasLatin && (hasIndic || mapped > 0),
    languages,
    mixedRatio: words.length === 0 ? 0 : Math.round((mapped / words.length) * 100) / 100,
  };
}

const RETENTION_DAYS = 180;

/**
 * @param {{callId: string, direction?: 'outbound'|'inbound', to?: string, from?: string, startedAt: string, endedAt?: string, consent?: boolean, language?: string, transcript?: string, recordingUrl?: string}} input
 */
function auditCall(input = {}) {
  const { callId, direction = 'outbound', to, from, startedAt, endedAt, consent } = input;
  if (!callId) throw new AppError(422, 'a call id is required');
  if (!startedAt) throw new AppError(422, 'a started time is required');
  const started = new Date(startedAt);
  if (!Number.isFinite(started.getTime())) throw new AppError(422, 'the started time is not a date');

  const findings = [];
  if (consent !== true) findings.push({ code: 'no-consent', detail: 'The recording was not consented to, so it may not be kept.' });
  if (direction === 'outbound' && from && !String(from).replace(/\D/g, '').startsWith('1600')) {
    findings.push({ code: 'not-1600-series', detail: 'Outbound service calls must originate from the 1600 series; this one came from ' + from + '.' });
  }
  const ended = endedAt ? new Date(endedAt) : null;
  if (endedAt && !Number.isFinite(ended.getTime())) throw new AppError(422, 'the ended time is not a date');
  const retentionUntil = consent === true ? new Date(started.getTime() + RETENTION_DAYS * 86400000).toISOString().slice(0, 10) : null;

  return {
    callId,
    direction,
    to: to ? String(to).replace(/\d(?=\d{4})/g, '*') : null,
    from: from || null,
    startedAt: started.toISOString(),
    endedAt: ended ? ended.toISOString() : null,
    durationSeconds: ended ? Math.max(0, Math.round((ended - started) / 1000)) : null,
    consent: consent === true,
    language: input.language || null,
    mixed: normaliseCodeMixed(input.transcript || ''),
    recordingUrl: consent === true ? input.recordingUrl || null : null,
    retentionUntil,
    findings,
    compliant: findings.length === 0,
  };
}

module.exports = { normaliseCodeMixed, auditCall, GLOSSARY, RETENTION_DAYS };
