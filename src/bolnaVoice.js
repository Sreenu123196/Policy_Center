'use strict';
// B7/A11 voice escalation through Bolna instead of Twilio.
//
// The notifier asks a voice transport only to place a call: call({ to, url }). Bolna does not fetch TwiML from a URL - it runs a configured agent - so the approval context carried in
// that URL's query becomes the agent's variables, and the transcript comes back on Bolna's webhook rather than through a keypress.

const { createBolna } = require('./bolna');

function createBolnaVoice({ agentId = process.env.BOLNA_AGENT_ID, apiKey = process.env.BOLNA_API_KEY, fetchImpl = globalThis.fetch, bolna = null } = {}) {
  const client = bolna || createBolna({ apiKey, agentId, fetchImpl });
  async function call({ to, url } = {}) {
    if (!client.configured) throw new Error('Bolna is not configured: BOLNA_API_KEY or BOLNA_AGENT_ID is missing');
    if (!to) throw new Error('an approver number is required');
    let variables = { source: 'policycenter', actionUrl: url || null };
    try {
      const parsed = new URL(String(url), 'https://example.invalid');
      variables = { ...variables, approvalToken: parsed.searchParams.get('t'), action: parsed.searchParams.get('a') || 'decision' };
    } catch { /* a url we cannot read leaves the variables as they are */ }
    const result = await client.startCall({ to, variables });
    return { sid: result && (result.id || result.call_id || null), provider: 'bolna' };
  }
  return { call, configured: Boolean(client.configured) };
}

module.exports = { createBolnaVoice };
