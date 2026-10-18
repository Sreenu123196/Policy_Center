import type { PGlite } from '@electric-sql/pglite';
import type { IncomingHttpHeaders } from 'node:http';
import type { z } from 'zod';
import type { Permission, Visibility } from '../platform/index.js';
import type { ApiConfig } from './config.js';

// A route is described once, here, and used twice: to serve the request and to write the OpenAPI description. So the
// description can never drift from what the API does (document section 17).

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const notFound = (what: string): ApiError => new ApiError(404, 'not_found', `${what} was not found`);

export interface RouteContext<B, Q> {
  db: PGlite;
  config: ApiConfig;
  today: () => string; // the date of "today"; tests set it
  user: { id: string; username: string };
  visibility: Visibility;
  params: Record<string, string>;
  query: Q;
  body: B;
  headers: IncomingHttpHeaders;
}

export interface RouteResult {
  status?: number;
  body: unknown;
  headers?: Record<string, string>;
}

export interface RouteInput<B extends z.ZodType, Q extends z.ZodType> {
  method: 'GET' | 'POST' | 'PATCH';
  path: string; // OpenAPI style: /v1/jobs/{id}/quote
  operationId: string;
  summary: string;
  tag: string;
  permission?: Permission; // the permission the user must hold; reads are limited by producer code instead
  public?: boolean; // no sign-in needed
  body?: B;
  query?: Q;
  ifMatch?: boolean; // the request must carry If-Match with the ETag of what it changes
  success: number; // the status of a successful answer
  produces?: string; // the content type of a successful answer when it is not JSON, for example application/pdf
  handler: (context: RouteContext<z.output<B>, z.output<Q>>) => Promise<RouteResult>;
}

export interface Route {
  method: 'GET' | 'POST' | 'PATCH';
  path: string;
  operationId: string;
  summary: string;
  tag: string;
  permission: Permission | undefined;
  public: boolean;
  body: z.ZodType | undefined;
  query: z.ZodType | undefined;
  ifMatch: boolean;
  success: number;
  produces: string;
  run: (context: RouteContext<unknown, unknown>) => Promise<RouteResult>;
}

export function defineRoute<B extends z.ZodType, Q extends z.ZodType>(input: RouteInput<B, Q>): Route {
  return {
    method: input.method,
    path: input.path,
    operationId: input.operationId,
    summary: input.summary,
    tag: input.tag,
    permission: input.permission,
    public: input.public ?? false,
    body: input.body,
    query: input.query,
    ifMatch: input.ifMatch ?? false,
    success: input.success,
    produces: input.produces ?? 'application/json',
    run: (context) => input.handler(context as RouteContext<z.output<B>, z.output<Q>>),
  };
}
