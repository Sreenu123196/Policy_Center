'use strict';
// Customer messages: email and WhatsApp, with templates in English, Hindi and Telugu.
//
// Nothing is sent unless the user confirms the recipient and message in the app (confirm: true), the
// channel is configured, and the customer is one the user may see. Every attempt is saved on the
// customer's record, including failures.
//
// Email: Gmail over SMTP with an App Password (GMAIL_USER, GMAIL_APP_PASSWORD).
// WhatsApp: Meta WhatsApp Cloud API (WHATSAPP_TOKEN, WHATSAPP_PHONE_ID). WhatsApp only allows
// business-initiated messages with templates that Meta has approved; the approved text must match
// TEMPLATES below, and the variables must be in the order listed in `params`.

const { AppError } = require('./policyCenter');

const LANGUAGES = { en: 'English', hi: 'Hindi', te: 'Telugu' };
const CHANNELS = ['email', 'whatsapp'];

// {name}, {policyNumber}, {expirationDate}, {premium}, {claimNumber}, {claimStatus}, {paidAmount} are filled in.
const TEMPLATES = {
  renewal: {
    label: 'Renewal reminder',
    params: ['name', 'policyNumber', 'expirationDate', 'premium'],
    en: {
      subject: 'Renewal of your policy {policyNumber}',
      body: 'Dear {name}, your policy {policyNumber} ends on {expirationDate}. The estimated renewal premium is {premium}. Reply to this message or call your agent to renew. Thank you.',
    },
    hi: {
      subject: 'आपकी पॉलिसी {policyNumber} का नवीनीकरण',
      body: 'नमस्ते {name}, आपकी पॉलिसी {policyNumber} {expirationDate} को समाप्त होगी। अनुमानित नवीनीकरण प्रीमियम {premium} है। नवीनीकरण के लिए इस संदेश का उत्तर दें या अपने एजेंट से संपर्क करें। धन्यवाद।',
    },
    te: {
      subject: 'మీ పాలసీ {policyNumber} పునరుద్ధరణ',
      body: 'నమస్కారం {name}, మీ పాలసీ {policyNumber} {expirationDate}న ముగుస్తుంది. అంచనా పునరుద్ధరణ ప్రీమియం {premium}. పునరుద్ధరించుకోవడానికి ఈ సందేశానికి బదులివ్వండి లేదా మీ ఏజెంట్‌ను సంప్రదించండి. ధన్యవాదాలు.',
    },
  },
  lapse: {
    label: 'Lapse warning',
    params: ['name', 'policyNumber', 'expirationDate'],
    en: {
      subject: 'Policy {policyNumber} has not been renewed',
      body: 'Dear {name}, your policy {policyNumber} ended on {expirationDate} and has not been renewed. Cover can stop without renewal. Please contact your agent today to avoid a gap in your cover.',
    },
    hi: {
      subject: 'पॉलिसी {policyNumber} का नवीनीकरण नहीं हुआ है',
      body: 'नमस्ते {name}, आपकी पॉलिसी {policyNumber} {expirationDate} को समाप्त हो गई है और उसका नवीनीकरण नहीं हुआ है। नवीनीकरण के बिना कवरेज रुक सकता है। कृपया आज ही अपने एजेंट से संपर्क करें।',
    },
    te: {
      subject: 'పాలసీ {policyNumber} పునరుద్ధరించలేదు',
      body: 'నమస్కారం {name}, మీ పాలసీ {policyNumber} {expirationDate}న ముగిసింది, ఇంకా పునరుద్ధరించలేదు. పునరుద్ధరించకపోతే కవరేజ్ ఆగిపోవచ్చు. దయచేసి ఈరోజే మీ ఏజెంట్‌ను సంప్రదించండి.',
    },
  },
  claim_update: {
    label: 'Claim update',
    params: ['name', 'claimNumber', 'policyNumber', 'claimStatus', 'paidAmount'],
    en: {
      subject: 'Update on claim {claimNumber}',
      body: 'Dear {name}, there is an update on your claim {claimNumber} under policy {policyNumber}. Current status: {claimStatus}. Paid so far: {paidAmount}. Please contact us if you have any questions.',
    },
    hi: {
      subject: 'क्लेम {claimNumber} पर अपडेट',
      body: 'नमस्ते {name}, आपके क्लेम {claimNumber} (पॉलिसी {policyNumber}) पर अपडेट है। वर्तमान स्थिति: {claimStatus}। अब तक भुगतान: {paidAmount}। किसी भी प्रश्न के लिए हमसे संपर्क करें।',
    },
    te: {
      subject: 'క్లెయిమ్ {claimNumber} పై అప్‌డేట్',
      body: 'నమస్కారం {name}, మీ క్లెయిమ్ {claimNumber} (పాలసీ {policyNumber})పై అప్‌డేట్ ఉంది. ప్రస్తుత స్థితి: {claimStatus}. ఇప్పటివరకు చెల్లించినది: {paidAmount}. ఏవైనా ప్రశ్నలకు మమ్మల్ని సంప్రదించండి.',
    },
  },
};

