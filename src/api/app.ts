import { createHash } from 'node:crypto';
import type { Database } from '../platform/index.js';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { findIdempotentResponse, getUserByUsername, PermissionError, requirePermission, saveIdempotentResponse, ValidationError, visibilityFor } from '../platform/index.js';
import type { ApiConfig } from './config.js';
import { buildOpenApi } from './openapi.js';
import { ApiError, type Route, type RouteContext } from './registry.js';
import { allRoutes } from './routes.js';

// The REST API (document section 17): resource-based, versioned (/v1), every POST takes an idempotency key, changes
// carry the ETag they were based on, lists are paged, and the answers to mistakes are always the same shape.

export interface AppOptions {
  today?: () => string; // the date of "today"; tests set it
  logger?: boolean;
}

const headerValue = (value: string | string[] | undefined): string | undefined => (Array.isArray(value) ? value[0] : value);

function badRequest(error: ZodError): ApiError & { issues: unknown[] } {
  const api = new ApiError(400, 'bad_request', 'The request is not shaped right') as ApiError & { issues: unknown[] };
  api.issues = error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
  return api;
}

export async function createApp(db: Database, config: ApiConfig, options: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? false });
  const today = options.today ?? ((): string => new Date().toISOString().slice(0, 10));
  const routes = allRoutes;

  async function handle(route: Route, request: FastifyRequest, reply: FastifyReply): Promise<void> {
    // 1. Who is asking? (The identity provider has already signed them in and set X-User.)
    let user = { id: '', username: 'anonymous' };
    if (!route.public) {
      const name = headerValue(request.headers['x-user']);
      const found = name === undefined ? null : await getUserByUsername(db, name);
      if (found === null || found.status !== 'active') throw new ApiError(401, 'unauthenticated', 'Sign in: the X-User header must name an active user');
      user = { id: found.id, username: found.username };
      if (route.permission) await requirePermission(db, user.id, route.permission);
    }
    const visibility = route.public ? { producerCodes: [] } : await visibilityFor(db, user.id);

    // 2. Is the request shaped right?
    const query = route.query ? route.query.safeParse(request.query) : undefined;
    if (query && !query.success) throw badRequest(query.error);
    const body = route.body ? route.body.safeParse(request.body) : undefined;
    if (body && !body.success) throw badRequest(body.error);

    // 3. A POST carries an idempotency key. The same key and request gets the stored answer.
    const key = route.method === 'POST' ? headerValue(request.headers['idempotency-key'])?.trim() : undefined;
    let requestHash = '';
    if (route.method === 'POST') {
      if (key === undefined || key === '') throw new ApiError(400, 'bad_request', 'The Idempotency-Key header is required for every POST');
      requestHash = createHash('sha256').update(`${route.method} ${request.url} ${JSON.stringify(request.body ?? null)}`).digest('hex');
      const stored = await findIdempotentResponse(db, user.username, key);
      if (stored) {
        if (stored.requestHash !== requestHash) throw new ApiError(422, 'idempotency_key_reused', 'This Idempotency-Key was already used for a different request');
        return reply.header('Idempotency-Replayed', 'true').code(stored.statusCode).send(stored.response);
      }
    }

    // 4. Do it.
    const context: RouteContext<unknown, unknown> = {
      db,
      config,
      today,
      user,
      visibility,
      params: request.params as Record<string, string>,
      query: query?.data,
      body: body?.data,
      headers: request.headers,
    };
    const result = await route.run(context);
    const status = result.status ?? route.success;
    if (key !== undefined && status >= 200 && status < 300) await saveIdempotentResponse(db, user.username, key, { requestHash, statusCode: status, response: result.body });
    return reply.code(status).headers(result.headers ?? {}).send(result.body);
  }

  for (const route of routes) {
    app.route({
      method: route.method,
      url: route.path.replace(/\{(\w+)\}/g, ':$1'),
      handler: (request, reply) => handle(route, request, reply),
    });
  }
  const spec = buildOpenApi(routes);
  app.get('/openapi.json', async () => spec);

  // One shape for every mistake: { error, message, errors?, issues? }.
  app.setErrorHandler((error: Error & { statusCode?: number }, _request, reply) => {
    if (error instanceof ApiError) {
      const issues = (error as ApiError & { issues?: unknown[] }).issues;
      return reply.code(error.status).send({ error: error.code, message: error.message, ...(issues ? { issues } : {}) });
    }
    if (error instanceof ValidationError) return reply.code(422).send({ error: 'validation_failed', message: 'The request was refused', errors: error.errors });
    if (error instanceof PermissionError) return reply.code(403).send({ error: 'forbidden', message: error.message });
    if (typeof error.statusCode === 'number' && error.statusCode >= 400 && error.statusCode < 500) return reply.code(error.statusCode).send({ error: 'bad_request', message: error.message });
    app.log.error(error);
    return reply.code(500).send({ error: 'internal_error', message: 'Something went wrong; the problem was logged' });
  });
  app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: 'not_found', message: 'There is no such route' }));

  await app.ready();
  return app;
}
