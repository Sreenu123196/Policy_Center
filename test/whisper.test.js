'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Speech } = require('../src/speech');

// Stand-in for the local Whisper service: records each request and returns a scripted answer.
function fakeWhisper(reply, { down = false, status = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    if (down) throw new TypeError('fetch failed');
    calls.push({ url, opts });
    return new Response(JSON.stringify(reply), { status, headers: { 'Content-Type': 'application/json' } });
  };
  return { calls, fetchImpl };
}

const config = { speechEngine: 'whisper', whisperUrl: 'http://127.0.0.1:8178', speechRegion: 'us', speechLanguages: [], speechModel: 'chirp_3' };

test('whisper: the recording goes to the local service and the detected language comes back', async () => {
  const { calls, fetchImpl } = fakeWhisper({ text: 'నా దగ్గర ఎన్ని referrals ఉన్నాయి', language: 'te', probability: 0.97 });
  const speech = new Speech({ config, fetchImpl });
  assert.equal(speech.engine, 'whisper');
  const audio = Buffer.from('RIFF-test-audio');
  const out = await speech.transcribe(audio);
  assert.equal(out.text, 'నా దగ్గర ఎన్ని referrals ఉన్నాయి');
  assert.equal(out.languageCode, 'te');
  assert.equal(out.language, 'Telugu');
  assert.equal(calls[0].url, 'http://127.0.0.1:8178/transcribe');
  assert.equal(calls[0].opts.method, 'POST');
  assert.equal(calls[0].opts.body, audio);
});

test('whisper: Hindi and English are named correctly; no language picker is needed', async () => {
  const hi = await new Speech({ config, fetchImpl: fakeWhisper({ text: 'मेरे पास कितने referrals हैं', language: 'hi' }).fetchImpl }).transcribe(Buffer.from('x'));
  assert.equal(hi.language, 'Hindi');
  const en = await new Speech({ config, fetchImpl: fakeWhisper({ text: 'How many referrals', language: 'en' }).fetchImpl }).transcribe(Buffer.from('x'));
  assert.equal(en.language, 'English');
});

test('whisper: a service that is not running gives a clear message', async () => {
  const speech = new Speech({ config, fetchImpl: fakeWhisper({}, { down: true }).fetchImpl });
  await assert.rejects(speech.transcribe(Buffer.from('x')), /local speech service is not running/);
});

test('whisper: a service error is reported, and empty or huge audio is refused', async () => {
  const speech = new Speech({ config, fetchImpl: fakeWhisper({ error: 'model failed' }, { status: 500 }).fetchImpl });
  await assert.rejects(speech.transcribe(Buffer.from('x')), /model failed/);
  await assert.rejects(speech.transcribe(Buffer.alloc(0)), /No audio/);
  await assert.rejects(speech.transcribe(Buffer.alloc(4 * 1024 * 1024)), /too long/);
});

test('whisper: status says it runs on this computer', () => {
  const st = new Speech({ config, fetchImpl: fakeWhisper({}).fetchImpl }).status();
  assert.equal(st.enabled, true);
  assert.match(st.provider, /Local Whisper/);
});
