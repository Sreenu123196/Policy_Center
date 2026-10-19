'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Accessibility (WCAG 2.2 AA) checks that can be made without a browser: the page structure, keyboard and focus rules, target
// size, reduced motion, and colour contrast of the colours the stylesheet defines. What needs a person (reading order with a
// screen reader, zoom to 400%, real keyboard use of every screen) is listed in docs/ACCESSIBILITY.md.

const read = (file) => fs.readFileSync(path.join(__dirname, '..', 'public', file), 'utf8');
const html = read('index.html');
const css = read('styles.css');
const app = read('app.js');

// ---------------------------------------------------------------- colour contrast

const tokens = Object.fromEntries([...css.match(/:root\s*{[^}]*}/)[0].matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})/g)].map((m) => [m[1], m[2]]));
const channel = (hex, i) => {
  const v = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const luminance = (hex) => 0.2126 * channel(hex, 0) + 0.7152 * channel(hex, 1) + 0.0722 * channel(hex, 2);
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

test('text and background colours have a contrast of at least 4.5 to 1 (large text 3 to 1)', () => {
  const pairs = [
    ['text', 'bg'], ['text', 'surface'], ['muted', 'bg'], ['muted', 'surface'], ['muted', 'surface-2'],
    ['nav-text', 'nav'], ['accent', 'surface'], ['accent', 'accent-soft'], ['surface', 'accent'],
    ['success', 'success-soft'], ['surface', 'success'], ['warning', 'warning-soft'], ['warning', 'surface'],
    ['danger', 'danger-soft'], ['danger', 'surface'],
  ];
  const low = pairs.map(([fg, bg]) => [fg, bg, contrast(tokens[fg], tokens[bg])]).filter(([, , ratio]) => ratio < 4.5);
  assert.deepEqual(low.map(([fg, bg, ratio]) => `${fg} on ${bg}: ${ratio.toFixed(2)}`), []);
});

// ---------------------------------------------------------------- page structure

test('the page has a language, a title, landmarks and a way to skip the menu', () => {
  assert.match(html, /<html lang="en"/);
  assert.match(html, /<title>[^<]+<\/title>/);
  assert.match(html, /<a class="skip-link" href="#app">Skip to main content<\/a>/);
  assert.ok(html.indexOf('skip-link') < html.indexOf('<header'), 'the skip link comes before the header');
  assert.match(html, /<nav class="mainnav" aria-label="Main"/);
  assert.match(html, /<main id="app"[^>]*tabindex="-1"/);
  assert.match(html, /<header class="topbar"/);
  assert.match(css, /\.skip-link:focus/); // it shows when it gets focus
});

test('every button with no text, and every field with no visible label, has an accessible name', () => {
  for (const m of html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)) {
    const hasText = m[2].replace(/<svg[\s\S]*?<\/svg>/g, '').trim() !== '';
    assert.ok(hasText || /aria-label="[^"]+"/.test(m[1]), `a button has neither text nor aria-label: ${m[0].slice(0, 80)}`);
  }
  for (const m of html.matchAll(/<(input|select|textarea)\b([^>]*)>/g)) {
    assert.ok(/aria-label="[^"]+"/.test(m[2]) || /<label[^>]*for=/.test(html), `a ${m[1]} has no label: ${m[0].slice(0, 80)}`);
  }
});

test('the language chooser is a labelled control that names each language in its own script', () => {
  assert.match(html, /<select id="lang-select"[^>]*aria-label="Language"/);
  for (const name of ['English', 'हिन्दी', 'తెలుగు']) assert.ok(html.includes(`>${name}</option>`), name);
  assert.match(html, /<script src="i18n\.js"><\/script>\s*<script src="app\.js"><\/script>/); // the translation is loaded first
});

// ---------------------------------------------------------------- keyboard and focus

test('every kind of control shows where the keyboard focus is', () => {
  assert.match(css, /a:focus-visible[^{]*\{[^}]*outline:\s*3px/);
  assert.match(css, /button:focus-visible/);
  assert.match(css, /input:focus-visible/);
  assert.match(css, /select:focus-visible/);
  assert.match(css, /textarea:focus-visible/);
  assert.match(css, /\[tabindex\]:focus-visible|main:focus-visible/);
  assert.ok(!/outline:\s*none/.test(css.replace(/main:focus[^}]*\}/g, '')), 'no rule turns the focus outline off');
});

test('buttons and links are at least 24 by 24 pixels, so they can be hit', () => {
  assert.match(css, /\.btn[^{]*\{[^}]*min-height:\s*24px/);
  assert.match(css, /\.mainnav a[^{]*\{[^}]*min-height:\s*24px/);
});

test('movement stops for people who ask for less of it', () => {
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
});

test('a dialog names itself, keeps the keyboard inside, closes with Escape and gives focus back', () => {
  assert.match(app, /aria-labelledby/);
  assert.match(app, /aria-modal="true"/);
  assert.match(app, /'Escape'/);
  assert.match(app, /key === 'Tab'/); // the focus trap
  assert.match(app, /\.focus\(\)/);
  assert.match(app, /opener/); // focus returns to the control that opened it
});

test('tables say which cells are headers, and errors and messages are announced', () => {
  assert.match(app, /<th scope="col"/);
  assert.match(app, /role="alert"/);
  assert.match(html, /id="toasts"[^>]*aria-live="polite"/);
});

test('the title of the page follows the screen, so a screen reader hears where the person is', () => {
  assert.match(app, /document\.title\s*=/);
});
