'use strict';
// Policy documents in English, Hindi or Telugu, with an electronic signature and delivery by email or WhatsApp.
//
//   render   the document as HTML (self-contained, printable) and plain text, in the language asked for. The fixed wording is
//            translated (DOC_LABELS, DOC_NAMES); names, numbers, dates, money and the names of covers are shown as they are.
//            Everything that came from a person is escaped, so it is shown as text and never run as markup.
//   sign     the insured signs by typing their name and agreeing. The signed copy (the exact HTML the signer saw, with the
//            signature block) is stored with its SHA-256, and from then on that copy is what the document is: later changes to
//            the policy, or a request for another language, do not alter it.
//   verify   says whether a signed copy still matches its fingerprint.
//   deliver  sends the document to the customer: by email as the HTML itself, by WhatsApp as the approved template
//            "document_ready" (WhatsApp only allows business-initiated template messages; the approved text must match
//            DOC_WHATSAPP). Every attempt, including a failure, is saved on the customer's messages.

const crypto = require('node:crypto');
const { AppError } = require('./policyCenter');
const { normalizePhone } = require('./messaging');

const LANGUAGES = ['en', 'hi', 'te'];

const DOC_LABELS = {
  en: {
    company: 'Simulated Mutual Insurance Company', policyNumber: 'Policy number', documentNumber: 'Document number', product: 'Product', insured: 'Named insured',
    address: 'Address', policyPeriod: 'Policy period', to: 'to', transaction: 'Transaction', effective: 'effective', producer: 'Producer', paymentPlan: 'Payment plan',
    premiumTitle: 'Premium', coverage: 'Cover', amount: 'Amount', premium: 'Premium', taxes: 'Taxes', fees: 'Fees', total: 'Total term cost', rateBook: 'Rate book',
    cancellationEffective: 'Cancellation effective', reason: 'Reason', returnPremium: 'Return premium', signedBy: 'Signed electronically by', signedOn: 'on',
    signatureNote: 'By typing their name and agreeing, the signer accepted this document as shown above.', issuedFor: 'issued to',
  },
  hi: {
    company: 'सिम्युलेटेड म्यूचुअल इंश्योरेंस कंपनी', policyNumber: 'पॉलिसी संख्या', documentNumber: 'दस्तावेज़ संख्या', product: 'उत्पाद', insured: 'नामित बीमाधारक',
    address: 'पता', policyPeriod: 'पॉलिसी अवधि', to: 'से', transaction: 'लेन-देन', effective: 'प्रभावी', producer: 'प्रोड्यूसर', paymentPlan: 'भुगतान योजना',
    premiumTitle: 'प्रीमियम', coverage: 'कवर', amount: 'राशि', premium: 'प्रीमियम', taxes: 'कर', fees: 'शुल्क', total: 'अवधि की कुल लागत', rateBook: 'दर पुस्तिका',
    cancellationEffective: 'रद्दीकरण प्रभावी', reason: 'कारण', returnPremium: 'वापसी प्रीमियम', signedBy: 'इलेक्ट्रॉनिक रूप से हस्ताक्षरकर्ता', signedOn: 'दिनांक',
    signatureNote: 'अपना नाम लिखकर और सहमति देकर हस्ताक्षरकर्ता ने इस दस्तावेज़ को ऊपर दिखाए अनुसार स्वीकार किया।', issuedFor: 'जारी किया गया',
  },
  te: {
    company: 'సిమ్యులేటెడ్ మ్యూచువల్ ఇన్సూరెన్స్ కంపెనీ', policyNumber: 'పాలసీ నంబర్', documentNumber: 'పత్రం నంబర్', product: 'ఉత్పత్తి', insured: 'పేరున్న బీమాదారు',
    address: 'చిరునామా', policyPeriod: 'పాలసీ కాలం', to: 'నుండి', transaction: 'లావాదేవీ', effective: 'అమలు', producer: 'ప్రొడ్యూసర్', paymentPlan: 'చెల్లింపు ప్రణాళిక',
    premiumTitle: 'ప్రీమియం', coverage: 'కవర్', amount: 'మొత్తం', premium: 'ప్రీమియం', taxes: 'పన్నులు', fees: 'రుసుములు', total: 'కాలవ్యవధి మొత్తం ఖర్చు', rateBook: 'రేట్ బుక్',
    cancellationEffective: 'రద్దు అమలు', reason: 'కారణం', returnPremium: 'తిరిగి ఇచ్చే ప్రీమియం', signedBy: 'ఎలక్ట్రానిక్‌గా సంతకం చేసినవారు', signedOn: 'తేదీ',
    signatureNote: 'తమ పేరు టైప్ చేసి అంగీకరించడం ద్వారా సంతకం చేసినవారు ఈ పత్రాన్ని పైన చూపిన విధంగా అంగీకరించారు.', issuedFor: 'జారీ చేయబడింది',
  },
};

