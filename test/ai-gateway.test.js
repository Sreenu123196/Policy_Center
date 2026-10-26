'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createGateway } = require('../src/aiGateway');

// The gateway's promises: failover when a provider breaks, spend attributed per tenant, and a fallback that says it is offline.

const ok = (name, text = 'answer from ' + name, extra = {}) => ({ name, complete: async () => ({ text, ...extra }) });
const broken = (name) => ({ name, complete: async () => { throw new Error(name + ' is down'); } });

function freshStore() {
  return { data: {}, next(n) { n; return 1; } };
}

test('the first provider answers when it is healthy', async () => {
  const gateway = createGateway({ providers: [ok('primary')], store: freshStore() });
  const result = await gateway.complete({ tenant: 't1', prompt: 'hello' });
  assert.equal(result.provider, 'primary');
  assert.equal(result.offline, false);
  assert.equal(result.text, 'answer from primary');
});

test('a broken provider falls through to the next, and the failures are recorded', async () => {
  const gateway = createGateway({ providers: [broken('primary'), ok('secondary')], store: freshStore() });
  const result = await gateway.complete({ tenant: 't1', prompt: 'hello' });
  assert.equal(result.provider, 'secondary');
  assert.equal(result.attempts.length, 1);
  assert.match(result.attempts[0].error, /primary is down/);
});

test('when every provider fails the fallback answers and is marked offline', async () => {
  const gateway = createGateway({ providers: [broken('a'), broken('b')], store: freshStore() });
  const result = await gateway.complete({ tenant: 't1', prompt: 'hello' });
  assert.equal(result.offline, true);
  assert.equal(result.provider, 'local');
  assert.match(result.text, /unavailable/);
  assert.equal(result.attempts.length, 2);
});

test('a custom fallback is used when given, and still marked offline', async () => {
  const gateway = createGateway({
    providers: [broken('a')], store: freshStore(),
    fallback: () => 'Offline: here is the wording you already have.',
  });
  const result = await gateway.complete({ prompt: 'hi' });
  assert.equal(result.offline, true);
  assert.match(result.text, /Offline/);
});

test('spend is attributed per tenant, with token counts and a provider split', async () => {
  const store = freshStore();
  const gateway = createGateway({ providers: [ok('primary', 'x'.repeat(40), { tokensIn: 1000, tokensOut: 2000 })], store });
  await gateway.complete({ tenant: 'acme', prompt: 'a' });
  await gateway.complete({ tenant: 'acme', prompt: 'b' });
  await gateway.complete({ tenant: 'beta', prompt: 'c' });
  const acme = gateway.usageFor('acme');
  assert.equal(acme.calls, 2);
  assert.equal(acme.tokensIn, 2000);
  assert.equal(acme.cost > 0, true);
  assert.equal(gateway.usageFor('beta').calls, 1);
  const all = gateway.usageAll();
  assert.equal(all.totalCost > 0, true);
  assert.deepEqual(Object.keys(all.tenants).sort(), ['acme', 'beta']);
});

test('the offline path costs nothing and is counted as the local provider', async () => {
  const store = freshStore();
  const gateway = createGateway({ providers: [broken('a')], store });
  await gateway.complete({ tenant: 'acme', prompt: 'hello' });
  const usage = gateway.usageFor('acme');
  assert.equal(usage.cost, 0, 'the fallback is free');
  assert.equal(usage.byProvider.local, 1);
});

test('a prompt is required, and a gateway needs at least one provider', async () => {
  assert.throws(() => createGateway({ providers: [] }), /at least one provider/);
  const gateway = createGateway({ providers: [ok('p')], store: freshStore() });
  await assert.rejects(() => gateway.complete({}), /a prompt is required/);
});

// --- sovereign mode (B20) ---------------------------------------------------------------------------------------

test('in sovereign mode no provider is contacted at all', async () => {
  let called = 0;
  const spy = { name: 'cloud', complete: async () => { called += 1; return { text: 'should not happen' }; } };
  const gateway = createGateway({ providers: [spy], store: { data: {} }, sovereign: true });
  const result = await gateway.complete({ tenant: 't1', prompt: 'hello' });
  assert.equal(called, 0, 'the provider was never called');
  assert.equal(result.sovereign, true);
  assert.equal(result.offline, true);
  assert.match(result.text, /Sovereign mode/);
  assert.equal(result.attempts[0].provider, 'sovereign');
});

test('with sovereign mode off the same gateway uses its providers', async () => {
  let called = 0;
  const spy = { name: 'cloud', complete: async () => { called += 1; return { text: 'from the cloud' }; } };
  const gateway = createGateway({ providers: [spy], store: { data: {} }, sovereign: false });
  const result = await gateway.complete({ prompt: 'hello' });
  assert.equal(called, 1);
  assert.equal(result.sovereign, undefined);
});

test('the sovereign path is free and recorded as local', async () => {
  const store = { data: {} };
  const gateway = createGateway({ providers: [], fallback: () => 'local answer', store, sovereign: true });
  await gateway.complete({ tenant: 'airgap', prompt: 'hi' });
  const usage = gateway.usageFor('airgap');
  assert.equal(usage.cost, 0);
  assert.equal(usage.byProvider.local, 1);
});
