'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ENTRIES, LANGUAGES, translate } = require('../public/i18n');

// Hindi and Telugu for the screens. The dictionary is checked for what a machine can check: every entry has both
// languages in the right script, nothing is left over from a screen that no longer says it, and the words every person
// sees (menus, table headers, field labels, buttons) are covered. Whether the translations READ well is for a native
// speaker to review; see the note at the top of public/i18n.js.

const read = (file) => fs.readFileSync(path.join(__dirname, '..', 'public', file), 'utf8');
const serverSource = fs.readdirSync(path.join(__dirname, '..', 'src')).map((f) => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8')).join('\n');
const source = `${read('app.js')}\n${read('index.html')}\n${serverSource}`.replace(/\\'/g, "'");
// Texts the screens build from a template (a word and a status), so they are not written out anywhere.
const GENERATED = ['Refunds due', 'Refunds issued', 'Refunds withdrawn'];

const DEVANAGARI = /[ऀ-ॿ]/;
const TELUGU = /[ఀ-౿]/;
// Words that stay the same in every language: names of file types and codes.
const SAME = new Set(['VIN', 'ZIP', 'PDF', 'Excel']);

test('every entry has a Hindi and a Telugu text in the right script', () => {
  for (const [english, [hi, te]] of Object.entries(ENTRIES)) {
    assert.ok(typeof hi === 'string' && hi.trim() !== '', `Hindi missing for "${english}"`);
    assert.ok(typeof te === 'string' && te.trim() !== '', `Telugu missing for "${english}"`);
    if (SAME.has(english)) continue;
    assert.ok(DEVANAGARI.test(hi), `Hindi for "${english}" is not in Devanagari: ${hi}`);
    assert.ok(TELUGU.test(te), `Telugu for "${english}" is not in Telugu script: ${te}`);
    if (!DEVANAGARI.test(english) && !TELUGU.test(english)) assert.ok(!DEVANAGARI.test(te) && !TELUGU.test(hi), `Hindi and Telugu are mixed up for "${english}"`);
  }
});

test('an entry keeps the same punctuation at the end as the English, and no entry has stray spaces', () => {
  for (const [english, [hi, te]] of Object.entries(ENTRIES)) {
    assert.equal(english, english.trim(), `the key "${english}" has spaces around it`);
    for (const t of [hi, te]) {
      assert.equal(t, t.trim(), `a translation of "${english}" has spaces around it`);
      if (/[.:?]$/.test(english)) assert.ok(/[.:?।…]$/.test(t), `"${english}" ends with punctuation and its translation "${t}" does not`);
    }
  }
});

test('no entry is left over from text the screens no longer show', () => {
  const stale = Object.keys(ENTRIES).filter((english) => !GENERATED.includes(english) && !source.includes(english));
  assert.deepEqual(stale, []);
});

test('the words every person sees are covered: menu, table headers, field labels, buttons', () => {
  const quoted = (s) => [...s.matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1]);
  const wanted = new Set();
  for (const m of read('index.html').matchAll(/<a [^>]*data-nav[^>]*>([^<]+)<\/a>/g)) wanted.add(m[1].trim());
  for (const m of read('app.js').matchAll(/table\(\[([^\]]*)\]/g)) quoted(m[1]).forEach((h) => wanted.add(h.replace(/^\$/, '')));
  for (const m of read('app.js').matchAll(/field\('((?:[^'\\]|\\.)*)'/g)) wanted.add(m[1]);
  for (const m of read('app.js').matchAll(/<button[^>]*class="btn[^"]*"[^>]*>([A-Z][^<${]{2,40})<\/button>/g)) wanted.add(m[1].trim());
  const clean = [...wanted].filter((w) => w && !/[${}\\]/.test(w) && w.length > 2);
  const missing = clean.filter((w) => !Object.prototype.hasOwnProperty.call(ENTRIES, w));
  const covered = 1 - missing.length / clean.length;
  assert.ok(covered >= 0.9, `only ${(covered * 100).toFixed(0)}% of ${clean.length} headings, labels and buttons are translated; missing: ${missing.join(' | ')}`);
});

test('translate gives the other language, keeps spaces, and leaves anything it does not know alone', () => {
  assert.equal(translate('Claims', 'hi'), 'दावे');
  assert.equal(translate('Claims', 'te'), 'క్లెయిమ్‌లు');
  assert.equal(translate('  Claims  ', 'hi'), '  दावे  ');
  assert.equal(translate('Claims', 'en'), 'Claims');
  assert.equal(translate('CL-0000001', 'hi'), 'CL-0000001'); // a number or a name is never translated
  assert.equal(translate('Jordan Rivera', 'te'), 'Jordan Rivera');
  assert.equal(translate('toString', 'hi'), 'toString'); // inherited object keys are not words
});

test('the language list has English, Hindi and Telugu, each named in its own script', () => {
  assert.deepEqual(Object.keys(LANGUAGES), ['en', 'hi', 'te']);
  assert.ok(DEVANAGARI.test(LANGUAGES.hi) && TELUGU.test(LANGUAGES.te));
});