const DOC_NAMES = {
  en: { 'Declarations Page': 'Declarations Page', 'Auto ID Cards': 'Auto ID Cards', 'Evidence of Insurance': 'Evidence of Insurance', 'Policy Change Endorsement': 'Policy Change Endorsement', 'Renewal Declarations Page': 'Renewal Declarations Page', 'Notice of Cancellation': 'Notice of Cancellation', 'Notice of Reinstatement': 'Notice of Reinstatement' },
  hi: { 'Declarations Page': 'घोषणा पृष्ठ', 'Auto ID Cards': 'ऑटो आईडी कार्ड', 'Evidence of Insurance': 'बीमा का प्रमाण', 'Policy Change Endorsement': 'पॉलिसी परिवर्तन पृष्ठांकन', 'Renewal Declarations Page': 'नवीनीकरण घोषणा पृष्ठ', 'Notice of Cancellation': 'रद्दीकरण की सूचना', 'Notice of Reinstatement': 'पुनर्बहाली की सूचना' },
  te: { 'Declarations Page': 'డిక్లరేషన్స్ పేజీ', 'Auto ID Cards': 'ఆటో ఐడి కార్డ్‌లు', 'Evidence of Insurance': 'బీమా రుజువు', 'Policy Change Endorsement': 'పాలసీ మార్పు ఎండార్స్‌మెంట్', 'Renewal Declarations Page': 'పునరుద్ధరణ డిక్లరేషన్స్ పేజీ', 'Notice of Cancellation': 'రద్దు నోటీసు', 'Notice of Reinstatement': 'పునరుద్ధరణ నోటీసు' },
};

// The text of the WhatsApp template "document_ready" that Meta must approve, in each language. {{1}} is the customer's name,
// {{2}} the document name, {{3}} the policy number.
const DOC_WHATSAPP = {
  en: 'Dear {{1}}, your {{2}} for policy {{3}} is ready. Please contact your agent to receive it.',
  hi: 'नमस्ते {{1}}, पॉलिसी {{3}} के लिए आपका {{2}} तैयार है। इसे प्राप्त करने के लिए कृपया अपने एजेंट से संपर्क करें।',
  te: 'నమస్కారం {{1}}, పాలసీ {{3}} కోసం మీ {{2}} సిద్ధంగా ఉంది. దాన్ని పొందడానికి దయచేసి మీ ఏజెంట్‌ను సంప్రదించండి.',
};

