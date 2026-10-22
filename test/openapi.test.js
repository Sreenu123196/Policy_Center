'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./helpers');
const { buildSpec, toOpenApiPath, pathParams } = require('../src/openapi');
const { createApi } = require('../src/api');

// The contract is only useful if it matches the server. Both directions are asserted: every registered route appears in
// the spec, and every path in the spec is a route that exists.

const OPERATION = (route) => route.method.toLowerCase();

test('path patterns become OpenAPI paths', () => {
  assert.equal(toOpenApiPath('/policies/:id/payments'), '/policies/{id}/payments');
  assert.equal(toOpenApiPath('/health'), '/health');
  assert.deepEqual(pathParams('/claims/:id/exposures/:number/payments'), ['id', 'number']);
});

test('every registered route appears in the spec, and nothing else does', () => {
  const env = setup('2026-03-01');
  try {
    const spec = buildSpec(createApi(env.pc, env.store, {}).routes);
    for (const route of createApi(env.pc, env.store, {}).routes) {
      const path = toOpenApiPath(route.pattern);
      assert.ok(spec.paths[path], 'missing path in spec: ' + route.pattern);
      assert.ok(spec.paths[path][OPERATION(route)], 'missing operation: ' + route.method + ' ' + route.pattern);
    }
    const specCount = Object.values(spec.paths).reduce((sum, methods) => sum + Object.keys(methods).length, 0);
    assert.equal(specCount, createApi(env.pc, env.store, {}).routes.length, 'the spec has operations the server does not register');
  } finally {
    if (env.close) env.close();
  }
});

test('public routes carry no security requirement and the rest do', () => {
  const routes = [
    { method: 'GET', pattern: '/health', isPublic: true },
    { method: 'GET', pattern: '/policies', isPublic: false, readOnly: true },
  ];
  const spec = buildSpec(routes);
  assert.deepEqual(spec.paths['/health'].get.security, []);
  assert.deepEqual(spec.paths['/policies'].get.security, [{ cookieAuth: [] }]);
  assert.equal(spec.paths['/policies'].get.responses['403'].description, 'Refused by the role');
});

test('path parameters are declared as required strings', () => {
  const spec = buildSpec([{ method: 'GET', pattern: '/policies/:id' }]);
  const params = spec.paths['/policies/{id}'].get.parameters;
  assert.deepEqual(params, [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }]);
});
