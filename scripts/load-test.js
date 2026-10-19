'use strict';
// Load test: how the simulator behaves with a book of business and several people at once.
//
//   node scripts/load-test.js [--policies=150] [--users=25] [--seconds=20] [--think=1000] [--check]
//
// It makes a throw-away data file with generated accounts and bound policies (scripts/generate-test-data.js), starts the
// server on it, signs in as the UW manager, and runs --users people at once for --seconds: 80% reading (desktop, search,
// a policy, claims, reports), 20% writing (take a payment, open a ticket, edit an account). A person pauses between requests
// (--think, milliseconds on average; use --think=0 to hammer the server with no pause, which finds the limit, not the normal
// load). It reports the time each kind
// of request took (median, 95th and 99th percentile), requests per second, errors, the server's memory and what saving
// the data costs. With --check it exits with 1 when a target in TARGETS is missed, so it can run in a pipeline.
//
// The targets are for ONE server on one machine, which is what the simulator is; they are not a promise for a real system.

const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? Number(hit.split('=')[1]) : fallback;
};
const POLICIES = arg('policies', 150);
const USERS = arg('users', 25);
const SECONDS = arg('seconds', 20);
const THINK = arg('think', 1000);
const CHECK = process.argv.includes('--check');
const PORT = 3400 + Math.floor(Math.random() * 400);

// Milliseconds, 95th percentile, for this many users.
const TARGETS = { read: 300, write: 600, errorRate: 0.001 }; // for the default profile: 150 policies, 25 people, a pause of a second

