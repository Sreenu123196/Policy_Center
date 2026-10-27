'use strict';
// Bolna voice calls, behind an injected transport.
//
// The request shapes here follow Bolna's published call API as understood at the time of writing; they are collected in one place at the top so that
// confirming them against the live documentation is a one-line change rather than a hunt through call sites. Nothing is sent unless a key is present,
// and no test touches the network.
//
// What this adapter does NOT do: invent a call outcome. A webhook that does not say "completed" is recorded as it came, and a transcript that is absent
// stays absent.

const { AppError } = require('./appError');

const DEFAULTS = {
  baseUrl: 'https://api.bolna.ai',
  // Verify these three paths against Bolna's API reference before production.
  startPath: '/call',
  statusPath: (id) => '/call/' + encodeURIComponent(id),
};

function createBolna({ apiKey = process.env.BOLNA_API_KEY, agentId = process.env.BOLNA_AGENT_ID, baseUrl = DEFAULTS.baseUrl, fetchImpl = globalThis.fetch, startPath = DEFAULTS.startPath, statusPath = DEFAULTS.statusPath } = {}) {
  const requireKey = () => {
    if (!apiKey) throw new AppError(503, 'Bolna is not configured: BOLNA_API_KEY is missing.');
  };
  if (typeof fetchImpl !== 'function') throw new Error('a fetch implementation is required');

  async function request(path, { method = 'GET', body } = {}) {
    requireKey();
    const response = await fetchImpl(baseUrl.replace(/\/$/, '') + path, {
      method,
      headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let json;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    if (!response.ok) throw new AppError(502, 'Bolna refused the request (' + response.status + '): ' + (json && json.message ? json.message : text.slice(0, 120)));
    return json;
  }

  /** Place an outbound call about a claim or a renewal, carrying the variables the script needs. */
  async function startCall({ to, variables = {}, from } = {}) {
    if (!to) throw new AppError(422, 'a recipient number is required');
    if (!agentId) throw new AppError(503, 'Bolna is not configured: BOLNA_AGENT_ID is missing.');
    const payload = { agent_id: agentId, recipient_phone_number: String(to), user_data: variables };
    if (from) payload.from_phone_number = String(from);
    return request(startPath, { method: 'POST', body: payload });
  }

  async function getCall(callId) {
    if (!callId) throw new AppError(422, 'a call id is required');
    return request(statusPath(callId));
  }

  /** Keep only what the application can act on, and keep the status verbatim rather than mapping it to a nicer word. */
  function parseWebhook(body = {}) {
    const callId = body.call_id || body.id || (body.data && body.data.call_id) || null;
    if (!callId) throw new AppError(422, 'the webhook carries no call id');
    const transcript = body.transcript || body.conversation || (body.data && body.data.transcript) || null;
    return {
      callId,
      status: body.status || (body.data && body.data.status) || null,
      transcript,
      durationSeconds: body.duration !== undefined ? Number(body.duration) : null,
      recordingUrl: body.recording_url || null,
      endedAt: body.ended_at || null,
    };
  }

  return { startCall, getCall, parseWebhook, configured: Boolean(apiKey && agentId), DEFAULTS };
}

module.exports = { createBolna, DEFAULTS };
