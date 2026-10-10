/*
 * defineRoute: one declaration per endpoint. The same object
 *   - registers the Express route (mountRoutes): authentication, role check, zod parsing of
 *     query/params/body into typed values (Express 5's req.query is read-only, so it is parsed
 *     into a new object), the handler, and the response;
 *   - describes the endpoint for OpenAPI (server/src/api/openapi.ts);
 *   - is listed in ALL_ROUTES, which the access-matrix test checks against its own table.
 *
 * Viewer redaction fails closed: every route a viewer can reach must declare `viewerResponse`,
 * and a viewer's response is always parsed through it. zod objects strip keys they don't list,
 * so a cost column added to a query later is dropped for viewers unless a viewer schema names
 * it. Viewer schemas therefore never use passthrough(), z.any() or z.record().
 */
import type { Request, Response, Router } from 'express';
import type { AnyZodObject, ZodTypeAny, z } from 'zod';
import type { AuthUser, Role } from '@pic/shared';
import { assertRole, authenticate } from '../auth/middleware.js';
import { scopeFor, type Scope } from '../auth/scope.js';
import { config } from '../config.js';
import type { ApiDeps } from '../deps.js';
import { HttpError, RequestValidationError } from './errors.js';

/** 'public': no sign-in. 'authenticated': any role. A role list: only those roles. */
export type Access = 'public' | 'authenticated' | readonly Role[];
export type Method = 'get' | 'post' | 'patch' | 'delete';

type UserFor<A extends Access> = A extends 'public' ? AuthUser | null : AuthUser;
type ScopeFor<A extends Access> = A extends 'public' ? Scope | null : Scope;
/** A declared schema's output; undefined when the route declares none; unknown once erased. */
type Infer<T> = T extends ZodTypeAny ? z.infer<T> : T extends undefined ? undefined : unknown;

export interface HandlerContext<A extends Access, Q, P, B> {
  query: Infer<Q>;
  params: Infer<P>;
  body: Infer<B>;
  user: UserFor<A>;
  scope: ScopeFor<A>;
  deps: ApiDeps;
  req: Request;
  res: Response;
}

export interface RouteSpec<
  A extends Access,
  Q extends AnyZodObject | undefined,
  P extends AnyZodObject | undefined,
  B extends ZodTypeAny | undefined,
  R extends ZodTypeAny | null,
> {
  method: Method;
  /** Express path relative to /api/v1, e.g. '/reports/:id'. */
  path: string;
  summary: string;
  description?: string;
  tag: string;
  access: A;
  /** Success status; 204 sends no body and needs `response: null`. Default 200. */
  status?: number;
  query?: Q;
  params?: P;
  body?: B;
  response: R;
  /**
   * Required when viewers can call the route and it has a body (see the file header), public
   * routes included; omitted for 204 routes.
   */
  viewerResponse?: ZodTypeAny;
  /** Route-specific error statuses for the docs (400/401/403 are derived from the spec). */
  errors?: Partial<Record<number, string>>;
  handler: (
    ctx: HandlerContext<A, Q, P, B>,
  ) =>
    Promise<R extends ZodTypeAny ? z.input<R> : void> | (R extends ZodTypeAny ? z.input<R> : void);
}

/** The type-erased form stored in route lists. */
export interface RouteDef {
  method: Method;
  path: string;
  summary: string;
  description?: string;
  tag: string;
  access: Access;
  status: number;
  query?: AnyZodObject;
  params?: AnyZodObject;
  body?: ZodTypeAny;
  response: ZodTypeAny | null;
  viewerResponse?: ZodTypeAny;
  errors?: Partial<Record<number, string>>;
  handler: (ctx: HandlerContext<Access, unknown, unknown, unknown>) => unknown;
}

export function allowedRoles(access: Access): readonly Role[] | 'public' {
  if (access === 'public') return 'public';
  if (access === 'authenticated') return ['admin', 'owner', 'viewer'];
  return access;
}

export function defineRoute<
  A extends Access,
  Q extends AnyZodObject | undefined = undefined,
  P extends AnyZodObject | undefined = undefined,
  B extends ZodTypeAny | undefined = undefined,
  R extends ZodTypeAny | null = ZodTypeAny,
>(spec: RouteSpec<A, Q, P, B, R>): RouteDef {
  const roles = allowedRoles(spec.access);
  const label = `${spec.method.toUpperCase()} ${spec.path}`;
  // A signed-in viewer can reach public routes too (their session is still authenticated).
  const viewerCanCall = roles === 'public' || roles.includes('viewer');
  if (viewerCanCall) {
    if (spec.response !== null && !spec.viewerResponse) {
      throw new Error(`${label}: viewers can call it, so it must declare a viewerResponse schema`);
    }
    if (spec.response === null && spec.viewerResponse) {
      throw new Error(`${label}: a 204 route has no body; omit viewerResponse`);
    }
  }
  const status = spec.status ?? 200;
  if ((status === 204) !== (spec.response === null)) {
    throw new Error(
      `${spec.method.toUpperCase()} ${spec.path}: use response: null exactly for 204`,
    );
  }
  return { ...spec, status, handler: spec.handler as RouteDef['handler'] };
}

/** Express path → OpenAPI path: '/reports/:id' → '/reports/{id}'. */
export function openApiPath(path: string): string {
  return path.replace(/:(\w+)/g, '{$1}');
}

function parseInput<T extends ZodTypeAny>(
  schema: T | undefined,
  value: unknown,
  where: 'query' | 'params' | 'body',
): unknown {
  if (!schema) return undefined;
  const result = schema.safeParse(value);
  if (!result.success) throw new RequestValidationError(where, result.error);
  return result.data;
}

/** Registers every route on `router`. `deps` is read per request, so routes mount without it. */
export function mountRoutes(router: Router, routes: readonly RouteDef[], deps?: ApiDeps): void {
  for (const route of routes) {
    router[route.method](route.path, async (req, res) => {
      const auth = authenticate(req);
      if (route.access !== 'public') {
        if (!auth) throw new HttpError(401, 'UNAUTHENTICATED', 'Sign in first');
        if (route.access !== 'authenticated') assertRole(auth.user, route.access);
      }
      const user = auth?.user ?? null;

      const ctx: HandlerContext<Access, unknown, unknown, unknown> = {
        query: parseInput(route.query, req.query, 'query'),
        params: parseInput(route.params, req.params, 'params'),
        body: parseInput(route.body, req.body ?? {}, 'body'),
        user: user as AuthUser,
        scope: (user && scopeFor(user)) as Scope,
        get deps(): ApiDeps {
          if (!deps) throw new Error('API dependencies are not configured (createApp(deps))');
          return deps;
        },
        req,
        res,
      };

      const result = await route.handler(ctx);
      if (route.response === null) {
        res.status(route.status).end();
        return;
      }
      res.status(route.status).json(serialize(route, user, result));
    });
  }
}

/**
 * Viewers always get the viewer schema's parse (stripping anything it doesn't list). Everyone
 * else gets the handler's result as is; outside production it is first validated against the
 * response schema, so a handler drifting from its documented shape fails tests loudly.
 */
function serialize(route: RouteDef, user: AuthUser | null, result: unknown): unknown {
  if (user?.role === 'viewer') {
    // defineRoute already refuses this; checked again so no path can send a viewer the raw result.
    if (!route.viewerResponse) {
      throw new Error(
        `${route.method.toUpperCase()} ${route.path}: no viewerResponse for a viewer`,
      );
    }
    return route.viewerResponse.parse(result);
  }
  if (config.VALIDATE_RESPONSES && route.response) route.response.parse(result);
  return result;
}