const fill = (text, vars) => text.replace(/\{(\w+)\}/g, (_, key) => (vars[key] !== undefined && vars[key] !== null ? String(vars[key]) : `{${key}}`));

// Phone numbers: digits only. A 10-digit number is treated as an Indian mobile (+91).
function normalizePhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length === 10) return `91${digits}`;
  if (digits.length >= 11 && digits.length <= 15) return digits;
  return null;
}

const CLAIM_STATUS_WORDS = {
  Submitted: { en: 'Submitted', hi: 'जमा किया गया', te: 'సమర్పించబడింది' },
  'Under Review': { en: 'Under review', hi: 'समीक्षा में', te: 'సమీక్షలో ఉంది' },
  'Documents Pending': { en: 'Documents needed', hi: 'दस्तावेज़ बाकी हैं', te: 'పత్రాలు అవసరం' },
  Approved: { en: 'Approved', hi: 'स्वीकृत', te: 'ఆమోదించబడింది' },
  Rejected: { en: 'Rejected', hi: 'अस्वीकृत', te: 'తిరస్కరించబడింది' },
  Settled: { en: 'Settled', hi: 'निपटाया गया', te: 'పరిష్కరించబడింది' },
};

const money = (n) => (n === undefined || n === null ? '' : '$' + Number(n).toFixed(2));

class Messaging {
  constructor(pc, { transports } = {}) {
    this.pc = pc;
    this.transports = transports || {};
  }

  status() {
    const out = {};
    for (const channel of CHANNELS) {
      const t = this.transports[channel];
      out[channel] = t ? t.status() : { enabled: false, reason: 'not set up on the server' };
    }
    return { channels: out, templates: Object.entries(TEMPLATES).map(([key, t]) => ({ key, label: t.label, languages: Object.keys(LANGUAGES) })), languages: LANGUAGES };
  }

  // Variables for a customer message, from the customer, the policy and the claim the user may see.
  variables(user, { accountId, policyId, claimId }) {
    const account = this.pc.account(accountId, user);
    const vars = { name: this.pc.accountName(account) };
    if (policyId) {
      const policy = this.pc.policy(policyId, user);
      const last = this.pc.lastTerm(policy);
      vars.policyNumber = policy.policyNumber;
      vars.expirationDate = last.expirationDate;
      vars.premium = money(last.latest.quote.premium + last.latest.quote.taxes);
    }
    if (claimId) {
      const claim = this.pc.claimDetail(claimId, user);
      vars.claimNumber = claim.claimNumber;
      vars.claimStatusKey = claim.status;
      vars.paidAmount = money(claim.paid);
      if (!policyId) vars.policyNumber = claim.policyNumber;
    }
    return { account, vars };
  }

  render(input, user) {
    const template = TEMPLATES[input.template];
    if (!template) throw new AppError(422, `Template must be one of ${Object.keys(TEMPLATES).join(', ')}`);
    const language = input.language || 'en';
    if (!LANGUAGES[language]) throw new AppError(422, `Language must be one of ${Object.keys(LANGUAGES).join(', ')}`);
    const channel = input.channel || 'email';
    if (!CHANNELS.includes(channel)) throw new AppError(422, `Channel must be email or whatsapp`);
    if (template.params.includes('claimNumber') && !input.claimId) throw new AppError(422, 'This template needs a claim');
    if (template.params.includes('policyNumber') && !input.policyId && !input.claimId) throw new AppError(422, 'This template needs a policy');
    const { account, vars } = this.variables(user, input);
    if (vars.claimStatusKey) vars.claimStatus = CLAIM_STATUS_WORDS[vars.claimStatusKey][language];
    const text = template[language];
    const missing = template.params.filter((k) => vars[k] === undefined);
    if (missing.length) throw new AppError(422, `Missing details for this message: ${missing.join(', ')}`);
    return {
      channel, template: input.template, language, accountId: account.id, policyId: input.policyId || null, claimId: input.claimId || null,
      to: channel === 'email' ? account.email : normalizePhone(account.phone),
      subject: fill(text.subject, vars),
      body: fill(text.body, vars),
      params: template.params.map((k) => vars[k]),
      vars,
    };
  }

