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
const { notifierFromEnv } = require('./src/notifications');

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
  // Telling a person that an agent needs a decision: Telegram first, a phone call if nobody answers in time.
  const notifier = notifierFromEnv(pc, { agents });
  store.transaction(() => agents.ensureAccounts()); // each agent has its own account (it cannot sign in)
  bus.register('agents', (event) => agents.onEvent(event)); // an event wakes only the agents that listen for it
  // The knowledge assistant is optional: without a Voyage key or a database file, the app runs exactly as before and the
// two routes answer that the assistant is not configured.
let knowledge = null;
try {
  const { openKnowledgeStore } = require('./src/knowledge/store');
  const { createKnowledgeService } = require('./src/knowledge/serve');
  const { embed, MODEL: EMBED_MODEL } = require('./src/knowledge/voyage');
  const AnthropicSDK = require('@anthropic-ai/sdk');
  const Anthropic = AnthropicSDK.default || AnthropicSDK;
  const workspace = process.env.ANTHROPIC_WORKSPACE_ID;
  const client = new Anthropic(workspace ? { defaultHeaders: { 'anthropic-workspace-id': workspace } } : {});
  // A relative default, because a host is not this laptop: the previous default was a D:\ path, which would have failed silently on Linux.
const knowledgeStore = openKnowledgeStore(process.env.KNOWLEDGE_DB || path.join(__dirname, 'data', 'knowledge.db'));
  knowledge = createKnowledgeService({
    store: knowledgeStore, embedModel: EMBED_MODEL,
    embedder: (texts) => embed(texts, 'query'),
    client,
  });
  console.log('Knowledge assistant: ready (' + EMBED_MODEL + ')');
} catch (err) {
  console.log('Knowledge assistant: disabled - ' + err.message);
}

// The nightly drift run, only when sources are registered. A deployment with a scheduler should call
// GET /knowledge/drift instead and leave this off.
try {
  if (knowledge && process.env.KNOWLEDGE_SOURCES) {
    const { startNightlyDrift } = require('./src/knowledge/schedule');
    const sources = JSON.parse(process.env.KNOWLEDGE_SOURCES);
    startNightlyDrift({
      run: async () => {
        const report = await knowledge.runDrift(sources);
        console.log('Knowledge drift:', report.checked, 'checked,', report.drifted.length, 'changed');
      },
      onError: (err) => console.error('Knowledge drift failed:', err.message),
    });
    console.log('Knowledge drift: nightly at 02:00');
  }
} catch (err) {
  console.log('Knowledge drift: not scheduled -', err.message);
}

// The assistant is built before the knowledge service, so the handle is attached once both exist.
if (knowledge && chatbot) chatbot.knowledge = knowledge;
// The bind gate is always available: it does not depend on the knowledge database or on any key.
try {
  const { createBindGate } = require('./src/bindGate');
  chatbot.bindGate = createBindGate(pc, store);
} catch (err) {
  console.log('Bind gate: not configured -', err.message);
}

const api = createApi(pc, store, { reseed, chatbot, speech, messaging, auth, bus, backupDir: BACKUP_DIR, audit, agents, notifier, knowledge });
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

  const notify = notifier.status();
  if (notify.telegram) console.log(`Agent decisions: Telegram on, a call after ${notify.escalateMinutes} minutes${notify.voice ? ' (Twilio)' : ' (Twilio not configured, so no call)'}`);
  else if (notify.voice) console.log('Agent decisions: Twilio configured, but Telegram is not, so nothing is sent yet');

  // Every 15 seconds: send what is waiting, and call when the wait is over. This runs here, not in a request, because it
  // talks to Telegram and Twilio.
  const notifyTick = () => notifier.work().catch((err) => console.error('Agent notifications failed:', err.message));
  setInterval(notifyTick, 15000).unref();
  setTimeout(notifyTick, 5000).unref();

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
