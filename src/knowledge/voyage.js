'use strict';
// Voyage embeddings over HTTPS, with the free tier's 3-requests-a-minute limit handled by batching and a wait.
// One module so the server and the CLI embed the same way, with the same model name.

const https = require('node:https');

const MODEL = 'voyage-4';

function postJson(host, urlPath, headers, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request({ host, path: urlPath, method: 'POST',
      headers: { ...headers, 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } },
    (res) => { let raw = ''; res.on('data', (c) => { raw += c; }); res.on('end', () => resolve({ status: res.statusCode, body: raw })); });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function embed(texts, inputType = 'document', attempt = 1) {
  const key = process.env.VOYAGE_API_KEY;
  if (!key) throw new Error('VOYAGE_API_KEY is not set');
  const res = await postJson('api.voyageai.com', '/v1/embeddings', { authorization: 'Bearer ' + key },
    { model: MODEL, input: texts, input_type: inputType });
  if (res.status === 429 && attempt <= 3) {
    await new Promise((r) => setTimeout(r, 21000));
    return embed(texts, inputType, attempt + 1);
  }
  if (res.status !== 200) throw new Error('voyage ' + res.status + ': ' + res.body.slice(0, 200));
  return JSON.parse(res.body).data.map((d) => d.embedding);
}

module.exports = { embed, MODEL };
