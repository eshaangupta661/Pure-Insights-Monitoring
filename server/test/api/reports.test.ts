import fs from 'node:fs';
import type { DqSummary, ReportDetail, ReportSummary } from '@pic/shared';
import type { Agent } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../../src/config.js';
import { DQ_SUMMARY_PATH } from '../../src/paths.js';
import { buildTestApp, LATEST_TICK, type TestApp } from '../helpers/app.js';
import { loginAs } from '../helpers/auth.js';

/** Reports, overview and data quality as admin (unscoped). Owner scoping: scoping.test.ts. */
describe('reports API (admin)', () => {
  let t: TestApp;
  let admin: Agent;
  const count = async (where: string) =>
    (
      await t.sql<{ n: number }>(
        `SELECT count(*)::INTEGER AS n FROM REPORT_SNAPSHOTS s
         JOIN REPORTS r USING (report_id) WHERE s.snapshot_idx = ${LATEST_TICK} AND ${where}`,
      )
    )[0]!.n;

  beforeAll(async () => {
    t = await buildTestApp();
    admin = await loginAs(t.app, 'admin');
  }, 60_000);
  afterAll(() => t.close());

  describe('GET /reports', () => {
    it('lists all 100 reports at the current snapshot, 25 per page by default', async () => {
      const res = await admin.get('/api/v1/reports');
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ page: 1, pageSize: 25, total: 100 });
      expect(res.body.items).toHaveLength(25);
      const first: ReportSummary = res.body.items[0];
      expect(first.reportId).toBe('RPT_200');
      expect(first.snapshotIdx).toBe(LATEST_TICK);
      expect(first.snapshotDate).toBe('2026-10-10');
      expect(first).toHaveProperty('attributedCostUsd');
    });

    it('pagination: last page, past the end, and an empty result', async () => {
      const last = await admin.get('/api/v1/reports?page=4&pageSize=30');
      expect(last.body).toMatchObject({ page: 4, pageSize: 30, total: 100 });
      expect(last.body.items.map((r: ReportSummary) => r.reportId)).toEqual(
        Array.from({ length: 10 }, (_, i) => `RPT_${290 + i}`),
      );
      const past = await admin.get('/api/v1/reports?page=5&pageSize=30');
      expect(past.body).toEqual({ items: [], page: 5, pageSize: 30, total: 100 });
      const empty = await admin.get('/api/v1/reports?q=no-such-report');
      expect(empty.body).toEqual({ items: [], page: 1, pageSize: 25, total: 0 });
    });

    it('filters by status, orphaned, slow and q (counts match SQL)', async () => {
      const failed = await admin.get('/api/v1/reports?status=FAILED&pageSize=100');
      expect(failed.body.total).toBe(await count(`s.last_refresh_status = 'FAILED'`));
      expect(failed.body.items.every((r: ReportSummary) => r.refreshStatus === 'FAILED')).toBe(
        true,
      );

      const orphaned = await admin.get('/api/v1/reports?orphaned=true&pageSize=100');
      expect(orphaned.body.total).toBe(14);
      expect(orphaned.body.items.every((r: ReportSummary) => r.currentOwner === null)).toBe(true);
      expect((await admin.get('/api/v1/reports?orphaned=false')).body.total).toBe(86);

      const slow = await admin.get('/api/v1/reports?slow=true&pageSize=100');
      expect(slow.body.total).toBe(
        await count(`s.avg_load_time_sec > ${config.LATENCY_WARNING_SEC}`),
      );
      expect(
        slow.body.items.every((r: ReportSummary) => r.loadTimeSec > config.LATENCY_WARNING_SEC),
      ).toBe(true);

      const q = await admin.get('/api/v1/reports?q=rpt_21');
      expect(q.body.items.map((r: ReportSummary) => r.reportId)).toEqual(
        Array.from({ length: 10 }, (_, i) => `RPT_${210 + i}`),
      );
      const byOwner = await admin.get('/api/v1/reports?q=USER_3@&pageSize=100');
      expect(byOwner.body.total).toBeGreaterThanOrEqual(11); // owner match, plus any name match
    });

    it('sorts by a whitelisted column, then report id', async () => {
      const res = await admin.get('/api/v1/reports?sort=loadTime&order=desc&pageSize=100');
      const times = res.body.items.map((r: ReportSummary) => r.loadTimeSec);
      expect(times).toEqual([...times].sort((a, b) => b - a));
    });

    it('follows the replay tick', async () => {
      t.clock.set(0);
      try {
        const res = await admin.get('/api/v1/reports?pageSize=1');
        expect(res.body.items[0]).toMatchObject({ snapshotIdx: 0, snapshotDate: '2026-09-21' });
      } finally {
        t.clock.set(LATEST_TICK);
      }
    });

    it.each([
      ['status=BROKEN', /^query\.status/],
      ['orphaned=yes', /^query\.orphaned/],
      ['page=0', /^query\.page/],
      ['pageSize=101', /^query\.pageSize/],
      ['sort=attributedCostUsd', /^query\.sort/],
    ])('400 VALIDATION_ERROR for ?%s', async (qs, message) => {
      const res = await admin.get(`/api/v1/reports?${qs}`);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.message).toMatch(message);
    });
  });

  describe('GET /reports/:id', () => {
    it('returns 20 snapshots, owner history and cost; zero views give a NULL unit cost', async () => {
      const res = await admin.get('/api/v1/reports/RPT_223'); // has a zero-view snapshot (DQ05)
      expect(res.status).toBe(200);
      const d: ReportDetail = res.body;
      expect(d.history.map((h) => h.snapshotIdx)).toEqual(
        Array.from({ length: config.SNAPSHOT_COUNT }, (_, i) => i),
      );
      expect(d.ownerHistory).toHaveLength(config.SNAPSHOT_COUNT);
      expect(d.override).toBeNull();
      expect(d.ownerHistory.at(-1)).toBe(d.currentOwner); // no override: latest snapshot's owner
      expect(d.cost.attributedCostUsd).toBeGreaterThan(0);
      const zero = d.history.filter((h) => h.monthlyActiveViews === 0);
      expect(zero.length).toBeGreaterThan(0);
      for (const h of zero) {
        expect(h.dqFlags).toContain('ZERO_VIEWS');
        expect(h.fullyLoadedCostPerView).toBeNull();
      }
    });

    it('a quarantined snapshot shows the raw negative credits and unknown (NULL) cost', async () => {
      const [q] = await t.sql<{ report_id: string; snapshot_idx: number }>(
        'SELECT report_id, snapshot_idx FROM QUARANTINE ORDER BY row_idx LIMIT 1',
      );
      const d: ReportDetail = (await admin.get(`/api/v1/reports/${q!.report_id}`)).body;
      const h = d.history[q!.snapshot_idx]!;
      expect(h.creditsReported).toBeLessThan(0);
      expect(h.attributedCredits).toBeNull();
      expect(h.snowflakeCostUsd).toBeNull();
      expect(h.dqFlags).toContain('NEGATIVE_CREDITS');
    });

    it('404 for an unknown report, 400 for a malformed id', async () => {
      const missing = await admin.get('/api/v1/reports/RPT_999');
      expect(missing.status).toBe(404);
      expect(missing.body).toEqual({
        error: { code: 'NOT_FOUND', message: 'Report RPT_999 not found' },
      });
      const bad = await admin.get('/api/v1/reports/drop-table');
      expect(bad.status).toBe(400);
      expect(bad.body.error.message).toMatch(/^params\.id/);
    });
  });

  describe('GET /overview', () => {
    it('KPIs for the current snapshot match SQL', async () => {
      const res = await admin.get('/api/v1/overview');
      expect(res.status).toBe(200);
      const k = res.body;
      expect(k).toMatchObject({ tick: LATEST_TICK, snapshotIdx: LATEST_TICK, reportCount: 100 });
      expect(k.orphanedCount).toBe(14);
      expect(Object.values(k.refresh as Record<string, number>).reduce((a, b) => a + b)).toBe(100);
      expect(k.refresh.FAILED).toBe(await count(`s.last_refresh_status = 'FAILED'`));
      expect(k.slowCount).toBe(await count(`s.avg_load_time_sec > ${config.LATENCY_WARNING_SEC}`));
      expect(k.criticalSlowCount).toBe(
        await count(`s.avg_load_time_sec > ${config.LATENCY_CRITICAL_SEC}`),
      );
      const [total] = await t.sql<{ usd: number }>(
        `SELECT SUM(attributed_cost_usd) AS usd FROM REPORT_ATTRIBUTION WHERE report_id <> 'UNATTRIBUTED'`,
      );
      expect(k.totals.attributedCostUsd).toBeCloseTo(total!.usd, 6);
    });
  });

  describe('GET /overview/trend', () => {
    it('has a point per snapshot and a histogram that sums to the report count', async () => {
      const res = await admin.get('/api/v1/overview/trend');
      expect(res.status).toBe(200);
      expect(res.body.currentIdx).toBe(LATEST_TICK);
      expect(res.body.points).toHaveLength(config.SNAPSHOT_COUNT);
      const last = res.body.points[LATEST_TICK];
      expect(last.refresh.FAILED).toBe(await count(`s.last_refresh_status = 'FAILED'`));
      expect(last.slowCount).toBe(
        await count(`s.avg_load_time_sec > ${config.LATENCY_WARNING_SEC}`),
      );
      const sum = (xs: { count: number }[]) => xs.reduce((a, b) => a + b.count, 0);
      expect(sum(res.body.latency)).toBe(100);
      expect(res.body.latency).toHaveLength(config.LATENCY_BUCKET_EDGES_SEC.length + 1);
    });
  });

  describe('GET /data-quality', () => {
    it('unscoped counts and samples equal data/dq_summary.json; SQL checks all PASS', async () => {
      const summary = JSON.parse(fs.readFileSync(DQ_SUMMARY_PATH, 'utf8')) as DqSummary;
      const res = await admin.get('/api/v1/data-quality');
      expect(res.status).toBe(200);
      expect(res.body.scopedRows).toBe(summary.sourceRows);
      expect(res.body.rules).toEqual(summary.rules);
      expect(res.body.quarantinedRows).toBe(24);
      expect(res.body.checks).toHaveLength(9);
      expect(res.body.checks.every((c: { status: string }) => c.status === 'PASS')).toBe(true);
    });
  });
});
