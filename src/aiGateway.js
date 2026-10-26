'use strict';
// B10: one door for model calls, with failover and a cost ledger.
//
// Every model call in the product goes through here for three reasons: a provider that is down must not take the feature with it,
// spend must be attributable to a tenant, and there must be a zero-cost path so a demo, a test or an air-gapped install still works.
// The fallback is deterministic text, not a silent stub: the reply says it is offline, so nobody mistakes it for a model answer.

const round6 = (value) => Math.round((Number(value) + Number.EPSILON) * 1e6) / 1e6;

// Cost per million tokens, in rupees. Placeholder rates: the point is that spend is attributed, not that these are today's prices.
const DEFAULT_COSTS = {
  'deepseek-official': { in: 12, out: 24 },
  anthropic: { in: 180, out: 900 },
  local: { in: 0, out: 0 },
  // Unknown providers are charged at the default rate, not zero: a provider nobody priced must not look free.
  default: { in: 180, out: 900 },
};

function createGateway({ providers, fallback, costs = DEFAULT_COSTS, store = null, now = () => new Date().toISOString() } = {}) {
  if (!Array.isArray(providers) || providers.length === 0) throw new Error('at least one provider is required');
  const usage = () => {
    if (!store) return { tenants: {} };
    store.data.aiUsage = store.data.aiUsage || { tenants: {} };
    return store.data.aiUsage;
  };

  function record(tenant, provider, tokensIn, tokensOut) {
    const rate = costs[provider] || costs.default || { in: 180, out: 900 };
    const cost = round6((tokensIn / 1e6) * rate.in + (tokensOut / 1e6) * rate.out);
    const book = usage();
    const entry = book.tenants[tenant] || { calls: 0, tokensIn: 0, tokensOut: 0, cost: 0, byProvider: {} };
    entry.calls += 1;
    entry.tokensIn += tokensIn;
    entry.tokensOut += tokensOut;
    entry.cost = round6(entry.cost + cost);
    entry.byProvider[provider] = (entry.byProvider[provider] || 0) + 1;
    book.tenants[tenant] = entry;
    return { provider, tokensIn, tokensOut, cost };
  }

  /**
   * @param {{tenant?: string, prompt: string, model?: string}} input
   * @returns {Promise<{text: string, provider: string, offline: boolean, attempts: Array<{provider: string, error: string}>}>}
   */
  async function complete({ tenant = 'default', prompt, model } = {}) {
    if (!prompt) throw new Error('a prompt is required');
    const attempts = [];
    for (const provider of providers) {
      try {
        const result = await provider.complete({ prompt, model });
        const text = result && result.text;
        if (!text) throw new Error('the provider returned no text');
        const tokensIn = result.tokensIn !== undefined ? result.tokensIn : Math.ceil(prompt.length / 4);
        const tokensOut = result.tokensOut !== undefined ? result.tokensOut : Math.ceil(text.length / 4);
        record(tenant, provider.name, tokensIn, tokensOut);
        return { text, provider: provider.name, offline: false, attempts };
      } catch (err) {
        attempts.push({ provider: provider.name, error: err.message });
      }
    }
    // Nothing worked: answer from the offline path, and say so. The customer-facing text must never look like a sourced answer.
    const text = typeof fallback === 'function' ? fallback({ prompt, tenant, attempts }) : 'The AI service is unavailable right now. Please try again, or ask a person.';
    record(tenant, 'local', Math.ceil(prompt.length / 4), Math.ceil(String(text).length / 4));
    return { text: String(text), provider: 'local', offline: true, attempts };
  }

  function usageFor(tenant) {
    return usage().tenants[tenant] || { calls: 0, tokensIn: 0, tokensOut: 0, cost: 0, byProvider: {} };
  }

  function usageAll() {
    const book = usage();
    const total = Object.values(book.tenants).reduce((sum, t) => round6(sum + t.cost), 0);
    return { tenants: book.tenants, totalCost: total };
  }

  return { complete, usageFor, usageAll, costs };
}

module.exports = { createGateway, DEFAULT_COSTS, round6 };
