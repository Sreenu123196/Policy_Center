'use strict';
// Speech-to-text through Google Cloud Speech-to-Text v2 (Chirp 3) with automatic language detection.
// The browser records a short WAV clip; the server sends it to Google, which picks the language
// (English, Hindi or Telugu) by itself, so the user never has to choose one.
//
// Setup: a Google Cloud service-account key file whose path is in GOOGLE_APPLICATION_CREDENTIALS.
// Optional settings in chat.config.json: speechRegion ("us" or "eu"), speechLanguages, speechModel.

const fs = require('node:fs');
const path = require('node:path');
const { AppError } = require('./policyCenter');

const DEFAULTS = { speechEngine: 'whisper', whisperUrl: 'http://127.0.0.1:8178', speechRegion: 'us', speechLanguages: ['en-IN', 'hi-IN', 'te-IN'], speechModel: 'chirp_3' };
const MAX_AUDIO_BYTES = 3 * 1024 * 1024; // about 90 seconds of 16 kHz mono WAV
const LANGUAGE_NAMES = { 'en-in': 'English', 'hi-in': 'Hindi', 'te-in': 'Telugu', en: 'English', hi: 'Hindi', te: 'Telugu' };

function readSpeechConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'chat.config.json'), 'utf8'));
    return { ...DEFAULTS, ...Object.fromEntries(Object.entries(raw).filter(([k]) => k in DEFAULTS)) };
  } catch {
    return { ...DEFAULTS };
  }
}

class Speech {
  // Engines: "whisper" (default) runs on this computer through scripts/whisper_server.py;
  // "google" uses Google Cloud Speech (needs GOOGLE_APPLICATION_CREDENTIALS).
  constructor({ client, projectId, config, fetchImpl } = {}) {
    this.config = config || readSpeechConfig();
    this.reason = null;
    this.fetch = fetchImpl || ((...args) => fetch(...args));
    if (client) {
      this.engine = 'google';
      this.client = client;
      this.projectId = projectId || 'test-project';
      return;
    }
    if (this.config.speechEngine === 'whisper') {
      this.engine = 'whisper';
      this.whisperUrl = (process.env.WHISPER_URL || this.config.whisperUrl).replace(/\/$/, '');
      return;
    }
    this.engine = 'google';
    const keyFile = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    if (!keyFile) {
      this.reason = 'GOOGLE_APPLICATION_CREDENTIALS is not set';
      return;
    }
    let key;
    try {
      key = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
    } catch {
      this.reason = `Could not read the Google key file at ${keyFile}`;
      return;
    }
    const { v2 } = require('@google-cloud/speech');
    this.projectId = process.env.GOOGLE_CLOUD_PROJECT || key.project_id;
    this.client = new v2.SpeechClient({ apiEndpoint: `${this.config.speechRegion}-speech.googleapis.com` });
  }

  status() {
    if (this.engine === 'whisper') {
      return { enabled: true, provider: 'Local Whisper (this computer)', url: this.whisperUrl, languages: ['English', 'Hindi', 'Telugu'], model: process.env.WHISPER_MODEL || 'medium' };
    }
    return this.client
      ? { enabled: true, provider: 'Google Cloud Speech-to-Text', model: this.config.speechModel, languages: this.config.speechLanguages, region: this.config.speechRegion }
      : { enabled: false, reason: this.reason };
  }

  async transcribe(audio, options = {}) {
    if (this.engine === 'whisper') return this.transcribeLocal(audio, options);
    if (!this.client) throw new AppError(503, 'Cloud speech is not set up on the server');
    if (!audio || !audio.length) throw new AppError(422, 'No audio was received');
    if (audio.length > MAX_AUDIO_BYTES) throw new AppError(413, 'The recording is too long; keep it under about a minute');
    let response;
    try {
      [response] = await this.client.recognize({
        recognizer: `projects/${this.projectId}/locations/${this.config.speechRegion}/recognizers/_`,
        config: {
          autoDecodingConfig: {},
          languageCodes: this.config.speechLanguages,
          model: this.config.speechModel,
        },
        content: audio,
      });
    } catch (err) {
      // gRPC status codes: 3 invalid argument, 7 permission denied, 16 unauthenticated, 8 quota.
      if (err.code === 7 || err.code === 16) throw new AppError(502, 'Google rejected the speech key; check the service account has the Cloud Speech-to-Text API enabled');
      if (err.code === 8) throw new AppError(429, 'Google speech quota is used up; try again later');
      throw new AppError(502, `Google speech error: ${err.details || err.message}`);
    }
    const results = (response && response.results) || [];
    const text = results.map((r) => (r.alternatives && r.alternatives[0] ? r.alternatives[0].transcript : '')).join(' ').replace(/\s+/g, ' ').trim();
    const languageCode = (results.find((r) => r.languageCode) || {}).languageCode || null;
    return { text, languageCode, language: languageCode ? LANGUAGE_NAMES[languageCode.toLowerCase()] || languageCode : null };
  }
}

// Local Whisper: the browser's recording goes to the speech service on this computer, which detects the
// language itself. Nothing leaves the computer.
Speech.prototype.transcribeLocal = async function transcribeLocal(audio, options = {}) {
  if (!audio || !audio.length) throw new AppError(422, 'No audio was received');
  if (audio.length > MAX_AUDIO_BYTES) throw new AppError(413, 'The recording is too long; keep it under about a minute');
  let res;
  try {
    const hint = ['en', 'hi', 'te'].includes(options.language) ? `?language=${options.language}` : '';
    res = await this.fetch(`${this.whisperUrl}/transcribe${hint}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: audio });
  } catch {
    throw new AppError(503, 'The local speech service is not running. Start it in its own PowerShell window (see the README, "Local speech").');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new AppError(502, `Local speech error: ${data.error || res.status}`);
  const language = data.language || null;
  return { text: (data.text || '').trim(), languageCode: language, language: language ? LANGUAGE_NAMES[language.toLowerCase()] || language : null };
};

module.exports = { Speech, MAX_AUDIO_BYTES };
