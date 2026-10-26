'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createAgentRegistry } = require('../src/agentRegistry');
const { createAops } = require('../src/aops');

// The registry is a system of record, so the tests ask the questions an auditor would: who is this agent, what may it authorise,
// and can it be stopped - including all of them at once.

const store = () => ({ data: { agents: [], seq: {} }, next(n) { this.data.seq[n] = (this.data.seq[n] || 0) + 1; return this.data.seq[n]; } });
const manager = { id: 'uwm', role: 'UW Manager' };

function world() {
  const s = store();
  return { registry: createAgentRegistry({ store: s, aops: createAops() }), store: s };
}

test('an agent is registered with its domain, actions and authority', () => {
  const { registry } = world();
  const agent = registry.register(manager, { name: 'bind-assistant', domain: 'underwriting', allowedActions: ['bind.approve'], authority: 250000 });
  assert.match(agent.id, /^AG-\d{5}$/);
  assert.equal(agent.status, 'running');
  assert.equal(agent.createdBy, 'uwm');
  assert.equal(registry.get(agent.id).name, 'bind-assistant');
});

test('a duplicate name is refused, and a missing name or domain too', () => {
  const { registry } = world();
  registry.register(manager, { name: 'a', domain: 'claims' });
  assert.throws(() => registry.register(manager, { name: 'a', domain: 'claims' }), /already exists/);
  assert.throws(() => registry.register(manager, { domain: 'claims' }), /name is required/);
  assert.throws(() => registry.register(manager, { name: 'b' }), /domain is required/);
});

test('an agent may act within its authority and is refused above it', () => {
  const { registry } = world();
  const agent = registry.register(manager, { name: 'binder', domain: 'underwriting', allowedActions: ['bind.approve'], authority: 250000 });
  assert.equal(registry.mayAct(agent.id, { action: 'bind.approve', role: 'Underwriter', amount: 100000 }).allowed, true);
  const over = registry.mayAct(agent.id, { action: 'bind.approve', role: 'Underwriter', amount: 300000 });
  assert.equal(over.allowed, false);
  assert.match(over.reason, /may authorise up to 250000/);
});

test('an action outside the agent\'s list is refused', () => {
  const { registry } = world();
  const agent = registry.register(manager, { name: 'binder', domain: 'underwriting', allowedActions: ['bind.approve'] });
  const result = registry.mayAct(agent.id, { action: 'claim.settle', role: 'UW Manager', amount: 0 });
  assert.equal(result.allowed, false);
  assert.match(result.reason, /not permitted to claim.settle/);
});

test('a stopped agent is refused immediately', () => {
  const { registry } = world();
  const agent = registry.register(manager, { name: 'binder', domain: 'underwriting' });
  registry.stop(manager, agent.id, 'wrong output');
  const result = registry.mayAct(agent.id, { action: 'claim.refer', role: 'Adjuster', amount: 1 });
  assert.equal(result.allowed, false);
  assert.match(result.reason, /is stopped/);
  assert.equal(agent.stoppedBy, 'uwm');
  assert.equal(agent.stopReason, 'wrong output');
});

test('the one-click stop stops every agent, and nothing may act until resumed', () => {
  const { registry } = world();
  const a = registry.register(manager, { name: 'a', domain: 'claims', authority: 1000 });
  const b = registry.register(manager, { name: 'b', domain: 'claims', authority: 1000 });
  const stopped = registry.stopAll(manager, 'incident');
  assert.equal(stopped.stopped, 2);
  assert.equal(registry.mayAct(a.id, { action: 'claim.refer', amount: 1 }).allowed, false);
  assert.equal(registry.mayAct(b.id, { action: 'claim.refer', amount: 1 }).allowed, false);
  registry.resumeAll(manager);
  assert.equal(registry.mayAct(a.id, { action: 'claim.refer', amount: 1 }).allowed, true);
});

test('the procedure still has the last word, even when the registry allows', () => {
  const { registry } = world();
  const agent = registry.register(manager, { name: 'settler', domain: 'claims', allowedActions: ['claim.settle'], authority: 999999 });
  const result = registry.mayAct(agent.id, { action: 'claim.settle', role: 'UW Manager', amount: 10 });
  assert.equal(result.allowed, false, 'paying a claim is reserved to a person');
  assert.match(result.reason, /reserves this to a person/);
});

test('an unknown agent looks missing', () => {
  const { registry } = world();
  assert.throws(() => registry.get('AG-99999'), /Agent not found/);
});
