'use strict';
// One-time setup for the Telegram half: point the bot at this deployment and give it the secret to check.
//
//   TELEGRAM_BOT_TOKEN=... TELEGRAM_WEBHOOK_SECRET=... PUBLIC_URL=https://policycenter-api.onrender.com node scripts/telegram-webhook.js
//   node scripts/telegram-webhook.js --info     (what is registered now)
const { loadEnv } = require('../src/loadEnv');
loadEnv();

const token = process.env.TELEGRAM_BOT_TOKEN;
const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
const publicUrl = String(process.env.PUBLIC_URL || '').replace(/\/+$/, '');

async function call(method, body) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const answer = await res.json().catch(() => ({}));
  if (!res.ok || answer.ok === false) throw new Error(answer.description || `Telegram answered HTTP ${res.status}`);
  return answer.result;
}

(async () => {
  if (!token) {
    console.error('TELEGRAM_BOT_TOKEN is not set.');
    process.exit(1);
  }
  if (process.argv.includes('--info')) {
    console.log(JSON.stringify(await call('getWebhookInfo', {}), null, 2));
    return;
  }
  if (!secret) {
    console.error('TELEGRAM_WEBHOOK_SECRET is not set: without it anyone could post fake decisions.');
    process.exit(1);
  }
  if (!/^https:\/\//.test(publicUrl)) {
    console.error('PUBLIC_URL must be the https address of this server, e.g. https://policycenter-api.onrender.com');
    process.exit(1);
  }
  const result = await call('setWebhook', {
    url: `${publicUrl}/api/webhooks/telegram`,
    secret_token: secret,
    allowed_updates: ['callback_query'],
    drop_pending_updates: true,
  });
  console.log(`Webhook registered: ${publicUrl}/api/webhooks/telegram (${JSON.stringify(result)})`);
})().catch((error) => {
  console.error('The webhook could not be registered:', error.message);
  process.exit(1);
});
