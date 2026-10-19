'use strict';
// PolicyCenter Simulator: HTTP server for the REST API and the browser UI.
//   node server.js            -> http://localhost:3000
//   PORT=4000 node server.js  -> custom port
//   DATA_FILE=... node server.js  -> custom data file
//   DATABASE_URL=postgres://... node server.js  -> data in PostgreSQL instead of the JSON file (src/pg/open.js)

const { loadEnv } = require('./src/loadEnv');
loadEnv(); // settings from the .env file, if there is one
const http = require('node:http');
const path = require('node:path');
const { Store } = require('./src/store');
const { openStoreFromEnv } = require('./src/pg/open');
const { PolicyCenter } = require('./src/policyCenter');
const { createApi } = require('./src/api');
const { createHandler } = require('./src/webServer');
const { writeBackup } = require('./src/backup');
const { seed } = require('./src/seed');
const { Chatbot } = require('./src/chatbot');
const { Speech } = require('./src/speech');
const { Messaging, emailTransport, whatsappTransport } = require('./src/messaging');
const { Auth } = require('./src/auth');
const { EventBus } = require('./src/eventBus');
const { collectionsConsumer, claimsQueueConsumer, accountingConsumer } = require('./src/consumers');
const { Accounting } = require('./src/accounting');
const { AuditLog } = require('./src/audit');
const { AgentService } = require('./src/agents');

const PORT = Number(process.env.PORT) || 3000;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'policycenter.json');
const PUBLIC = path.join(__dirname, 'public');

async function main() {
  // Where the data lives. PostgreSQL when DATABASE_URL is set, the JSON file otherwise; opening the database creates or
  // repairs the tables and replays any change that was logged but not yet written (src/pg/postgresStore.js).
  const database = await openStoreFromEnv({ dataFile: DATA_FILE });
  const store = database || new Store(DATA_FILE, { reuseSnapshot: true });
  console.log(database
    ? `Data: PostgreSQL${process.env.DATABASE_URL === 'memory://' ? ' (in-process PGlite)' : ''}, ${store.data.policies.length} policies loaded`
    : `Data: ${DATA_FILE}`);

  const pc = new PolicyCenter(store);
  const reseed = () => seed(pc);
  if (store.isEmpty()) {
    store.transaction(reseed);
    console.log('Loaded demo data');
  }
  const chatbot = new Chatbot(pc);
  const speech = new Speech();
  const messaging = new Messaging(pc, { transports: { email: emailTransport(), whatsapp: whatsappTransport() } });
  const auth = new Auth(pc);
  const bus = new EventBus(pc);
  bus.register('collections', collectionsConsumer(pc));
  bus.register('claims-queue', claimsQueueConsumer(pc));
  bus.register('accounting', accountingConsumer(new Accounting(pc)));
  const BACKUP_DIR = process.env.BACKUP_DIR || path.join(path.dirname(DATA_FILE), 'backups');
  const mail = messaging.status().channels.email;
  console.log(mail.enabled ? `Email: sending from ${mail.from} through Gmail` : `Email: not set up (${mail.reason}); the email button opens Gmail instead`);
  const audit = new AuditLog(pc);
  const agents = new AgentService(pc, { audit });
  store.transaction(() => agents.ensureAccounts()); // each agent has its own account (it cannot sign in)
  bus.register('agents', (event) => agents.onEvent(event)); // an event wakes only the agents that listen for it
  const api = createApi(pc, store, { reseed, chatbot, speech, messaging, auth, bus, backupDir: BACKUP_DIR, audit, agents });
  // Events written before this start (a backlog is worked off in batches, so this takes seconds, not minutes).
  while (bus.run().some((r) => r.handled > 0 || r.deadLettered.length > 0)) { /* until every consumer has caught up */ }

  console.log(`Assistant: ${chatbot.status().mode} mode${chatbot.status().mode === 'claude' ? ` (${chatbot.status().model})` : ''}`);
  const voice = speech.status();
  console.log(`Voice input: ${voice.enabled ? voice.provider : `browser speech recognition (${voice.reason})`}`);

  // Sites allowed to call the API when a proxy serves the pages under another name (Netlify forwarding /api here):
  // ALLOWED_ORIGINS=https://policycenter.netlify.app,https://staging.example.com
  const allowedOrigins = String(process.env.ALLOWED_ORIGINS || '').split(',').map((value) => value.trim()).filter(Boolean);
  const server = http.createServer(createHandler({ api, publicDir: PUBLIC, trustProxy: process.env.TRUST_PROXY === '1', allowedOrigins }));

  // A backup every BACKUP_HOURS (default 24; 0 turns it off), the newest BACKUP_KEEP (default 14) kept.
  const BACKUP_HOURS = process.env.BACKUP_HOURS === undefined ? 24 : Number(process.env.BACKUP_HOURS);
  if (BACKUP_HOURS > 0) {
    const backUp = () => {
      try { writeBackup(JSON.stringify(store.data), BACKUP_DIR, { keep: Number(process.env.BACKUP_KEEP) || 14 }); } catch (err) { console.error('The scheduled backup failed:', err.message); }
    };
    setTimeout(backUp, 60000).unref();
    setInterval(backUp, BACKUP_HOURS * 3600000).unref();
  }

  // The agents also look at the whole book once a day (a renewal is due because time passed, not because something happened).
  // AGENT_SWEEP_HOURS=0 turns the sweep off. Agents that are switched off do nothing, and the rest only write suggestions.
  const SWEEP_HOURS = process.env.AGENT_SWEEP_HOURS === undefined ? 24 : Number(process.env.AGENT_SWEEP_HOURS);
  if (SWEEP_HOURS > 0) {
    const sweep = () => {
      try { store.transaction(() => agents.runAgents()); } catch (err) { console.error('The agent sweep failed:', err.message); }
    };
    setTimeout(sweep, 120000).unref();
    setInterval(sweep, SWEEP_HOURS * 3600000).unref();
  }

  server.listen(PORT, () => console.log(`PolicyCenter Simulator running at http://localhost:${PORT}`));

  // Stop cleanly: write what is still only in the write-ahead log before the process goes.
  const stop = async () => {
    server.close();
    try { if (typeof store.close === 'function') await store.close(); } catch (err) { console.error('Stopping the store failed:', err.message); }
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((err) => {
  console.error('The server could not start:', err.message);
  process.exit(1);
});
