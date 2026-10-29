'use strict';
// Telling a person that an agent is waiting for a decision.
//
// Flow: an agent writes a suggestion that proposes an action (already stored in the same unit of work) -> this module sends
// a Telegram message with Approve / Dismiss buttons -> if nobody has decided after ESCALATE_MINUTES (default 10) it places
// a phone call that speaks the summary and takes a keypress -> the decision runs as the mapped person, exactly as if they
// had pressed the button in the app.
//
// The two outside services are transports, injected the same way src/messaging.js injects mail and WhatsApp, so every rule
// here is testable without a bot or a phone account. Nothing in this file acts on a policy: it only carries a decision to
// agents.decide(), which runs the action with the approver's authority.

const crypto = require('node:crypto');
const { AppError } = require('./appError');

const E164 = /^\+[1-9]\d{6,14}$/;
const xml = (value) => String(value == null ? '' : value).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));

// ------------------------------------------------------------------ transports

function telegramTransport({ token, chatId, fetchImpl = fetch } = {}) {
  return {
    channel: 'telegram',
    chatId: chatId ? String(chatId) : null,
    get configured() { return Boolean(token && chatId); },
    async send({ text, buttons }) {
      const payload = { chat_id: chatId, text, disable_web_page_preview: true };
      if (buttons) payload.reply_markup = { inline_keyboard: buttons };
      const res = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.ok === false) throw new Error(body.description || `Telegram refused the message (HTTP ${res.status})`);
      return { messageId: body.result ? body.result.message_id : null };
    },
    async answerCallback(callbackId, text) {
      await fetchImpl(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callback_query_id: callbackId, text, show_alert: false }),
      });
    },
  };
}

