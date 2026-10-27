'use strict';
// The one place Razorpay's HTTP shape is turned into fetch. The adapter stays injected and testable; this is what production supplies.

function createFetchTransport({ fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('a fetch implementation is required');
  return async function transport({ host, path, method = 'GET', headers = {}, body }) {
    // The adapter names its host without a scheme (api.razorpay.com), and fetch refuses a URL without one - found by creating a real order, not by a test.
    const base = /^https?:\/\//i.test(String(host)) ? String(host) : 'https://' + String(host);
    const response = await fetchImpl(base + String(path), { method, headers, body });
    // The adapter parses the text itself and treats a non-2xx status as a failure, so the transport only reports what happened.
    return { status: response.status, body: await response.text() };
  };
}

module.exports = { createFetchTransport };