  preview(input, user) {
    const m = this.render(input, user);
    return { channel: m.channel, template: m.template, language: m.language, to: m.to, subject: m.channel === 'email' ? m.subject : null, body: m.body };
  }

  send(input, user) {
    if (input.confirm !== true) throw new AppError(422, 'Check the recipient and message, then confirm before sending');
    const m = this.render(input, user);
    const transport = this.transports[m.channel];
    const st = transport ? transport.status() : { enabled: false, reason: 'not set up on the server' };
    if (!st.enabled) throw new AppError(422, `${m.channel === 'email' ? 'Email' : 'WhatsApp'} is not set up: ${st.reason}`);
    if (!m.to) throw new AppError(422, m.channel === 'email' ? 'This customer has no email address' : 'This customer needs a valid phone number (digits, with country code for non-Indian numbers)');
    const record = {
      id: this.pc.store.id('msg'), messageNumber: this.pc.store.number('MSG-', 7),
      accountId: m.accountId, policyId: m.policyId, claimId: m.claimId,
      channel: m.channel, template: m.template, language: m.language, to: m.to,
      subject: m.channel === 'email' ? m.subject : null, body: m.body,
      status: 'Sent', providerId: null, error: null, sentBy: user.id, sentByName: user.name, sentAt: this.pc.now(),
    };
    try {
      const res = transport.send({ to: m.to, subject: m.subject, text: m.body, template: m.template, language: m.language, params: m.params });
      record.providerId = res && res.id ? res.id : null;
    } catch (err) {
      record.status = 'Failed';
      record.error = err.message;
    }
    this.pc.db.messages.push(record);
    return record;
  }

  messagesFor(accountId, user) {
    this.pc.account(accountId, user);
    return this.pc.db.messages
      .filter((x) => x.accountId === accountId)
      .sort((a, b) => b.sentAt.localeCompare(a.sentAt));
  }
}

// Real transports, built from environment variables. Nothing is sent without them.
function emailTransport(env = process.env, nodemailer = require('nodemailer')) {
  const user = env.GMAIL_USER;
  const pass = String(env.GMAIL_APP_PASSWORD || '').replace(/s+/g, ''); // Google shows the app password in groups of four
  if (!user || !pass) return { status: () => ({ enabled: false, reason: 'set GMAIL_USER and GMAIL_APP_PASSWORD' }), send: () => { throw new Error('Email is not set up'); } };
  const transporter = nodemailer.createTransport({ host: 'smtp.gmail.com', port: 587, secure: false, auth: { user, pass } });
  const from = env.EMAIL_FROM_NAME ? `"${env.EMAIL_FROM_NAME}" <${user}>` : user;
  return {
    status: () => ({ enabled: true, from: user }),
    send: async ({ to, subject, text, html }) => {
      const info = await transporter.sendMail({ from, to, subject, text, ...(html ? { html } : {}) });
      return { id: info.messageId };
    },
  };
}

function whatsappTransport(env = process.env) {
  const token = env.WHATSAPP_TOKEN;
  const phoneId = env.WHATSAPP_PHONE_ID;
  const version = env.WHATSAPP_API_VERSION || 'v20.0';
  if (!token || !phoneId) return { status: () => ({ enabled: false, reason: 'set WHATSAPP_TOKEN and WHATSAPP_PHONE_ID' }), send: () => { throw new Error('WhatsApp is not set up'); } };
  return {
    status: () => ({ enabled: true, phoneNumberId: phoneId }),
    send: async ({ to, template, language, params }) => {
      const res = await fetch(`https://graph.facebook.com/${version}/${phoneId}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messaging_product: 'whatsapp', to, type: 'template',
          template: { name: template, language: { code: language }, components: [{ type: 'body', parameters: params.map((text) => ({ type: 'text', text: String(text) })) }] },
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`WhatsApp refused the message: ${(data.error && data.error.message) || res.status}`);
      return { id: data.messages && data.messages[0] ? data.messages[0].id : null };
    },
  };
}

module.exports = { Messaging, TEMPLATES, LANGUAGES, CHANNELS, normalizePhone, emailTransport, whatsappTransport, fill };
