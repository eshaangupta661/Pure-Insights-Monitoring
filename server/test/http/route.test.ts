import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { z } from '../../src/api/zod.js';
import { errorHandler } from '../../src/http/errors.js';
import { defineRoute, mountRoutes, openApiPath, type RouteDef } from '../../src/http/route.js';
import { bearerFor } from '../helpers/auth.js';

const full = z.object({ name: z.string(), secretCostUsd: z.number() });
const viewerView = z.object({ name: z.string() });

function appWith(routes: RouteDef[]) {
  const app = express();
  const router = express.Router();
  mountRoutes(router, routes);
  app.use(router);
  app.use(errorHandler);
  return app;
}

describe('defineRoute', () => {
  it('refuses a viewer-reachable route without viewerResponse (fail closed at load time)', () => {
    expect(() =>
      defineRoute({
        method: 'get',
        path: '/x',
        tag: 't',
        summary: 's',
        access: 'authenticated',
        response: full,
        handler: () => ({ name: 'a', secretCostUsd: 1 }),
      }),
    ).toThrow(/must declare a viewerResponse schema/);
    // Admin-only routes don't need one.
    expect(() =>
      defineRoute({
        method: 'get',
        path: '/x',
        tag: 't',
        summary: 's',
        access: ['admin'],
        response: full,
        handler: () => ({ name: 'a', secretCostUsd: 1 }),
      }),
    ).not.toThrow();
  });

  it('public routes with a body need a viewer schema too (a signed-in viewer can call them)', () => {
    const spec = {
      method: 'post',
      path: '/pub',
      tag: 't',
      summary: 's',
      access: 'public',
      response: full,
      handler: () => ({ name: 'a', secretCostUsd: 1 }),
    } as const;
    expect(() => defineRoute(spec)).toThrow(/must declare a viewerResponse schema/);
    expect(() => defineRoute({ ...spec, viewerResponse: viewerView })).not.toThrow();
    // 204 routes have no body to redact, so a viewer schema there is a mistake.
    expect(() =>
      defineRoute({
        ...spec,
        status: 204,
        response: null,
        viewerResponse: viewerView,
        handler: () => undefined,
      }),
    ).toThrow(/204 route has no body/);
  });

  it('serialize fails closed: a route def without a viewer schema is a 500 for viewers, never raw data', async () => {
    // Bypasses defineRoute's load-time check, as a hand-built RouteDef could.
    const raw: RouteDef = {
      method: 'get',
      path: '/raw',
      tag: 't',
      summary: 's',
      access: 'authenticated',
      status: 200,
      response: full,
      handler: () => ({ name: 'a', secretCostUsd: 1 }),
    };
    const app = appWith([raw]);
    const asViewer = await request(app).get('/raw').set('Authorization', bearerFor('viewer'));
    expect(asViewer.status).toBe(500);
    expect(JSON.stringify(asViewer.body)).not.toMatch(/secretCostUsd/);
    const asAdmin = await request(app).get('/raw').set('Authorization', bearerFor('admin'));
    expect(asAdmin.body).toEqual({ name: 'a', secretCostUsd: 1 });
  });

  it('strips keys the viewer schema does not list, even ones the handler adds later', async () => {
    const app = appWith([
      defineRoute({
        method: 'get',
        path: '/thing',
        tag: 't',
        summary: 's',
        access: 'authenticated',
        response: full,
        viewerResponse: viewerView,
        // An extra undeclared field, as if a query grew a new cost column.
        handler: () =>
          ({ name: 'a', secretCostUsd: 1, newCreditsColumn: 2 }) as z.input<typeof full>,
      }),
    ]);
    const asViewer = await request(app).get('/thing').set('Authorization', bearerFor('viewer'));
    expect(asViewer.body).toEqual({ name: 'a' });
    const asAdmin = await request(app).get('/thing').set('Authorization', bearerFor('admin'));
    expect(asAdmin.body).toMatchObject({ name: 'a', secretCostUsd: 1 });
  });

  it('outside production, a response that breaks its schema is a 500, not silently sent', async () => {
    const app = appWith([
      defineRoute({
        method: 'get',
        path: '/broken',
        tag: 't',
        summary: 's',
        access: ['admin'],
        response: full,
        handler: () => ({ name: 'a' }) as unknown as z.input<typeof full>,
      }),
    ]);
    const res = await request(app).get('/broken').set('Authorization', bearerFor('admin'));
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL');
  });

  it('401 before 403: anonymous gets 401, wrong role 403', async () => {
    const app = appWith([
      defineRoute({
        method: 'get',
        path: '/admin-only',
        tag: 't',
        summary: 's',
        access: ['admin'],
        response: viewerView,
        handler: () => ({ name: 'ok' }),
      }),
    ]);
    expect((await request(app).get('/admin-only')).status).toBe(401);
    const owner = await request(app).get('/admin-only').set('Authorization', bearerFor('owner'));
    expect(owner.status).toBe(403);
    expect(owner.body.error.code).toBe('FORBIDDEN');
    expect(
      (await request(app).get('/admin-only').set('Authorization', bearerFor('admin'))).status,
    ).toBe(200);
  });

  it('converts Express paths to OpenAPI paths', () => {
    expect(openApiPath('/reports/:id/owner')).toBe('/reports/{id}/owner');
  });
});
