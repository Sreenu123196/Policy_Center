'use strict';
// The API contract, generated from the routes the server actually registers.
//
// Generated rather than hand-written on purpose: a spec that is written by hand drifts from the code within a week, and
// then it documents an API that does not exist. The route table is the source of truth; this module only translates it.

const OPENAPI = '3.0.3';

/** '/policies/:id/payments' -> '/policies/{id}/payments' */
function toOpenApiPath(pattern) {
  return pattern.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

/** The path parameters a pattern declares, in order. */
function pathParams(pattern) {
  return [...pattern.matchAll(/:([A-Za-z0-9_]+)/g)].map((match) => match[1]);
}

/**
 * @param {Array<{method: string, pattern: string, isPublic?: boolean, readOnly?: boolean}>} routes
 * @param {{title?: string, version?: string, description?: string}} [info]
 * @returns {object} an OpenAPI 3 document
 */
function buildSpec(routes, info = {}) {
  const paths = {};
  for (const route of routes) {
    const method = String(route.method).toLowerCase();
    const path = toOpenApiPath(route.pattern);
    paths[path] = paths[path] || {};
    const parameters = pathParams(route.pattern).map((name) => ({
      name, in: 'path', required: true, schema: { type: 'string' },
    }));
    paths[path][method] = {
      operationId: method + path.replace(/[{}]/g, '').replace(/[^A-Za-z0-9]+/g, '_'),
      summary: (route.readOnly ? 'Read' : 'Change') + ': ' + route.pattern,
      tags: [route.pattern.split('/')[1] || 'root'],
      ...(parameters.length ? { parameters } : {}),
      security: route.isPublic ? [] : [{ cookieAuth: [] }],
      responses: route.isPublic
        ? { 200: { description: 'OK' } }
        : {
          200: { description: 'OK' },
          401: { description: 'Not signed in' },
          403: { description: 'Refused by the role' },
        },
    };
  }
  return {
    openapi: OPENAPI,
    info: {
      title: info.title || 'PolicyCenter Simulator API',
      version: info.version || '1.0.0',
      description: info.description || 'Every route the server registers, generated from the route table. Sign-in uses the session cookie.',
    },
    servers: [{ url: '/', description: 'This server' }],
    components: {
      securitySchemes: {
        cookieAuth: { type: 'apiKey', in: 'cookie', name: 'pc_session' },
      },
    },
    paths,
  };
}

module.exports = { buildSpec, toOpenApiPath, pathParams };
