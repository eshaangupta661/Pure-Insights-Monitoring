import type { Agent } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { allowedRoles } from '../../src/http/route.js';
import { ALL_ROUTES } from '../../src/routes/index.js';
import { buildTestApp, type TestApp } from '../helpers/app.js';
import { loginAs } from '../helpers/auth.js';
import { costKeyPaths } from '../helpers/redaction.js';

/** Example path params, so every GET route (including ones added later) gets walked. */
const PARAMS: Record<string, string> = { id: 'RPT_223' };

const viewerGets = ALL_ROUTES.filter((r) => {
  const roles = allowedRoles(r.access);
  return r.method === 'get' && roles !== 'public' && roles.includes('viewer');
}).map((r) => r.path.replace(/:(\w+)/g, (_m, name: string) => PARAMS[name] ?? `:${name}`));

/**
 * Second line of defence: the primary guard is that viewer responses are parsed through viewer
 * zod schemas. This walks every GET a viewer can call and fails on any money/credit-looking key
 * outside `totals`, then checks the same walk does find cost keys for an admin (so it can fail).
 */
describe('viewer never receives per-report cost fields', () => {
  let t: TestApp;
  let viewer: Agent;
  let admin: Agent;

  beforeAll(async () => {
    t = await buildTestApp();
    viewer = await loginAs(t.app, 'viewer');
    admin = await loginAs(t.app, 'admin');
  }, 60_000);
  afterAll(() => t.close());

  /** Every viewer GET, plus query variants that select a different data source. */
  const requests = [
    ...viewerGets.map((p) => `${p}?pageSize=100`),
    '/costs/chargeback?view=current&pageSize=100',
  ];

  it('covers the cost-bearing endpoints', () => {
    expect(viewerGets).toEqual(
      expect.arrayContaining([
        '/reports',
        '/reports/RPT_223',
        '/overview',
        '/costs/reports',
        '/costs/unit-economics',
        '/costs/anomalies',
        '/costs/chargeback',
      ]),
    );
  });

  it.each(requests)('GET %s: no cost keys outside totals', async (path) => {
    const res = await viewer.get(`/api/v1${path}`);
    expect(res.status).toBe(200);
    expect(costKeyPaths(res.body)).toEqual([]);
  });

  it('responses still have content, and admins do get cost on the same routes', async () => {
    const asViewer = await viewer.get('/api/v1/reports?pageSize=100');
    expect(asViewer.body.items).toHaveLength(100);
    expect(asViewer.body.items[0]).toHaveProperty('loadTimeSec');
    const anomalies = (await viewer.get('/api/v1/costs/anomalies')).body;
    expect(anomalies.zombies).toHaveLength(17);
    expect(anomalies.zombies[0]).toHaveProperty('reason');

    for (const path of requests) {
      const asAdmin = await admin.get(`/api/v1${path}`);
      // Routes whose only money is in `totals` (overview) or that have none (auth, DQ, alerts).
      const hasPerRowCost = !/^\/(auth|data-quality|overview|alerts)/.test(path);
      if (hasPerRowCost) expect(costKeyPaths(asAdmin.body).length, path).toBeGreaterThan(0);
    }
  });

  it('anomalies: viewers get report/snapshot order (no cost ranks); admins get severity order', async () => {
    type Row = { reportId: string; snapshotIdx?: number; latestSnapshotIdx?: number };
    const key = (r: Row) =>
      `${r.reportId}|${String(r.snapshotIdx ?? r.latestSnapshotIdx ?? 0).padStart(2, '0')}`;
    const isNeutral = (rows: Row[]) => {
      const keys = rows.map(key);
      return JSON.stringify(keys) === JSON.stringify([...keys].sort());
    };
    const v = (await viewer.get('/api/v1/costs/anomalies')).body as Record<string, Row[]>;
    const a = (await admin.get('/api/v1/costs/anomalies')).body as Record<string, Row[]>;
    for (const section of [
      'perViewOutliers',
      'zombies',
      'awsViewsMismatch',
      'quarantinedSnapshots',
    ]) {
      expect(isNeutral(v[section]!), section).toBe(true);
      // Same rows, only the order differs.
      expect(v[section]!.map(key).sort(), section).toEqual(a[section]!.map(key).sort());
    }
    // The admin order is by cost, so it is not the neutral one (else this test proves nothing).
    expect(isNeutral(a.zombies!)).toBe(false);
    expect(v.perViewOutliers![0]).not.toHaveProperty('robustZ');
    expect(v.awsViewsMismatch![0]).not.toHaveProperty('awsLogZ');
    expect(a.perViewOutliers![0]).toHaveProperty('robustZ');
  });

  it('viewer cost-list totals are present', async () => {
    for (const path of ['/costs/reports', '/costs/unit-economics', '/costs/chargeback']) {
      const res = await viewer.get(`/api/v1${path}`);
      expect(res.body.totals, path).toBeDefined();
    }
  });

  it('viewers see portfolio aggregates in overview totals', async () => {
    const k = (await viewer.get('/api/v1/overview')).body;
    expect(k.totals.attributedCostUsd).toBeGreaterThan(0);
    expect(k.reportCount).toBe(100);
  });
});
