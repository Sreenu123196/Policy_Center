import { z } from 'zod';
import type { Route } from './registry.js';

// Writes the OpenAPI 3.1 description (document section 17) from the route registry, so it always matches the API.

type Json = Record<string, unknown>;

function jsonSchema(schema: z.ZodType): Json {
  const converted = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Json;
  delete converted.$schema;
  return converted;
}

const errorRef = (description: string): Json => ({ description, content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } });

function operation(route: Route): Json {
  const parameters: Json[] = [];
  for (const [, name] of route.path.matchAll(/\{(\w+)\}/g)) parameters.push({ name, in: 'path', required: true, schema: { type: 'string' } });
  if (route.query) {
    const schema = jsonSchema(route.query);
    const required = (schema.required as string[] | undefined) ?? [];
    for (const [name, property] of Object.entries((schema.properties as Record<string, Json> | undefined) ?? {})) {
      parameters.push({ name, in: 'query', required: required.includes(name), schema: property });
    }
  }
  if (route.method === 'POST') {
    parameters.push({
      name: 'Idempotency-Key',
      in: 'header',
      required: true,
      description: 'A key chosen by the client. Repeating the request with the same key gives the same answer and does the work once.',
      schema: { type: 'string', minLength: 1 },
    });
  }
  if (route.ifMatch) {
    parameters.push({ name: 'If-Match', in: 'header', required: true, description: 'The ETag of the version the client read. The change is refused (412) if the resource has changed since.', schema: { type: 'string' } });
  }

  const responses: Record<string, Json> = {
    [String(route.success)]: { description: 'Success', content: { [route.produces]: { schema: route.produces === 'application/json' ? { type: 'object' } : { type: 'string', format: 'binary' } } } },
  };
  if (route.body || route.query) responses['400'] = errorRef('The request is not shaped right (bad JSON, a missing or wrong field)');
  if (!route.public) {
    responses['401'] = errorRef('The user is not known or not active (the X-User header)');
    if (route.permission) responses['403'] = errorRef(`The user does not hold the permission ${route.permission}`);
  }
  if (route.path.includes('{') || route.method !== 'POST') responses['404'] = errorRef('Not found, or not visible to this user (producer code security)');
  if (route.method !== 'GET') responses['422'] = errorRef('The request is understood but a business rule refuses it; the body lists every problem');
  if (route.ifMatch) {
    responses['412'] = errorRef('The resource has changed since the ETag the client sent');
    responses['428'] = errorRef('The If-Match header is required');
  }

  return {
    operationId: route.operationId,
    summary: route.summary,
    tags: [route.tag],
    ...(route.permission ? { 'x-permission': route.permission } : {}),
    ...(route.public ? {} : { security: [{ userHeader: [] }] }),
    parameters,
    ...(route.body ? { requestBody: { required: true, content: { 'application/json': { schema: jsonSchema(route.body) } } } } : {}),
    responses,
  };
}

export function buildOpenApi(routes: Route[]): Json {
  const paths: Record<string, Record<string, Json>> = {};
  for (const route of routes) (paths[route.path] ??= {})[route.method.toLowerCase()] = operation(route);
  return {
    openapi: '3.1.0',
    info: {
      title: 'Insurance Suite API',
      version: '1.0.0',
      description:
        'Policy, billing and claims for private car insurance (a learning version). Sign-in is done by an identity provider in front of this API, which sets the X-User header; the API then applies roles, permissions and producer code security. Money is whole paise; dates are yyyy-mm-dd.',
    },
    paths,
    components: {
      securitySchemes: { userHeader: { type: 'apiKey', in: 'header', name: 'X-User', description: 'The user name, set by the identity provider or gateway after sign-in' } },
      schemas: {
        Error: {
          type: 'object',
          required: ['error'],
          properties: {
            error: { type: 'string', description: 'A short code such as validation_failed, forbidden or not_found' },
            message: { type: 'string' },
            errors: { type: 'array', items: { type: 'string' }, description: 'Every business problem found (422)' },
            issues: { type: 'array', items: { type: 'object' }, description: 'Every problem with the shape of the request (400)' },
          },
        },
      },
    },
  };
}
