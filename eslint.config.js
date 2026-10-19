'use strict';
// Linting: the rules that catch a real mistake (an undefined name, a variable that is never used, a comparison that is
// always true) and nothing that is only taste. The project has no build step, so this runs as a check, not a transform.
const js = require('@eslint/js');

const nodeGlobals = {
  require: 'readonly', module: 'writable', exports: 'writable', __dirname: 'readonly', __filename: 'readonly',
  process: 'readonly', console: 'readonly', Buffer: 'readonly', global: 'readonly', setImmediate: 'readonly',
  clearImmediate: 'readonly', URL: 'readonly', URLSearchParams: 'readonly', TextDecoder: 'readonly', TextEncoder: 'readonly',
  AbortController: 'readonly', fetch: 'readonly', Headers: 'readonly', Request: 'readonly', Response: 'readonly',
  FormData: 'readonly', Blob: 'readonly', structuredClone: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly',
  setInterval: 'readonly', clearInterval: 'readonly', queueMicrotask: 'readonly',
};

const browserGlobals = {
  window: 'readonly', document: 'readonly', location: 'readonly', history: 'readonly', navigator: 'readonly',
  localStorage: 'readonly', sessionStorage: 'readonly', fetch: 'readonly', URL: 'readonly', URLSearchParams: 'readonly',
  Blob: 'readonly', FormData: 'readonly', FileReader: 'readonly', Image: 'readonly', Audio: 'readonly',
  speechSynthesis: 'readonly', SpeechSynthesisUtterance: 'readonly', SpeechRecognition: 'readonly',
  webkitSpeechRecognition: 'readonly', alert: 'readonly', confirm: 'readonly', prompt: 'readonly',
  setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly',
  console: 'readonly', requestAnimationFrame: 'readonly', cancelAnimationFrame: 'readonly', matchMedia: 'readonly',
  CSS: 'readonly', crypto: 'readonly', AudioContext: 'readonly', NodeFilter: 'readonly', Node: 'readonly',
  MutationObserver: 'readonly',
};

module.exports = [
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'commonjs', globals: nodeGlobals },
    rules: {
      // A leading underscore says on purpose: destructured to leave a key out, and the value itself is not used.
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      eqeqeq: ['error', 'smart'],
      'no-var': 'error',
      'prefer-const': ['error', { destructuring: 'all' }],
      'no-throw-literal': 'error',
      'no-implicit-coercion': 'off',
    },
  },
  {
    files: ['public/**/*.js'],
    languageOptions: { sourceType: 'script', globals: browserGlobals },
  },
  {
    files: ['scripts/*.py'],
    // not JavaScript
    ignores: ['**/*.py'],
  },
  {
    ignores: ['node_modules/**', 'data/**', '.whisper/**', 'reference-docs/**', '*.min.js'],
  },
];
