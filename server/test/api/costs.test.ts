import type {
  AnomalyReport,
  ChargebackRow,
  CostRow,
  PageWithTotals,
  UnitEconomicsRow,
} from '@pic/shared';
import type { Agent } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../../src/config.js';
import { buildTestApp, type TestApp } from '../helpers/app.js';
import { loginAs } from '../helpers/auth.js';

const sum = (xs: readonly (number | null)[]) => xs.reduce<number>((s, x) => s + (x ?? 0), 0);

/** Cost endpoints as admin (unscoped) and viewer. Owner scoping: scoping.test.ts. */
describe('costs API', () => {
  let t: TestApp;
  let admin: Agent;
  let viewer: Agent;
  let metered = 0;

  /** Every row of a paginated endpoint (pageSize 100). */
  const allRows = async <T>(agent: Agent, path: string): Promise<T[]> => {
    const rows: T[] = [];
    for (let page = 1; ; page++) {
      const sep = path.includes('?') ? '&' : '?';
      const res = await agent.get(`/api/v1${path}${sep}pageSize=100&page=${page}`);
      expect(res.status).toBe(200);
      rows.push(...(res.body.items as T[]));
      if (rows.length >= res.body.total) return rows;
    }
  };

  beforeAll(async () => {
    t = await buildTestApp();
    admin = await loginAs(t.app, 'admin');
    viewer = await loginAs(t.app, 'viewer');
    metered = (
      await t.sql<{ c: number }>(
        'SELECT SUM(CREDITS_USED) AS c FROM ACCOUNT_USAGE.WAREHOUSE_METERING_HISTORY',
      )
    )[0]!.c;
  }, 60_000);
  afterAll(() => t.close());

  describe('GET /costs/reports', () => {
    it('100 reports + UNATTRIBUTED, most expensive first; totals reconcile to metering', async () => {
      const res = await admin.get('/api/v1/costs/reports');
      const body: PageWithTotals<CostRow, unknown> = res.body;
      expect(res.status).toBe(200);
      expect(body.total).toBe(101);
      const credits = body.items.map((r) => r.attributedCredits);
      expect(credits).toEqual([...credits].sort((a, b) => b - a));
      expect(res.body.totals.lineCount).toBe(101);
      expect(Math.abs(res.body.totals.attributedCredits - metered)).toBeLessThan(1e-6);

      const rows = await allRows<CostRow>(admin, '/costs/reports');
      expect(rows).toHaveLength(101);
      expect(rows.filter((r) => r.reportId === 'UNATTRIBUTED')).toEqual([
        expect.objectContaining({ currentOwner: null, attributedCredits: 0 }),
      ]);
      expect(sum(rows.map((r) => r.shareOfTotal))).toBeCloseTo(1, 12);
    });

    it('sorts by queries or report id when asked', async () => {
      const byId = (await admin.get('/api/v1/costs/reports?sort=reportId&pageSize=3')).body.items;
      expect(byId.map((r: CostRow) => r.reportId)).toEqual(['RPT_200', 'RPT_201', 'RPT_202']);
      const byQueries = (await admin.get('/api/v1/costs/reports?sort=queries')).body.items;
      const q = byQueries.map((r: CostRow) => r.queryCount);
      expect(q).toEqual([...q].sort((a: number, b: number) => b - a));
    });

    it('viewers default to report-id order and may not sort by cost (403)', async () => {
      const res = await viewer.get('/api/v1/costs/reports?pageSize=2');
      expect(res.body.items.map((r: CostRow) => r.reportId)).toEqual(['RPT_200', 'RPT_201']);
      expect(res.body.totals.attributedCostUsd).toBeGreaterThan(0); // aggregates are allowed
      const sorted = await viewer.get('/api/v1/costs/reports?sort=cost');
      expect(sorted.status).toBe(403);
      expect(sorted.body.error.code).toBe('FORBIDDEN');
    });
  });

  describe('GET /costs/unit-economics', () => {
    it('100 reports by fully loaded cost per view (nulls last); totals are a ratio of totals', async () => {
      const rows = await allRows<UnitEconomicsRow>(admin, '/costs/unit-economics');
      expect(rows).toHaveLength(100);
      const cpv = rows.map((r) => r.fullyLoadedCostPerView).filter((x): x is number => x !== null);
      expect(cpv).toEqual([...cpv].sort((a, b) => b - a));
      const totals = (await admin.get('/api/v1/costs/unit-economics')).body.totals;
      expect(totals.reportCount).toBe(100);
      expect(totals.fullyLoadedCostPerView).toBeCloseTo(
        sum(rows.map((r) => r.fullyLoadedCostUsd)) / sum(rows.map((r) => r.costedViews)),
        9,
      );
    });

    it('viewers: 403 on the cost sort', async () => {
      expect((await viewer.get('/api/v1/costs/unit-economics?sort=costPerView')).status).toBe(403);
      expect((await viewer.get('/api/v1/costs/unit-economics')).status).toBe(200);
    });
  });

  describe('GET /costs/anomalies', () => {
    it('matches the /sql/06 views: 17 zombies, 30 AWS mismatches, 24 quarantined', async () => {
      const a: AnomalyReport = (await admin.get('/api/v1/costs/anomalies')).body;
      const [stored] = await t.sql<{ n: number }>(
        'SELECT count(*)::INTEGER AS n FROM SQL_RESULTS.ANOMALY_COST_PER_VIEW',
      );
      expect(a.perViewOutliers).toHaveLength(stored!.n);
      expect(a.zombies).toHaveLength(17);
      expect(a.awsViewsMismatch).toHaveLength(30);
      expect(a.quarantinedSnapshots).toHaveLength(24);
      expect(a.quarantinedSnapshots.every((q) => q.rawCredits < 0)).toBe(true);
      const orphanZombies = a.zombies.filter((z) => z.reason !== 'LOW_USAGE');
      expect(orphanZombies.every((z) => z.currentOwner === null)).toBe(true);
      for (const z of a.zombies) {
        expect(z.estimatedMonthlySavingsUsd).toBeCloseTo(
          z.latestSnowflakeCostUsd * config.SAVINGS_DAYS_PER_MONTH,
          9,
        );
      }
    });
  });

  describe('GET /costs/chargeback', () => {
    it('point_in_time (default): UNOWNED = the 245 orphaned snapshots; sums to metered', async () => {
      const rows = await allRows<ChargebackRow>(admin, '/costs/chargeback');
      expect(rows.find((r) => r.owner === 'UNOWNED')?.snapshotCount).toBe(245);
      expect(rows.find((r) => r.owner === 'UNATTRIBUTED')).toMatchObject({ attributedCredits: 0 });
      expect(Math.abs(sum(rows.map((r) => r.attributedCredits)) - metered)).toBeLessThan(1e-6);
      const totals = (await admin.get('/api/v1/costs/chargeback')).body.totals;
      expect(totals.lineCount).toBe(rows.length);
      const cost = rows.map((r) => r.totalCostUsd);
      expect(cost).toEqual([...cost].sort((a, b) => b - a));
    });

    it('current: UNOWNED = the 14 orphaned reports; also sums to metered', async () => {
      const rows = await allRows<ChargebackRow>(admin, '/costs/chargeback?view=current');
      expect(rows.find((r) => r.owner === 'UNOWNED')?.reportCount).toBe(14);
      expect(rows.find((r) => r.owner === 'user_3@company.com')?.reportCount).toBe(11);
      expect(Math.abs(sum(rows.map((r) => r.attributedCredits)) - metered)).toBeLessThan(1e-6);
    });

    it('pagination past the end, and 400 on an unknown view', async () => {
      const total = (await admin.get('/api/v1/costs/chargeback')).body.total;
      const past = await admin.get(`/api/v1/costs/chargeback?page=${total + 1}&pageSize=1`);
      expect(past.body).toMatchObject({ items: [], total });
      const bad = await admin.get('/api/v1/costs/chargeback?view=yesterday');
      expect(bad.status).toBe(400);
      expect(bad.body.error.message).toMatch(/^query\.view/);
    });

    it('viewers get owner lines sorted by owner, and 403 on the cost sort', async () => {
      const res = await viewer.get('/api/v1/costs/chargeback?pageSize=100');
      const owners = res.body.items.map((r: { owner: string }) => r.owner);
      expect(owners).toEqual([...owners].sort());
      expect((await viewer.get('/api/v1/costs/chargeback?sort=cost')).status).toBe(403);
    });
  });
});
