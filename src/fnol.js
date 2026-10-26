'use strict';
// B6: first notice of loss by voice or chat, in English, Hindi or Telugu.
//
// Two halves. The script is what the caller hears, and it must exist in the language they chose - falling back to English *visibly* rather than silently
// pretending. The intake turns a transcript into the same incident draft and reserve proposal the adjuster scribe produces, with cause and currency words
// recognised in all three languages, because a loss reported in Telugu is still a loss.

const LANGUAGES = ['en', 'hi', 'te'];

const SCRIPT = {
  en: {
    greeting: 'Thank you for calling. I will take the first notice of loss now.',
    questions: ['What happened?', 'When did it happen?', 'Was anyone injured?', 'Where did it happen?', 'Is there an estimate for the repair?'],
    closing: 'A claims handler will call you back. Please keep any photographs and documents.',
  },
  hi: {
    greeting: 'कॉल करने के लिए धन्यवाद। मैं अब प्रारंभिक सूचना दर्ज करूँगा।',
    questions: ['क्या हुआ?', 'यह कब हुआ?', 'किसी को चोट लगी?', 'यह कहाँ हुआ?', 'मरम्मत का अनुमान है?'],
    closing: 'क्लेम अधिकारी आपको वापस कॉल करेंगे। कृपया तस्वीरें और दस्तावेज़ संभालकर रखें।',
  },
  te: {
    greeting: 'కాల్ చేసినందుకు ధన్యవాదాలు. నేను ఇప్పుడు ప్రాథమిక నష్ట సమాచారాన్ని నమోదు చేస్తాను.',
    questions: ['ఏం జరిగింది?', 'ఎప్పుడు జరిగింది?', 'ఎవరికైనా గాయమైందా?', 'ఎక్కడ జరిగింది?', 'మరమ్మతు అంచనా ఉందా?'],
    closing: 'క్లెయిమ్ అధికారి మీకు తిరిగి కాల్ చేస్తారు. దయచేసి ఫోటోలు మరియు పత్రాలను భద్రంగా ఉంచండి.',
  },
};

// The same loss, in three languages. Amounts accept the currency words people actually say.
const CAUSE = {
  fire: ['fire', 'आग', 'आग लगी', 'అగ్ని', 'మంటలు'],
  water: ['water', 'पानी', 'बाढ़', 'నీరు', 'వరదలు'],
  theft: ['theft', 'stolen', 'चोरी', 'दొంగల్', 'దొంగతనం'],
  accident: ['accident', 'collision', 'दुर्घटना', 'టక్కర్', 'ప్రమాదం'],
};
const INJURY = ['injured', 'injury', 'hospital', 'चोट', 'अस्पताल', 'గాయం', 'ఆసుపత్రి'];
// Both word orders occur: "Rs. 45,000" in English, "45,000 रुपये" in Hindi and Telugu. Either is an amount.
const CURRENCY_BEFORE = /(?:rs\.?|inr|rupees?|₹|रुपये|रु|రూపాయలు|రూ)\s*([\d,]+(?:\.\d{1,2})?)/i;
const CURRENCY_AFTER = /([\d,]+(?:\.\d{1,2})?)\s*(?:rs\.?|rupees?|रुपये|రూపాయలు)/i;

function buildScript(language = 'en') {
  const requested = String(language).toLowerCase().split('-')[0];
  if (SCRIPT[requested]) return { language: requested, fallback: false, ...SCRIPT[requested] };
  return { language: 'en', fallback: true, requested, ...SCRIPT.en };
}

/**
 * @param {{transcript: string, language?: string}} input
 */
function intake({ transcript = '', language = 'en' } = {}) {
  const script = buildScript(language);
  const text = String(transcript || '');
  const found = { cause: null, injuries: false, amount: null };
  const lower = text.toLowerCase();

  for (const [cause, words] of Object.entries(CAUSE)) {
    if (words.some((w) => lower.includes(String(w).toLowerCase()))) { found.cause = cause; break; }
  }
  found.injuries = INJURY.some((w) => lower.includes(String(w).toLowerCase()));
  const amount = text.match(CURRENCY_BEFORE) || text.match(CURRENCY_AFTER);
  if (amount) found.amount = Number(amount[1].replace(/,/g, ''));

  const missing = [];
  if (!found.cause) missing.push('cause');
  if (found.amount === null) missing.push('amount');
  return {
    language: script.language,
    fallback: script.fallback,
    transcript: text,
    found,
    missing,
    draft: { ...(found.cause ? { cause: found.cause } : {}), ...(found.injuries ? { injuries: true } : {}) },
    reserve: found.amount === null
      ? { proposed: false, reason: 'No amount was stated; a person must set the reserve.' }
      : { proposed: true, amount: found.amount },
  };
}

module.exports = { LANGUAGES, buildScript, intake, SCRIPT, CAUSE, INJURY };
