import type { Role } from '@pic/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { syncedAlerts } from '../../src/deps.js';
import { ALL_ROUTES } from '../../src/routes/index.js';
import { buildTestApp, type TestApp } from '../helpers/app.js';
import { DEMO_USERS, bearerFor } from '../helpers/auth.js';

type Caller = Role | 'anonymous';
const ANY: Role[] = ['admin', 'owner', 'viewer'];
const OWNER = 'user_3@company.com';

/** Request fixtures resolved after the warehouse is built. */
interface Fixtures {
  report: string; // owned by user_3
  alert: string; // an OPEN alert on one of user_3's reports
}

interface Row {
  method: 'get' | 'post' | 'patch';
  path: string;
  /** Who may call it; 'public' = anyone, signed in or not. */
  allowed: Role[] | 'public';
  success: number;
  /** A query string that changes who may call the route, e.g. '?view=point_in_time'. */
  query?: string;
  url?: (f: Fixtures) => string;
  body?: (f: Fixtures) => object;
}

/**
 * The access rules (docs/API.md roles and endpoints), written out independently of the
 * route declarations. Every endpoint × {anonymous, viewer, owner, admin}:
 *   anonymous on a protected route → 401; a signed-in role not allowed → 403; allowed → success.
 * Rows run in order, so state-changing ones are arranged to stay valid (ack before incidents).
 */
const MATRIX: Row[] = [
  {
    method: 'post',
    path: '/auth/login',
    allowed: 'public',
    success: 200,
    body: () => DEMO_USERS.viewer,
  },
  { method: 'post', path: '/auth/logout', allowed: 'public', success: 204 },
  { method: 'get', path: '/auth/me', allowed: ANY, success: 200 },
  { method: 'get', path: '/overview', allowed: ANY, success: 200 },
  { method: 'get', path: '/reports', allowed: ANY, success: 200 },
  {
    method: 'get',
    path: '/reports/:id',
    allowed: ANY,
    success: 200,
    url: (f) => `/reports/${f.report}`,
  },
  {
    method: 'patch',
    path: '/reports/:id/owner',
    allowed: ['admin'],
    success: 200,
    url: (f) => `/reports/${f.report}/owner`,
    body: () => ({ ownerEmail: OWNER, reason: 'access matrix: same owner' }),
  },
  { method: 'get', path: '/costs/reports', allowed: ANY, success: 200 },
  { method: 'get', path: '/costs/unit-economics', allowed: ANY, success: 200 },
  { method: 'get', path: '/costs/anomalies', allowed: ANY, success: 200 },
  // Owners default to view=current; point-in-time is an accounting view, not for owners (M1).
  { method: 'get', path: '/costs/chargeback', allowed: ANY, success: 200 },
  { method: 'get', path: '/costs/chargeback', query: '?view=current', allowed: ANY, success: 200 },
  {
    method: 'get',
    path: '/costs/chargeback',
    query: '?view=point_in_time',
    allowed: ['admin', 'viewer'],
    success: 200,
  },
  { method: 'get', path: '/data-quality', allowed: ANY, success: 200 },
  { method: 'get', path: '/alerts', allowed: ANY, success: 200 },
  {
    method: 'post',
    path: '/alerts/:id/ack',
    allowed: ['admin', 'owner'],
    success: 200,
    url: (f) => `/alerts/${f.alert}/ack`,
  },
  { method: 'get', path: '/admin/replay', allowed: ['admin'], success: 200 },
  {
    method: 'post',
    path: '/admin/replay',
    allowed: ['admin'],
    success: 200,
    body: () => ({ action: 'resume' }),
  },
  {
    method: 'post',
    path: '/admin/incidents',
    allowed: ['admin'],
    success: 201,
    body: (f) => ({ reportId: f.report, kind: 'LATENCY_SPIKE' }),
  },
  { method: 'get', path: '/admin/audit-log', allowed: ['admin'], success: 200 },
];

const CALLERS: Caller[] = ['anonymous', 'viewer', 'owner', 'admin'];

function expectedStatus(row: Row, caller: Caller): number {
  if (row.allowed === 'public') return row.success;
  if (caller === 'anonymous') return 401;
  return row.allowed.includes(caller) ? row.success : 403;
}

describe('access matrix: every endpoint × every role', () => {
  let t: TestApp;
  let fixtures: Fixtures;

  beforeAll(async () => {
    t = await buildTestApp();
    const owned = await t.sql<{ id: string }>(
      `SELECT report_id AS id FROM REPORTS WHERE current_owner = '${OWNER}' ORDER BY report_id`,
    );
    const alert = (await syncedAlerts(t.deps))
      .list({ kind: 'owner', email: OWNER }, { status: 'OPEN' })
      .at(0);
    if (!alert) throw new Error('fixture: user_3 has no OPEN alert at tick 19');
    fixtures = { report: owned[0]!.id, alert: alert.id };
  }, 60_000);
  afterAll(() => t.close());

  it('the matrix lists exactly the declared routes (a new route must be added here)', () => {
    const declared = ALL_ROUTES.map((r) => `${r.method.toUpperCase()} ${r.path}`).sort();
    const listed = [...new Set(MATRIX.map((r) => `${r.method.toUpperCase()} ${r.path}`))].sort();
    expect(listed).toEqual(declared);
  });

  const cases = MATRIX.flatMap((row) =>
    CALLERS.map((caller) => ({
      row,
      caller,
      expected: expectedStatus(row, caller),
      name: `${row.method.toUpperCase()} ${row.path}${row.query ?? ''} as ${caller}`,
    })),
  );

  it.each(cases)('$name → $expected', async ({ row, caller, expected }) => {
    const url = `/api/v1${row.url ? row.url(fixtures) : row.path}${row.query ?? ''}`;
    let req = request(t.app)[row.method](url);
    if (caller !== 'anonymous') req = req.set('Authorization', bearerFor(caller));
    const res = await (row.body ? req.send(row.body(fixtures)) : req);
    expect(res.status, JSON.stringify(res.body)).toBe(expected);
    if (expected === 401) expect(res.body.error.code).toBe('UNAUTHENTICATED');
    if (expected === 403) expect(res.body.error.code).toBe('FORBIDDEN');
  });
});
