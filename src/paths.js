'use strict';
// Version prefixes on the way in.
//
// The design asks for /v1/knowledge/... while the application routes are unprefixed and clients also call /api/...
// Rather than register every route twice - which would double the route table, the permission matrix and the OpenAPI
// contract - the prefix is removed before routing, so /v1/policies, /api/policies and /policies are the same route.

/** @returns {string} the route path with a single /api and /v1 prefix removed */
function normalizePath(pathname) {
  return String(pathname || '')
    .replace(/^\/api(?=\/|$)/, '')
    .replace(/^\/v1(?=\/|$)/, '') || '/';
}

module.exports = { normalizePath };
