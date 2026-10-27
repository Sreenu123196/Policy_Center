'use strict';
// B28: a policy walkthrough, as script and captions.
//
// Rendering a video needs a vendor; deciding what it should say does not. This produces the narration beats and their captions from a policy summary, in the customer's language, with the
// same rule as every other customer-facing draft here: no promise of cover and no invented figure - it describes what the schedule says.

const { AppError } = require('./appError');

const LANGUAGES = ['en', 'hi', 'te'];
const money = (value) => (Number(value) || 0).toLocaleString('en-IN');

const TEMPLATES = {
  en: (p) => [
    ['Your policy', 'Policy ' + p.policyNumber + ', ' + (p.product || 'your policy') + ', in force from ' + (p.effectiveDate || 'the start date') + '.'],
    ['What you pay', 'The premium is ' + money(p.premium) + '. Payments and instalments are shown in Billing.'],
    ['What is covered', (p.coverages || []).length ? 'This policy includes ' + (p.coverages || []).join(', ') + '.' : 'Your coverages are listed on the schedule.'],
    ['What to do next', 'Keep your documents. If something happens, report it and a claims handler will guide you.'],
  ],
  hi: (p) => [
    ['आपकी पॉलिसी', 'पॉलिसी ' + p.policyNumber + ', ' + (p.effectiveDate || 'प्रारंभ तिथि') + ' से लागू.'],
    ['आपका भुगतान', 'प्रीमियम ' + money(p.premium) + ' है. भुगतान बिलिंग में दिखते हैं.'],
    ['क्या शामिल है', (p.coverages || []).length ? 'इस पॉलिसी में शामिल हैं: ' + (p.coverages || []).join(', ') + '.' : 'कवरेज अनुसूची में दिए गए हैं.'],
    ['आगे क्या करें', 'दस्तावेज़ संभालकर रखें. कुछ होने पर सूचित करें, क्लेम अधिकारी मार्गदर्शन करेंगे.'],
  ],
  te: (p) => [
    ['మీ పాలసీ', 'పాలసీ ' + p.policyNumber + ', ' + (p.effectiveDate || 'ప్రారంభ తేదీ') + ' నుండి అమలులో.'],
    ['మీ చెల్లింపు', 'ప్రీమియం ' + money(p.premium) + '. చెల్లింపులు బిల్లింగ్‌లో కనిపిస్తాయి.'],
    ['ఏమి కవర్ అవుతుంది', (p.coverages || []).length ? 'ఈ పాలసీలో ఇవి ఉన్నాయి: ' + (p.coverages || []).join(', ') + '.' : 'కవరేజీలు షెడ్యూల్‌లో ఉన్నాయి.'],
    ['తర్వాత ఏమి చేయాలి', 'పత్రాలను భద్రంగా ఉంచండి. ఏదైనా జరిగితే తెలియజేయండి, క్లెయిమ్ అధికారి మార్గనిర్దేశం చేస్తారు.'],
  ],
};

/**
 * @param {{policy: object, language?: string, wordsPerCaption?: number}} input
 */
function buildWalkthrough({ policy, language = 'en', wordsPerCaption = 12 } = {}) {
  if (!policy || !policy.policyNumber) throw new AppError(422, 'a policy number is required');
  const wanted = String(language).toLowerCase().split('-')[0];
  const lang = LANGUAGES.includes(wanted) ? wanted : 'en';
  const beats = TEMPLATES[lang](policy).map(([section, text]) => ({ section, text }));

  // Captions are the narration split into readable chunks; the video's timing is a vendor's job, the words are ours.
  const captions = [];
  for (const beat of beats) {
    const words = beat.text.split(/\s+/);
    for (let i = 0; i < words.length; i += wordsPerCaption) {
      captions.push({ section: beat.section, text: words.slice(i, i + wordsPerCaption).join(' ') });
    }
  }
  const words = beats.reduce((sum, b) => sum + b.text.split(/\s+/).length, 0);
  return { language: lang, fellBack: lang !== wanted, beats, captions, estimatedSeconds: Math.round((words / 2.5)), note: 'Narration and captions only: rendering needs a video service.' };
}

module.exports = { buildWalkthrough, LANGUAGES };
