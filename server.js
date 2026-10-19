'use strict';
// PolicyCenter Simulator: HTTP server for the REST API and the browser UI.
//   node server.js            -> http://localhost:3000
//   PORT=4000 node server.js  -> custom port
//   DATA_FILE=... node server.js  -> custom data file

const http = require('node:http');
const path = require('node:path');
const { Store } = require('./src/store');
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

const PORT = Number(process.env.PORT) || 3000;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'policycenter.json');
const PUBLIC = path.join(__dirname, 'public');

const store = new Store(DATA_FILE, { reuseSnapshot: true });
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
const api = createApi(pc, store, { reseed, chatbot, speech, messaging, auth, bus, backupDir: BACKUP_DIR });
// Events written before this start (a backlog is worked off in batches, so this takes seconds, not minutes).
while (bus.run().some((r) => r.handled > 0 || r.deadLettered.length > 0)) { /* until every consumer has caught up */ }

console.log(`Assistant: ${chatbot.status().mode} mode${chatbot.status().mode === 'claude' ? ` (${chatbot.status().model})` : ''}`);
const voice = speech.status();
console.log(`Voice input: ${voice.enabled ? voice.provider : `browser speech recognition (${voice.reason})`}`);

const server = http.createServer(createHandler({ api, publicDir: PUBLIC, trustProxy: process.env.TRUST_PROXY === '1' }));

// A backup every BACKUP_HOURS (default 24; 0 turns it off), the newest BACKUP_KEEP (default 14) kept.
const BACKUP_HOURS = process.env.BACKUP_HOURS === undefined ? 24 : Number(process.env.BACKUP_HOURS);
if (BACKUP_HOURS > 0) {
  const backUp = () => {
    try { writeBackup(JSON.stringify(store.data), BACKUP_DIR, { keep: Number(process.env.BACKUP_KEEP) || 14 }); } catch (err) { console.error('The scheduled backup failed:', err.message); }
  };
  setTimeout(backUp, 60000).unref();
  setInterval(backUp, BACKUP_HOURS * 3600000).unref();
}

server.listen(PORT, () => console.log(`PolicyCenter Simulator running at http://localhost:${PORT}`));
