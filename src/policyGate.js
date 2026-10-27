'use strict';
// B29: the gate a pull request must pass.
//
// Every rule here is a mistake that actually happened in this repository, found late: a route with no permission row, a test file replaced
// so the count fell by twelve, a source change with no test, and a secret-shaped string in a diff. Written as checks so they run before
// merge rather than depending on somebody remembering to look.

const MIN_TESTS_FLOOR = 1;

/** The suite must not shrink. A count that goes down is a deletion, not a refactor. */
function checkTestCount({ reported, baseline }) {
  if (!Number.isFinite(reported) || reported <= 0) return [{ rule: 'test-count', ok: false, detail: 'No test count was reported; the gate cannot prove the suite ran.' }];
  if (!Number.isFinite(baseline) || baseline < MIN_TESTS_FLOOR) return [{ rule: 'test-count', ok: false, detail: 'No baseline recorded, so a shrinking suite cannot be detected.' }];
  if (reported < baseline) return [{ rule: 'test-count', ok: false, detail: 'The suite shrank: ' + reported + ' tests against a baseline of ' + baseline + '.' }];
  return [{ rule: 'test-count', ok: true, detail: reported + ' tests, at or above the baseline of ' + baseline + '.' }];
}

/** Every route has a permission row, and every row has a route. */
function checkRoutes({ routes, matrixKeys }) {
  const routeKeys = new Set(routes.map((r) => r.method + ' ' + r.pattern));
  const matrix = new Set(matrixKeys);
  const missingRows = [...routeKeys].filter((k) => !matrix.has(k)).sort();
  const missingRoutes = [...matrix].filter((k) => !routeKeys.has(k)).sort();
  const out = [];
  out.push({
    rule: 'routes-vs-matrix',
    ok: missingRows.length === 0,
    detail: missingRows.length === 0 ? 'Every route has a permission row.' : 'Routes with no permission row: ' + missingRows.join(', '),
  });
  out.push({
    rule: 'matrix-vs-routes',
    ok: missingRoutes.length === 0,
    detail: missingRoutes.length === 0 ? 'Every permission row names a route that exists.' : 'Rows for routes that do not exist: ' + missingRoutes.join(', '),
  });
  return out;
}

/** A change to src is either tested or declared. */
function checkSourceNeedsTests({ files }) {
  const src = files.filter((f) => /^src\//.test(f));
  const tests = files.filter((f) => /^test\//.test(f));
  if (src.length === 0) return [{ rule: 'source-needs-test', ok: true, detail: 'No source change in this diff.' }];
  if (tests.length > 0) return [{ rule: 'source-needs-test', ok: true, detail: src.length + ' source file(s) with ' + tests.length + ' test file(s).' }];
  return [{ rule: 'source-needs-test', ok: false, detail: 'Source changed with no test change: ' + src.join(', ') }];
}

// Shapes that are secrets, not prose. Kept narrow on purpose: a noisy gate gets switched off.
const SECRET_PATTERNS = [
  { name: 'private key block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'api key assignment', re: /\b(sk|pk|rk)_(live|test)_[A-Za-z0-9]{10,}/ },
  { name: 'anthropic key', re: /sk-ant-[A-Za-z0-9_-]{10,}/ },
  { name: 'razorpay secret', re: /RAZORPAY_KEY_SECRET\s*=\s*\S{8,}/ },
  { name: 'generic secret assignment', re: /\b(secret|password|token)\s*[:=]\s*['"][A-Za-z0-9_-]{16,}['"]/i },
];

function checkSecrets({ text }) {
  const found = [];
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.re.test(text || '')) found.push(pattern.name);
  }
  return [{
    rule: 'no-secrets',
    ok: found.length === 0,
    detail: found.length === 0 ? 'No secret-shaped strings in the diff.' : 'Secret-shaped strings: ' + found.join(', '),
  }];
}

/** `.env` must never be committed, whatever it holds. */
function checkEnvFile({ files }) {
  const bad = files.filter((f) => /(^|\/)\.env($|\.)/.test(f) && !/\.env\.example$/.test(f));
  return [{
    rule: 'no-env-files',
    ok: bad.length === 0,
    detail: bad.length === 0 ? 'No environment files in the diff.' : 'Environment files staged: ' + bad.join(', '),
  }];
}

function runGate({ reported, baseline, routes, matrixKeys, files = [], diffText = '' }) {
  const results = [
    ...checkTestCount({ reported, baseline }),
    ...checkRoutes({ routes, matrixKeys }),
    ...checkSourceNeedsTests({ files }),
    ...checkSecrets({ text: diffText }),
    ...checkEnvFile({ files }),
  ];
  return { passed: results.every((r) => r.ok), results };
}

module.exports = { runGate, checkTestCount, checkRoutes, checkSourceNeedsTests, checkSecrets, checkEnvFile, SECRET_PATTERNS };