const root = path.join(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-load-'));
const dataFile = path.join(dir, 'policycenter.json');

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

async function main() {
  console.log(`Making a book of about ${POLICIES} policies...`);
  const started = Date.now();
  execFileSync(process.execPath, [path.join(__dirname, 'generate-test-data.js'), String(Math.ceil(POLICIES / 1.5))], { env: { ...process.env, DATA_FILE: dataFile }, stdio: ['ignore', 'ignore', 'inherit'] });
  console.log(`  done in ${((Date.now() - started) / 1000).toFixed(1)} s, file ${(fs.statSync(dataFile).size / 1048576).toFixed(1)} MB`);

  const server = spawn(process.execPath, [path.join(root, 'server.js')], { env: { ...process.env, PORT: String(PORT), DATA_FILE: dataFile }, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((resolve, reject) => {
    server.stdout.on('data', (d) => String(d).includes('running at') && resolve());
    server.on('exit', (code) => reject(new Error(`The server stopped (${code})`)));
    setTimeout(() => reject(new Error('The server did not start in 60 s')), 60000);
  });
  const base = `http://127.0.0.1:${PORT}/api`;

  // The data was generated without staff passwords: the first manager is set up through the app, as a real start would.
  const password = `Ld-${crypto.randomBytes(9).toString('hex')}!`;
  const login = await fetch(`${base}/auth/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'loadtest', password }) });
  if (!login.ok) throw new Error(`Could not set up the manager: ${login.status} ${await login.text()}`);
  const cookie = String(login.headers.get('set-cookie')).split(';')[0];
  const call = async (method, p, body) => {
    const res = await fetch(base + p, { method, headers: { Cookie: cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };

  const policies = (await call('GET', '/policies')).body.filter((p) => p.status === 'In Force');
  const accounts = (await call('GET', '/accounts')).body;
  if (!policies.length || !accounts.length) throw new Error('The generated book is empty');
  const pick = (list) => list[Math.floor(Math.random() * list.length)];
  const words = ['smith', 'garcia', 'park', 'oak', 'pa-', 'ho-', 'rivera', 'lee'];
  let counter = 0;

  const OPS = [
    ['read', 'desktop', 20, () => call('GET', '/desktop')],
    ['read', 'policy search', 20, () => call('GET', `/policies?q=${pick(words)}`)],
    ['read', 'account search', 10, () => call('GET', `/accounts?q=${pick(words)}`)],
    ['read', 'policy page', 20, () => call('GET', `/policies/${pick(policies).id}`)],
    ['read', 'claims list', 5, () => call('GET', '/claims')],
    ['read', 'billing report', 5, () => call('GET', '/reports/billing')],
    ['write', 'record payment', 10, () => call('POST', `/policies/${pick(policies).id}/payments`, { amount: 25, method: 'Cheque', reference: `LT-${crypto.randomUUID()}`, receivedOn: new Date().toISOString().slice(0, 10) })],
    ['write', 'open ticket', 6, () => call('POST', '/tickets', { accountId: pick(accounts).id, subject: `Load test ticket ${++counter}`, category: 'Other', priority: 'Low' })],
    ['write', 'edit account', 4, async () => { const a = pick(accounts); const full = (await call('GET', `/accounts/${a.id}`)).body; return call('PUT', `/accounts/${a.id}`, { ...full, phone: `555${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}` }); }],
  ];
  const total = OPS.reduce((s, o) => s + o[2], 0);
  const choose = () => { let r = Math.random() * total; for (const op of OPS) if ((r -= op[2]) < 0) return op; return OPS[0]; };

  const samples = Object.fromEntries(OPS.map((o) => [o[1], []]));
  const kinds = { read: [], write: [] };
  let errors = 0;
  const errorKinds = {};
  let done = 0;
  const stopAt = Date.now() + SECONDS * 1000;
  console.log(`${USERS} people at once for ${SECONDS} s, pausing ${THINK} ms on average between requests...`);
  const began = Date.now();
  await Promise.all(Array.from({ length: USERS }, async () => {
    while (Date.now() < stopAt) {
      const [kind, name, , run] = choose();
      const t0 = process.hrtime.bigint();
      let result;
      try { result = await run(); } catch { result = { status: 0 }; }
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      if (!(result.status >= 200 && result.status < 300)) {
        errors++;
        const key = `${name} -> ${result.status}${result.body && result.body.error ? ` ${String(result.body.error).slice(0, 60)}` : ''}`;
        errorKinds[key] = (errorKinds[key] || 0) + 1;
      }
      samples[name].push(ms);
      kinds[kind].push(ms);
      done++;
      if (THINK > 0) await new Promise((r) => setTimeout(r, THINK * (0.5 + Math.random())));
    }
  }));
  const elapsed = (Date.now() - began) / 1000;
  const metrics = (await call('GET', '/admin/metrics')).body;
  server.kill();
  fs.rmSync(dir, { recursive: true, force: true });

  const row = (name, list) => {
    const s = [...list].sort((a, b) => a - b);
    return `${name.padEnd(18)} ${String(s.length).padStart(7)} ${percentile(s, 50).toFixed(0).padStart(8)} ${percentile(s, 95).toFixed(0).padStart(8)} ${percentile(s, 99).toFixed(0).padStart(8)} ${(s[s.length - 1] || 0).toFixed(0).padStart(8)}`;
  };
  console.log(`\n${'request'.padEnd(18)} ${'count'.padStart(7)} ${'p50 ms'.padStart(8)} ${'p95 ms'.padStart(8)} ${'p99 ms'.padStart(8)} ${'max ms'.padStart(8)}`);
  for (const op of OPS) console.log(row(op[1], samples[op[1]]));
  console.log(row('ALL READS', kinds.read));
  console.log(row('ALL WRITES', kinds.write));
  const p95 = (list) => percentile([...list].sort((a, b) => a - b), 95);
  const errorRate = errors / Math.max(1, done);
  console.log(`\n${done} requests in ${elapsed.toFixed(1)} s = ${(done / elapsed).toFixed(0)} per second, ${errors} errors (${(errorRate * 100).toFixed(2)}%)`);
  for (const [kind, n] of Object.entries(errorKinds)) console.log(`  error: ${kind} x${n}`);
  console.log(`server: ${metrics.rssMb} MB memory, ${metrics.records.policies} policies, ${metrics.records.jobs} jobs; saving the data takes ${metrics.store.averageSaveMs} ms on average (worst ${metrics.store.maxSaveMs} ms), file ${metrics.store.fileMb} MB`);

  const misses = [];
  if (p95(kinds.read) > TARGETS.read) misses.push(`reads p95 ${p95(kinds.read).toFixed(0)} ms is over ${TARGETS.read} ms`);
  if (p95(kinds.write) > TARGETS.write) misses.push(`writes p95 ${p95(kinds.write).toFixed(0)} ms is over ${TARGETS.write} ms`);
  if (errorRate > TARGETS.errorRate) misses.push(`errors ${(errorRate * 100).toFixed(2)}% are over ${TARGETS.errorRate * 100}%`);
  console.log(misses.length ? `\nTargets missed:\n  ${misses.join('\n  ')}` : '\nAll targets met.');
  if (CHECK && misses.length) process.exit(1);
}

main().catch((err) => {
  console.error(err.message);
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(1);
});