function twilioTransport({ accountSid, authToken, from, fetchImpl = fetch } = {}) {
  return {
    channel: 'voice',
    get configured() { return Boolean(accountSid && authToken && from); },
    async call({ to, url }) {
      if (!E164.test(String(to || ''))) throw new Error(`The approver's phone number must be in international form, +countrycode number: ${to}`);
      const body = new URLSearchParams({ To: to, From: from, Url: url, Method: 'GET' });
      const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
      const res = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls.json`, {
        method: 'POST',
        headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
      const answer = await res.json().catch(() => ({}));
      if (!res.ok || !answer.sid) throw new Error(answer.message || `Twilio refused the call (HTTP ${res.status})`);
      return { sid: answer.sid };
    },
  };
}

// Twilio signs its callbacks: HMAC-SHA1 over the URL and the sorted form fields, with the account's auth token.
function validTwilioSignature({ authToken, url, params, signature }) {
  if (!authToken || !signature) return false;
  const data = Object.keys(params).sort().reduce((acc, key) => acc + key + params[key], url);
  const expected = crypto.createHmac('sha1', authToken).update(Buffer.from(data, 'utf8')).digest('base64');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// What the call says and how it takes the answer.
function voiceTwiml({ text, actionUrl }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather numDigits="1" timeout="10" action="${xml(actionUrl)}" method="POST">
    <Say voice="alice" language="en-IN">${xml(text)}</Say>
    <Say voice="alice" language="en-IN">Press 1 to approve. Press 2 to dismiss.</Say>
  </Gather>
  <Say voice="alice" language="en-IN">No answer. The request stays in the app.</Say>
</Response>`;
}

// ------------------------------------------------------------------ the notifier

class Notifier {
  constructor(pc, { telegram = null, voice = null, clock = () => Date.now(), escalateMinutes = 10, approver = null, publicUrl = '', agents = null } = {}) {
    this.pc = pc;
    this.agents = agents;
    this.telegram = telegram;
    this.voice = voice;
    this.clock = clock;
    this.escalateMinutes = escalateMinutes;
    this.approverUsername = approver;
    this.publicUrl = String(publicUrl || '').replace(/\/+$/, '');
  }

  get db() {
    return this.pc.db;
  }

  get enabled() {
    return Boolean(this.telegram && this.telegram.configured);
  }

  status() {
    return {
      telegram: Boolean(this.telegram && this.telegram.configured),
      voice: Boolean(this.voice && this.voice.configured),
      escalateMinutes: this.escalateMinutes,
      approver: this.approverUsername || null,
    };
  }

  // The person a decision counts as. Their authority applies, so a manager-only action still needs the manager.
  approver() {
    const staff = this.approverUsername ? this.pc.staffByUsername(this.approverUsername) : this.db.staff.find((person) => person.role === 'UW Manager');
    if (!staff) throw new AppError(500, `The approver '${this.approverUsername || 'UW Manager'}' does not exist`);
    return staff;
  }

  // Two kinds of suggestion ask for a person: one that proposes an action (approve or dismiss it), and an escalation that
  // says a decision is needed but proposes nothing (send the link to the app). A compliance finding is information only.
  needsDecision(suggestion) {
    return Boolean(suggestion && suggestion.status === 'Open' && (suggestion.proposed || suggestion.kind === 'escalate'));
  }

  // An escalation cannot be approved from a phone: the decision belongs where the case is.
  decidable(suggestion) {
    return Boolean(suggestion && suggestion.proposed);
  }

  messageFor(suggestion) {
    const agent = this.pc.db.staff.find((person) => person.id === `ai-${suggestion.agentId}`);
    const name = agent ? agent.name : suggestion.agentId;
    const reasons = (suggestion.reasons || []).slice(0, 3).map((reason) => `- ${reason}`).join('\n');
    return `${name} needs your decision\n\n${suggestion.summary}\n\n${reasons}\n\n${suggestion.number}`;
  }

  buttonsFor(suggestion) {
    if (!this.decidable(suggestion)) return [[{ text: 'Open the app', url: this.publicUrl }]];
    return [[
      { text: 'Approve', callback_data: `d:${suggestion.number}:accept` },
      { text: 'Dismiss', callback_data: `d:${suggestion.number}:dismiss` },
    ]];
  }

  voiceTextFor(suggestion) {
    const agent = this.pc.db.staff.find((person) => person.id === `ai-${suggestion.agentId}`);
    const name = agent ? agent.name : suggestion.agentId;
    return `${name}. ${suggestion.summary}. ${((suggestion.reasons || [])[0] || '')}`.replace(/\s+/g, ' ').trim();
  }

  // One pass of the background work: send what is waiting, and call when the wait has been long enough.
  async work() {
    const now = this.clock();
    const open = this.db.agentSuggestions.filter((suggestion) => this.needsDecision(suggestion));
    const summary = { sent: 0, escalated: 0, failed: 0, skipped: 0 };

    for (const suggestion of open) {
      const notify = suggestion.notify || {};
      if (!notify.telegram && this.telegram && this.telegram.configured) {
        try {
          const sent = await this.telegram.send({ text: this.messageFor(suggestion), buttons: this.buttonsFor(suggestion) });
          this.record(suggestion.id, { telegram: { status: 'sent', at: now, messageId: sent.messageId || null, attempts: 1 } });
          summary.sent += 1;
        } catch (error) {
          this.record(suggestion.id, { telegram: { status: 'failed', at: now, error: error.message, attempts: ((notify.telegram && notify.telegram.attempts) || 0) + 1 } });
          summary.failed += 1;
        }
        continue;
      }
      const sentAt = notify.telegram && notify.telegram.at;
      if (!this.decidable(suggestion)) { summary.skipped += 1; continue; } // an escalation is a message, not a call
      if (notify.telegram && notify.telegram.status === 'sent' && sentAt && !notify.voice) {
        if (now - sentAt < this.escalateMinutes * 60000) { summary.skipped += 1; continue; }
        if (!this.voice || !this.voice.configured || !this.publicUrl) { summary.skipped += 1; continue; }
        try {
          const token = crypto.randomBytes(16).toString('hex');
          const url = `${this.publicUrl}/api/webhooks/twilio/voice?n=${encodeURIComponent(suggestion.number)}&t=${token}`;
          const called = await this.voice.call({ to: process.env.APPROVER_PHONE, url });
          this.record(suggestion.id, { voice: { status: 'called', at: now, sid: called.sid || null, token } });
          summary.escalated += 1;
        } catch (error) {
          this.record(suggestion.id, { voice: { status: 'failed', at: now, error: error.message } });
          summary.failed += 1;
        }
      }
    }
    return summary;
  }

  // Looked up again inside the unit of work: the copy read by the worker is the plain data, and a change made to that
  // would never be saved on the database store (the same mistake that lost a password once).
  record(suggestionId, patch) {
    this.pc.store.transaction(() => {
      const current = this.db.agentSuggestions.find((candidate) => candidate.id === suggestionId);
      if (current) current.notify = { ...(current.notify || {}), ...patch };
    });
  }

  // ------------------------------------------------------------------ the doors the outside world calls

  // Telegram sends the tap on a button here. The secret header is set when the webhook is registered (scripts/telegram-webhook.js).
  handleTelegramUpdate(update, { secret, expectedSecret } = {}) {
    if (!expectedSecret || secret !== expectedSecret) throw new AppError(401, 'Not this bot');
    // A plain message is a question, not a decision. Answered only for the configured approver chat.
    const incoming = update && update.message;
    if (incoming && incoming.text) {
      const fromChat = incoming.chat && String(incoming.chat.id);
      const allowed = this.telegram && this.telegram.chatId ? String(this.telegram.chatId) : null;
      if (!fromChat || (allowed && fromChat !== allowed)) throw new AppError(403, 'This chat may not ask questions');
      return { chat: { text: String(incoming.text), chatId: fromChat } };
    }
    const chatId = update && update.callback_query && update.callback_query.message && update.callback_query.message.chat
      ? String(update.callback_query.message.chat.id) : null;
    const configuredChat = this.telegram && this.telegram.chatId ? String(this.telegram.chatId) : null;
    if (!chatId || (configuredChat && chatId !== configuredChat)) throw new AppError(403, 'This chat may not decide');

    const data = String((update.callback_query && update.callback_query.data) || '');
    const match = /^d:(SUG-\d+):(accept|dismiss)$/.exec(data);
    if (!match) throw new AppError(422, 'Not a decision');
    const [, number, decision] = match;

    const user = this.approver();
    const result = this.pc.store.transaction(() => this.agents.decide(number, { decision, note: 'Decided from Telegram' }, user));
    this.pc.store.transaction(() => {
      const current = this.db.agentSuggestions.find((candidate) => candidate.number === number);
      if (current) current.notify = { ...(current.notify || {}), telegram: { ...((current.notify || {}).telegram || {}), answeredAt: this.clock(), answeredBy: user.username } };
    });
    return { ok: true, suggestion: result.number, status: result.status, by: user.name };
  }

  // Twilio asks what to say when the call connects.
  voiceScript(number, token) {
    const suggestion = this.db.agentSuggestions.find((candidate) => candidate.number === number);
    if (!suggestion) return null;
    if (!suggestion.notify || !suggestion.notify.voice || suggestion.notify.voice.token !== token) return null;
    if (suggestion.status !== 'Open') return null;
    const base = `${this.publicUrl}/api/webhooks/twilio/decision?n=${encodeURIComponent(number)}&t=${token}`;
    return { twiml: voiceTwiml({ text: this.voiceTextFor(suggestion), actionUrl: base }), suggestion };
  }

  // Twilio posts the keypress here. 1 approves, 2 dismisses; anything else says goodbye and leaves it open.
  handleVoiceKeypress({ number, token, digits, signature, params = {}, url } = {}) {
    const suggestion = this.db.agentSuggestions.find((candidate) => candidate.number === number);
    if (!suggestion || !suggestion.notify || !suggestion.notify.voice || suggestion.notify.voice.token !== token) {
      throw new AppError(404, 'This call is not for a waiting decision');
    }
    if (process.env.TWILIO_AUTH_TOKEN && !validTwilioSignature({ authToken: process.env.TWILIO_AUTH_TOKEN, url, params, signature })) {
      throw new AppError(401, 'Not from Twilio');
    }
    const key = String(digits || '');
    if (key === '9') return { repeat: true, suggestion };
    if (!['1', '2'].includes(key)) return { ignored: true, suggestion };
    if (suggestion.status !== 'Open') return { alreadyDecided: true, suggestion };
    const decision = key === '1' ? 'accept' : 'dismiss';
    const user = this.approver();
    const result = this.pc.store.transaction(() => this.agents.decide(number, { decision, note: 'Decided by phone' }, user));
    this.pc.store.transaction(() => {
      const current = this.db.agentSuggestions.find((candidate) => candidate.number === number);
      if (current) current.notify = { ...(current.notify || {}), voice: { ...((current.notify || {}).voice || {}), answeredAt: this.clock(), answeredBy: user.username, digits: key } };
    });
    return { ok: true, suggestion: result.number, status: result.status, by: user.name };
  }
}

// ------------------------------------------------------------------ from the environment

function notifierFromEnv(pc, { agents = null } = {}) {
  const telegram = telegramTransport({ token: process.env.TELEGRAM_BOT_TOKEN, chatId: process.env.TELEGRAM_CHAT_ID });
  // Bolna first when it is configured: it places an AI call and returns a transcript, where Twilio only plays TwiML and waits for a keypress.
  const bolnaVoice = process.env.BOLNA_API_KEY && process.env.BOLNA_AGENT_ID ? require('./bolnaVoice').createBolnaVoice() : null;
  const voice = bolnaVoice || twilioTransport({ accountSid: process.env.TWILIO_ACCOUNT_SID, authToken: process.env.TWILIO_AUTH_TOKEN, from: process.env.TWILIO_FROM_NUMBER });
  return new Notifier(pc, {
    agents,
    telegram,
    voice,
    escalateMinutes: process.env.ESCALATE_MINUTES === undefined ? 10 : Number(process.env.ESCALATE_MINUTES),
    approver: process.env.TELEGRAM_APPROVER || null,
    publicUrl: process.env.PUBLIC_URL || '',
  });
}

module.exports = {
  Notifier, notifierFromEnv, telegramTransport, twilioTransport, voiceTwiml, validTwilioSignature, E164,
};
