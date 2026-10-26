'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildGraph, impactOf, summarise } = require('../src/dependencyGraph');

// A graph is only worth having if it answers "what breaks if I change this?" without being told what to look at.

const caps = [
  { id: 'home-contents-250', name: 'contents', coverage: 'contents', limit: 250000 },
  { id: 'home-dwelling-450', name: 'dwelling', coverage: 'dwelling', limit: 450000 },
];
const versions = [{ id: 'v3' }, { id: 'v4' }];
const policies = [
  { policyNumber: 'HO-0000001', productVersion: { id: 'v3' } },
  { policyNumber: 'HO-0000002', productVersion: { id: 'v3' } },
  { policyNumber: 'HO-0000003', productVersion: { id: 'v4' } },
];

test('a version reaches exactly the policies sold on it, and no others', () => {
  const graph = buildGraph({ policies, versions, caps });
  const impact = impactOf(graph, 'version:v3');
  assert.ok(impact.downstream.includes('policy:HO-0000001'));
  assert.ok(impact.downstream.includes('policy:HO-0000002'));
  assert.equal(impact.downstream.includes('policy:HO-0000003'), false, 'a policy on v4 is untouched');
});

test('a cap reaches the coverage that relies on it, and from there the policies', () => {
  const graph = buildGraph({ policies, versions, caps });
  const impact = impactOf(graph, 'cap:home-contents-250');
  assert.ok(impact.downstream.includes('coverage:HOPersonalPropertyCov'));
  assert.ok(impact.downstream.includes('policy:HO-0000001'));
  assert.ok(impact.downstream.includes('policy:HO-0000003'), 'a product-wide cap reaches policies on every version - the honest blast radius');
});

test('depth is reported, so a first-order break is distinguishable from a distant one', () => {
  const graph = buildGraph({ policies, versions, caps });
  const impact = impactOf(graph, 'version:v3');
  assert.equal(impact.depth['version:v3'], 0);
  assert.ok(impact.depth['policy:HO-0000001'] >= 1);
  assert.ok(impact.depth['policy:HO-0000001'] >= 1);
});

test('an unknown node impacts nothing rather than everything', () => {
  const graph = buildGraph({ policies, versions, caps });
  assert.deepEqual(impactOf(graph, 'clause:NOPE').downstream, []);
});

test('a cycle does not hang or duplicate', () => {
  const graph = { edges: new Map([['a', new Set(['b'])], ['b', new Set(['a'])], ['b', new Set(['a', 'c'])]]) };
  const impact = impactOf(graph, 'a');
  assert.deepEqual(impact.downstream.sort(), ['b', 'c']);
});

test('the summary counts nodes and edges', () => {
  const graph = buildGraph({ policies, versions, caps });
  const summary = summarise(graph);
  assert.ok(summary.nodes > 0 && summary.edges > 0);
});
