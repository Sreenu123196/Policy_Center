'use strict';
// B26: a dependency graph for product changes.
//
// The question a change board asks is "if we touch this, what breaks?" - and until now nothing answered it. The graph is built from what
// is already stored: products and their versions, coverages that rely on a cap, and the policies that were sold on a given version.
// Impact is transitive, because a version change reaches coverages and from them the policies sold under it.

const { CAPS } = require('./policyCapsData');

// Coverage codes that rely on a cap name, so a cap change reaches the coverages that depend on it.
const COVERAGE_CAPS = {
  HODwellingCov: 'dwelling',
  HOPersonalPropertyCov: 'contents',
  HOScheduledJewelryCov: 'jewellery',
};

function buildGraph({ policies = [], versions = [], caps = CAPS } = {}) {
  const edges = new Map(); // from -> Set(to): "to depends on from"
  const add = (from, to) => {
    if (!edges.has(from)) edges.set(from, new Set());
    edges.get(from).add(to);
  };

  for (const cap of caps) {
    for (const [coverage, capName] of Object.entries(COVERAGE_CAPS)) {
      if (capName === cap.coverage || capName === cap.name) add('cap:' + cap.id, 'coverage:' + coverage);
    }
  }

  // A version change reaches the policies sold on that version, and nothing else: two versions of a product do not share policies.
  // A cap, by contrast, is product-wide, so every policy depends on the coverages a cap governs - see below.
  for (const version of versions) {
    for (const coverage of Object.keys(COVERAGE_CAPS)) add('version:' + version.id, 'coverage:' + coverage + '?' + version.id);
  }

  for (const policy of policies) {
    const versionId = policy.productVersion && (policy.productVersion.id || policy.productVersion.versionId);
    if (versionId) add('version:' + versionId, 'policy:' + policy.policyNumber);
    // Every sold policy relies on each coverage, so a cap change reaches all of them - which is the honest blast radius of a cap.
    for (const coverage of Object.keys(COVERAGE_CAPS)) add('coverage:' + coverage, 'policy:' + policy.policyNumber);
  }

  return { edges };
}

/** Everything downstream of a node, breadth first, without following a node twice. */
function impactOf(graph, nodeId, { maxDepth = 10 } = {}) {
  const start = graph.edges.has(nodeId) ? nodeId : null;
  if (!start) return { node: nodeId, downstream: [], depth: {} };
  const downstream = [];
  const depth = { [nodeId]: 0 };
  let frontier = [nodeId];
  for (let d = 1; d <= maxDepth && frontier.length; d += 1) {
    const next = [];
    for (const node of frontier) {
      for (const to of graph.edges.get(node) || []) {
        if (depth[to] !== undefined) continue; // a cycle or a repeated path: visit once
        depth[to] = d;
        downstream.push(to);
        next.push(to);
      }
    }
    frontier = next;
  }
  return { node: nodeId, downstream, depth };
}

function summarise(graph) {
  const nodes = new Set(graph.edges.keys());
  let edgeCount = 0;
  for (const tos of graph.edges.values()) { for (const to of tos) { nodes.add(to); edgeCount += 1; } }
  return { nodes: nodes.size, edges: edgeCount };
}

module.exports = { buildGraph, impactOf, summarise, COVERAGE_CAPS };
