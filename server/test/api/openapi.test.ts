import fs from 'node:fs';
import request from 'supertest';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { buildOpenApiDocument } from '../../src/api/openapi.js';
import { createApp } from '../../src/app.js';
import { allowedRoles, openApiPath } from '../../src/http/route.js';
import { OPENAPI_PATH } from '../../src/paths.js';
import { ALL_ROUTES } from '../../src/routes/index.js';

type Paths = Record<string, Record<string, { 'x-roles'?: string[]; security?: unknown[] }>>;

describe('OpenAPI document', () => {
  const doc = buildOpenApiDocument();

  it('docs/openapi.yaml is up to date (run `npm run openapi` after changing a route or schema)', () => {
    const committed: unknown = parse(fs.readFileSync(OPENAPI_PATH, 'utf8'));
    // Compared as data, not text, so CRLF checkouts (core.autocrlf) don't matter.
    expect(committed).toEqual(JSON.parse(JSON.stringify(doc)));
  });

  it('documents every route with its roles and security', () => {
    const paths = doc.paths as Paths;
    for (const route of ALL_ROUTES) {
      const op = paths[`/api/v1${openApiPath(route.path)}`]?.[route.method];
      const label = `${route.method.toUpperCase()} ${route.path}`;
      expect(op, label).toBeDefined();
      const roles = allowedRoles(route.access);
      expect(op!['x-roles'], label).toEqual(roles === 'public' ? [] : roles);
      expect(op!.security, label).toEqual(
        roles === 'public' ? [] : [{ cookieAuth: [] }, { bearerAuth: [] }],
      );
    }
    expect(paths['/health']?.get).toBeDefined();
  });

  it('serves Swagger UI at /api/docs and the JSON spec at /api/openapi.json', async () => {
    const app = createApp();
    const ui = await request(app).get('/api/docs/');
    expect(ui.status).toBe(200);
    expect(ui.headers['content-type']).toMatch(/html/);
    expect(ui.text).toMatch(/swagger/i);
    const spec = await request(app).get('/api/openapi.json');
    expect(spec.status).toBe(200);
    expect(spec.body.openapi).toBe('3.0.3');
    expect(Object.keys(spec.body.paths)).toContain('/api/v1/reports/{id}/owner');
  });
});
