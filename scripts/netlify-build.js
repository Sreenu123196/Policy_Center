'use strict';
// Netlify build. Netlify serves the files in public/ and has no Node process to run server.js, so the pages are static and
// every /api call is proxied to the service that does run it (see docs/DEPLOY.md). This writes public/_redirects from the
// API_ORIGIN environment variable; Netlify reads that file when the build finishes.
//
//   API_ORIGIN=https://policycenter-api.onrender.com node scripts/netlify-build.js

const fs = require('node:fs');
const path = require('node:path');

const raw = String(process.env.API_ORIGIN || '').trim().replace(/\/+$/, '');
if (!raw) {
  console.error('API_ORIGIN is not set.\nIn Netlify: Site configuration -> Build & deploy -> Environment variables, add\n  API_ORIGIN = https://your-api-host   (no trailing slash, no /api)');
  process.exit(1);
}

let target;
try {
  target = new URL(raw);
} catch {
  console.error(`API_ORIGIN is not a URL: ${raw}`);
  process.exit(1);
}
if (!['http:', 'https:'].includes(target.protocol)) {
  console.error(`API_ORIGIN must be http or https, not ${target.protocol}`);
  process.exit(1);
}
if (target.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(target.hostname)) {
  console.error(`API_ORIGIN is not https. The session cookie is only sent over https, so sign-in will not work: ${raw}`);
  process.exit(1);
}

// Order matters: the API first, then everything else to the app. The UI routes on the # part of the address, so one file
// serves every page.
const lines = [
  '# Written by scripts/netlify-build.js at build time. Do not edit or commit.',
  // Checkout is served by the API from its own origin, so the page needs no third-party script origin in its policy.
  '/checkout.js  ' + target.origin + '/checkout.js  200',
  `/api/*  ${target.origin}/api/:splat  200`,
  '/*      /index.html                 200',
];

const file = path.join(__dirname, '..', 'public', '_redirects');
fs.writeFileSync(file, `${lines.join('\n')}\n`);
console.log(`public/_redirects written: /api/* -> ${target.origin}/api/*, everything else -> /index.html`);