const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const money = (n) => `${n < 0 ? '-' : ''}$${Math.abs(Number(n)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const normalName = (s) => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();
const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

const STYLE = 'body{font-family:"Segoe UI","Nirmala UI","Noto Sans Devanagari","Noto Sans Telugu",Arial,sans-serif;max-width:760px;margin:24px auto;padding:0 16px;color:#1c2733;line-height:1.5}h1{font-size:22px;margin:4px 0}.co{color:#5d6b7a;font-size:13px}dl{display:grid;grid-template-columns:200px 1fr;gap:6px 16px}dt{color:#4a5766}dd{margin:0}table{border-collapse:collapse;width:100%;margin-top:12px}th,td{border-bottom:1px solid #dde3ea;padding:6px 8px;text-align:left}td.n,th.n{text-align:right}tfoot td{font-weight:700}.sig{margin-top:24px;border:1px solid #17703c;border-radius:6px;padding:10px 14px}.sig small{color:#4a5766}';

class Documents {
  constructor(pc, messaging) {
    this.pc = pc;
    this.messaging = messaging;
  }

  find(user, docId) {
    const doc = this.pc.db.documents.find((d) => d.id === docId || d.documentNumber === docId);
    if (!doc) throw new AppError(404, 'Document not found');
    const policy = this.pc.policy(doc.policyId, user); // 404 when the person may not see the customer
    return { doc, policy, account: this.pc.account(policy.accountId, user) };
  }

  language(value) {
    const language = value || 'en';
    if (!LANGUAGES.includes(language)) throw new AppError(422, `Language must be one of ${LANGUAGES.join(', ')}`);
    return language;
  }

  // The document built from the policy as it is now, in the language asked for.
  build(doc, policy, account, language) {
    const L = DOC_LABELS[language];
    const title = (DOC_NAMES[language] || {})[doc.name] || doc.name;
    const version = doc.versionId ? policy.versions.find((v) => v.versionId === doc.versionId) : null;
    const insured = this.pc.accountName(account);
    const address = account.address ? `${account.address.line1}, ${account.address.city}, ${account.address.state} ${account.address.zip}` : '';
    const rows = [[L.policyNumber, policy.policyNumber], [L.documentNumber, doc.documentNumber], [L.insured, insured], [L.address, address]];
    let section = '';
    const text = [];
    if (version) {
      const q = version.quote;
      rows.push([L.policyPeriod, `${version.effectiveDate} ${L.to} ${version.expirationDate}`], [L.transaction, `${version.jobType} ${version.jobNumber}, ${L.effective} ${version.editEffectiveDate}`],
        [L.producer, version.period.producerCode], [L.paymentPlan, version.period.paymentPlan]);
      section = `<h2>${esc(L.premiumTitle)}</h2><table><thead><tr><th>${esc(L.coverage)}</th><th class="n">${esc(L.amount)}</th></tr></thead><tbody>${
        q.costs.map((c) => `<tr><td>${esc(c.coverageName)}${c.coverable && c.coverable !== 'Policy' ? ` <small>(${esc(c.coverable)})</small>` : ''}</td><td class="n">${esc(money(c.amount))}</td></tr>`).join('')
      }</tbody><tfoot><tr><td>${esc(L.premium)}</td><td class="n">${esc(money(q.premium))}</td></tr><tr><td>${esc(L.taxes)}</td><td class="n">${esc(money(q.taxes))}</td></tr>${q.fees ? `<tr><td>${esc(L.fees)}</td><td class="n">${esc(money(q.fees))}</td></tr>` : ''}<tr><td>${esc(L.total)}</td><td class="n">${esc(money(q.total))}</td></tr></tfoot></table><p class="co">${esc(L.rateBook)}: ${esc(q.rateBook.code)} ${esc(q.rateBook.version)}</p>`;
      text.push(`${L.total}: ${money(q.total)}`);
    } else {
      const c = policy.cancellation || ((policy.reinstatements || []).slice(-1)[0] || {}).cancellation || {};
      rows.push([L.cancellationEffective, c.effectiveDate || '—'], [L.reason, c.reasonName || '—'], [L.returnPremium, c.refund ? money(-c.refund) : '—']);
    }
    const html = `<!doctype html><html lang="${language}"><head><meta charset="utf-8"><title>${esc(title)} · ${esc(policy.policyNumber)}</title><style>${STYLE}</style></head><body>`
      + `<div class="co">${esc(L.company)}</div><h1>${esc(title)}</h1>`
      + `<dl>${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>${section}</body></html>`;
    const plain = [`${L.company}`, title, ...rows.map(([k, v]) => `${k}: ${v}`), ...text].join('\n');
    return { title, html, text: plain };
  }

  render(user, docId, { language } = {}) {
    const { doc, policy, account } = this.find(user, docId);
    if (doc.signature) {
      // A signed document is what was signed, whatever the policy or the request says now.
      const sig = doc.signature;
      return { title: this.build(doc, policy, account, sig.language).title, language: sig.language, html: sig.signedHtml, text: sig.signedHtml.replace(/<style>[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(), signed: true };
    }
    const lang = this.language(language);
    return { ...this.build(doc, policy, account, lang), language: lang, signed: false };
  }

  sign(user, docId, input = {}) {
    const { doc, policy, account } = this.find(user, docId);
    if (doc.signature) throw new AppError(409, 'This document is already signed');
    if (input.consent !== true) throw new AppError(422, 'The signer must agree to sign');
    const insured = this.pc.accountName(account);
    if (normalName(input.signerName) !== normalName(insured)) throw new AppError(422, 'The signer name must match the named insured');
    const language = this.language(input.language);
    const L = DOC_LABELS[language];
    const signedAt = this.pc.now();
    const base = this.build(doc, policy, account, language);
    const block = `<div class="sig"><strong>${esc(L.signedBy)} ${esc(insured)}</strong> ${esc(L.signedOn)} ${esc(signedAt)}<br><small>${esc(L.signatureNote)}</small></div>`;
    const signedHtml = base.html.replace('</body>', `${block}</body>`);
    doc.signature = { id: this.pc.store.id('sig'), signerName: insured, signedAt, language, method: 'typed_name', capturedBy: user.id, contentHash: sha256(signedHtml), signedHtml };
    this.pc.publish('DocumentSigned', { policyNumber: policy.policyNumber, documentNumber: doc.documentNumber, language });
    return { id: doc.signature.id, signerName: insured, signedAt, language, method: 'typed_name', capturedBy: user.id, contentHash: doc.signature.contentHash };
  }

  verify(user, docId) {
    const { doc } = this.find(user, docId);
    if (!doc.signature) return { signed: false };
    const sig = doc.signature;
    return { signed: true, valid: sha256(sig.signedHtml) === sig.contentHash, signerName: sig.signerName, signedAt: sig.signedAt, language: sig.language };
  }

  deliver(user, docId, input = {}) {
    if (input.confirm !== true) throw new AppError(422, 'Check the recipient and the document, then confirm before sending');
    const { doc, policy, account } = this.find(user, docId);
    const channel = input.channel || 'email';
    if (!['email', 'whatsapp'].includes(channel)) throw new AppError(422, 'Channel must be email or whatsapp');
    const language = this.language(input.language || (doc.signature && doc.signature.language));
    const transport = this.messaging && this.messaging.transports[channel];
    const status = transport ? transport.status() : { enabled: false, reason: 'not set up on the server' };
    if (!status.enabled) throw new AppError(422, `${channel === 'email' ? 'Email' : 'WhatsApp'} is not set up: ${status.reason}`);
    const to = channel === 'email' ? account.email : normalizePhone(account.phone);
    if (!to) throw new AppError(422, channel === 'email' ? 'This customer has no email address' : 'This customer needs a valid phone number');
    const rendered = this.render(user, docId, { language });
    const name = this.pc.accountName(account);
    const record = {
      id: this.pc.store.id('msg'), messageNumber: this.pc.store.number('MSG-', 7), accountId: account.id, policyId: policy.id, claimId: null,
      channel, template: 'document', language: rendered.language, to, documentNumber: doc.documentNumber, status: 'Sent', providerId: null, error: null, sentBy: user.id, sentByName: user.name, sentAt: this.pc.now(),
    };
    try {
      const res = channel === 'email'
        ? transport.send({ to, subject: `${rendered.title} · ${policy.policyNumber}`, text: rendered.text, html: rendered.html, template: 'document', language: rendered.language })
        : transport.send({ to, template: 'document_ready', language: rendered.language, params: [name, rendered.title, policy.policyNumber] });
      record.providerId = res && res.id ? res.id : null;
    } catch (err) {
      record.status = 'Failed';
      record.error = err.message;
    }
    this.pc.db.messages.push(record);
    return record;
  }
}

module.exports = { Documents, DOC_LABELS, DOC_NAMES, DOC_WHATSAPP, LANGUAGES };
