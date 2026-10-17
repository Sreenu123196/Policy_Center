'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Speech } = require('../src/speech');
const { createApi } = require('../src/api');
const { setup } = require('./helpers');
const { cookieFor } = require('./signin');

// Stand-in for Google's v2 SpeechClient: records the request and returns a scripted response.
function fakeGoogle(response, error) {
  const calls = [];
  return {
    calls,
    recognize: async (req) => {
      calls.push(req);
      if (error) throw error;
      return [response];
    },
  };
}

const config = { speechRegion: 'us', speechLanguages: ['en-IN', 'hi-IN', 'te-IN'], speechModel: 'chirp_3' };

test('speech: asks Google to detect the language among English, Hindi and Telugu', async () => {
  const google = fakeGoogle({ results: [{ alternatives: [{ transcript: 'J0000005 ब्लॉक क्यों है' }], languageCode: 'hi-IN' }] });
  const speech = new Speech({ client: google, projectId: 'my-proj', config });
  const audio = Buffer.from('RIFF-test-audio');
  const out = await speech.transcribe(audio);
  assert.deepEqual(out, { text: 'J0000005 ब्लॉक क्यों है', languageCode: 'hi-IN', language: 'Hindi' });
  const req = google.calls[0];
  assert.equal(req.recognizer, 'projects/my-proj/locations/us/recognizers/_');
  assert.deepEqual(req.config, { autoDecodingConfig: {}, languageCodes: ['en-IN', 'hi-IN', 'te-IN'], model: 'chirp_3' });
  assert.equal(req.content, audio);
});

test('speech: joins multi-part results and reports clear errors', async () => {
  const parts = fakeGoogle({ results: [{ alternatives: [{ transcript: 'naa daggara enni' }], languageCode: 'te-IN' }, { alternatives: [{ transcript: ' referrals unnayi' }] }] });
  const out = await new Speech({ client: parts, config }).transcribe(Buffer.from('x'));
  assert.equal(out.text, 'naa daggara enni referrals unnayi');
  assert.equal(out.language, 'Telugu');

  const silent = await new Speech({ client: fakeGoogle({ results: [] }), config }).transcribe(Buffer.from('x'));
  assert.equal(silent.text, '');

  const denied = new Speech({ client: fakeGoogle(null, Object.assign(new Error('denied'), { code: 7 })), config });
  await assert.rejects(denied.transcribe(Buffer.from('x')), /rejected the speech key/);
  await assert.rejects(denied.transcribe(Buffer.alloc(0)), /No audio/);
  await assert.rejects(denied.transcribe(Buffer.alloc(4 * 1024 * 1024)), /too long/);
});

test('speech: without a Google key it reports disabled so the browser mic is used', () => {
  const saved = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
  try {
    const s = new Speech({ config });
    assert.deepEqual(s.status(), { enabled: false, reason: 'GOOGLE_APPLICATION_CREDENTIALS is not set' });
  } finally {
    if (saved !== undefined) process.env.GOOGLE_APPLICATION_CREDENTIALS = saved;
  }
});

test('speech API: accepts raw WAV bytes and returns the transcript', async () => {
  const { pc, store } = setup();
  const google = fakeGoogle({ results: [{ alternatives: [{ transcript: 'mere kitne referrals pending hain' }], languageCode: 'en-IN' }] });
  const { auth, cookie } = cookieFor(pc, 'uw');
  const api = createApi(pc, store, { speech: new Speech({ client: google, config }), auth });
  const server = http.createServer((req, res) => { const u = new URL(req.url, 'http://x'); api(req, res, u.pathname, u.searchParams); });
  await new Promise((ok) => server.listen(0, ok));
  const base = `http://localhost:${server.address().port}/api`;
  try {
    const status = await (await fetch(`${base}/speech/status`, { headers: { Cookie: cookie } })).json();
    assert.equal(status.enabled, true);
    assert.deepEqual(status.languages, ['en-IN', 'hi-IN', 'te-IN']);
    const wav = Buffer.alloc(1500000, 7); // raw audio over the 1 MB JSON limit is accepted
    const res = await fetch(`${base}/speech`, { method: 'POST', headers: { 'Content-Type': 'audio/wav', Cookie: cookie }, body: wav });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).text, 'mere kitne referrals pending hain');
    assert.equal(google.calls[0].content.length, wav.length, 'audio bytes reach Google unchanged');
  } finally {
    server.close();
  }
});
