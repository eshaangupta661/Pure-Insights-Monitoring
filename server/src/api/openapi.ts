/*
 * The OpenAPI 3.0 document, generated from the same route declarations (ALL_ROUTES) and zod
 * schemas that the server validates with, so the docs can't describe a different API than the
 * one that runs. `npm run openapi` writes it to docs/openapi.yaml; a test fails if that file
 * drifts from what this builds. Swagger UI serves it at /api/docs.
 */
import {
  OpenAPIRegistry,
  OpenApiGeneratorV3,
  type RouteConfig,
} from '@asteasolutions/zod-to-openapi';
import { stringify } from 'yaml';
import { config } from '../config.js';
import { allowedRoles, openApiPath, type RouteDef } from '../http/route.js';
import { ALL_ROUTES } from '../routes/index.js';
import { apiErrorSchema } from './schemas.js';
import { z } from './zod.js';

type OpenApiDocument = ReturnType<OpenApiGeneratorV3['generateDocument']>;

const API_PREFIX = '/api/v1';

const healthSchema = z
  .object({
    status: z.literal('ok'),
    tick: z.number().int(),
    uptime: z.number().openapi({ description: 'Process uptime in seconds' }),
  })
  .openapi('HealthResponse');

const DESCRIPTION = `
REST API of the Pure Insights Command Center (see docs/API.md for the guide).

**Auth.** \`POST ${API_PREFIX}/auth/login\` sets the \`${config.AUTH_COOKIE}\` httpOnly session cookie;
the token is never in a response body. In this Swagger UI, call login once and the browser
sends the cookie on every "Try it out" (same origin). An \`Authorization: Bearer <jwt>\` header
also works.

**Roles.** Each operation lists its roles in \`x-roles\`. Owners see only reports they currently
own (filtered in SQL). Viewers get every list without per-report money or credits: their
responses are the \`Viewer*\` variants, and \`totals\` aggregates are the only cost they see.

**Errors** are always \`{ "error": { "code", "message" } }\`. Lists are paginated with
\`page\` (1-based) and \`pageSize\` (max ${config.PAGE_SIZE_MAX}).
`.trim();

function errorResponse(description: string) {
  return { description, content: { 'application/json': { schema: apiErrorSchema } } };
}

function responsesFor(route: RouteDef): RouteConfig['responses'] {
  const roles = allowedRoles(route.access);
  const responses: RouteConfig['responses'] = {};

  if (route.response === null) {
    responses[route.status] = { description: 'No content' };
  } else {
    const differsForViewers =
      roles !== 'public' &&
      roles.includes('viewer') &&
      route.viewerResponse &&
      route.viewerResponse !== route.response;
    const schema = differsForViewers
      ? z.union([route.response, route.viewerResponse as z.ZodTypeAny])
      : route.response;
    responses[route.status] = {
      description: differsForViewers
        ? 'Success. Viewers receive the cost-free variant (second schema).'
        : 'Success',
      content: { 'application/json': { schema } },
    };
  }

  if (route.query || route.params || route.body) {
    responses[400] = errorResponse('VALIDATION_ERROR: invalid query, path or body');
  }
  if (roles !== 'public') responses[401] = errorResponse('UNAUTHENTICATED: no valid session');
  const forbidden = [
    ...(roles !== 'public' && route.access !== 'authenticated'
      ? ['FORBIDDEN: role not allowed']
      : []),
    ...(route.method !== 'get' ? ['BAD_ORIGIN: cross-origin mutation (production)'] : []),
    ...(route.errors?.[403] ? [route.errors[403]] : []),
  ];
  if (forbidden.length > 0) responses[403] = errorResponse(forbidden.join('; '));
  for (const [status, description] of Object.entries(route.errors ?? {})) {
    if (status !== '403' && description) responses[status] = errorResponse(description);
  }
  return responses;
}

export function buildOpenApiDocument(routes: readonly RouteDef[] = ALL_ROUTES): OpenApiDocument {
  const registry = new OpenAPIRegistry();
  registry.registerComponent('securitySchemes', 'cookieAuth', {
    type: 'apiKey',
    in: 'cookie',
    name: config.AUTH_COOKIE,
    description: 'Session cookie set by POST /api/v1/auth/login',
  });
  registry.registerComponent('securitySchemes', 'bearerAuth', {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'JWT',
  });

  registry.registerPath({
    method: 'get',
    path: '/health',
    tags: ['health'],
    summary: 'Liveness probe (Render health check); no auth',
    security: [],
    responses: {
      200: { description: 'OK', content: { 'application/json': { schema: healthSchema } } },
    },
  });

  for (const route of routes) {
    const roles = allowedRoles(route.access);
    const roleLine = roles === 'public' ? 'Public.' : `Roles: ${roles.join(', ')}.`;
    registry.registerPath({
      method: route.method,
      path: `${API_PREFIX}${openApiPath(route.path)}`,
      tags: [route.tag],
      summary: route.summary,
      description: [roleLine, route.description].filter(Boolean).join('\n\n'),
      security: roles === 'public' ? [] : [{ cookieAuth: [] }, { bearerAuth: [] }],
      'x-roles': roles === 'public' ? [] : [...roles],
      request: {
        ...(route.params && { params: route.params }),
        ...(route.query && { query: route.query }),
        ...(route.body && { body: { content: { 'application/json': { schema: route.body } } } }),
      },
      responses: responsesFor(route),
    });
  }

  return new OpenApiGeneratorV3(registry.definitions).generateDocument({
    openapi: '3.0.3',
    info: { title: 'Pure Insights Command Center API', version: '1.0.0', description: DESCRIPTION },
    tags: [
      { name: 'auth' },
      { name: 'reports' },
      { name: 'costs' },
      { name: 'data-quality' },
      { name: 'alerts' },
      { name: 'admin' },
      { name: 'health' },
    ],
  });
}

let cached: OpenApiDocument | null = null;

/** Built once per process (Swagger UI and /api/openapi.json). */
export function openApiDocument(): OpenApiDocument {
  cached ??= buildOpenApiDocument();
  return cached;
}

export function openApiYaml(doc: OpenApiDocument = buildOpenApiDocument()): string {
  return `# Generated by \`npm run openapi\` from server/src/api/openapi.ts. Do not edit by hand.\n${stringify(doc, { lineWidth: 0 })}`;
}
