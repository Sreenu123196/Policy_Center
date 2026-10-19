'use strict';
// PolicyCenter Simulator: HTTP server for the REST API and the browser UI.
//   node server.js            -> http://localhost:3000
//   PORT=4000 node server.js  -> custom port
//   DATA_FILE=... node server.js  -> custom data file

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { Store } = require('./src/store');
const { PolicyCenter } = require('./src/policyCenter');
const { createApi } = require('./src/api');
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
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json' };

const store = new Store(DATA_FILE);
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
const api = createApi(pc, store, { reseed, chatbot, speech, messaging, auth, bus });
bus.run(); // events written before this start

console.log(`Assistant: ${chatbot.status().mode} mode${chatbot.status().mode === 'claude' ? ` (${chatbot.status().model})` : ''}`);
const voice = speech.status();
console.log(`Voice input: ${voice.enabled ? voice.provider : `browser speech recognition (${voice.reason})`}`);

function serveStatic(pathname, res) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.resolve(PUBLIC, rel);
  if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Not found');
  }
  res.writeHead(200, { 'Content-Type': `${TYPES[path.extname(file)] || 'application/octet-stream'}; charset=utf-8`, 'Cache-Control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/') || url.pathname === '/api') return api(req, res, url.pathname, url.searchParams);
  if (req.method !== 'GET') {
    res.writeHead(405);
    return res.end();
  }
  serveStatic(url.pathname, res);
});

server.listen(PORT, () => console.log(`PolicyCenter Simulator running at http://localhost:${PORT}`));
