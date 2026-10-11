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
      expect(orphaned.body.items.every((r: ReportSummary) => r.snapshotOwner === null)).toBe(true);
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

    it('shows the owner at the replay snapshot, not the latest snapshot’s owner', async () => {
      const N = 5;
      // A report owned by someone at N who is not its latest (snapshot 20) owner.
      const [row] = await t.sql<{
        report_id: string;
        owner_n: string;
        owner_latest: string | null;
      }>(
        `SELECT n.report_id, n.owner_email AS owner_n, l.owner_email AS owner_latest
         FROM REPORT_SNAPSHOTS n
         JOIN REPORT_SNAPSHOTS l ON l.report_id = n.report_id AND l.snapshot_idx = ${LATEST_TICK}
         WHERE n.snapshot_idx = ${N} AND n.owner_email IS NOT NULL
           AND n.owner_email IS DISTINCT FROM l.owner_email
         ORDER BY n.report_id LIMIT 1`,
      );
      const { report_id: id, owner_n: ownerAtN, owner_latest: ownerLatest } = row!;
      const orphanedAtN = (
        await t.sql<{ n: number }>(
          `SELECT count(*)::INTEGER AS n FROM REPORT_SNAPSHOTS
           WHERE snapshot_idx = ${N} AND owner_email IS NULL`,
        )
      )[0]!.n;

      t.clock.set(N);
      try {
        const expected = {
          reportId: id,
          snapshotIdx: N,
          snapshotOwner: ownerAtN,
          currentOwner: ownerLatest,
          isOrphaned: false,
          isOverridden: false,
        };
        const d: ReportDetail = (await admin.get(`/api/v1/reports/${id}`)).body;
        expect(d).toMatchObject(expected);
        expect(d.history[N]!.ownerEmail).toBe(ownerAtN);

        const list = await admin.get(`/api/v1/reports?q=${encodeURIComponent(id)}`);
        expect(list.body.items).toEqual([expect.objectContaining(expected)]);

        // Search and the "no owner" filter follow the owner shown at N.
        const byOwner = await admin.get(
          `/api/v1/reports?q=${encodeURIComponent(ownerAtN)}&pageSize=100`,
        );
        expect(byOwner.body.items.map((r: ReportSummary) => r.reportId)).toContain(id);
        const orphaned = await admin.get('/api/v1/reports?orphaned=true&pageSize=100');
        expect(orphaned.body.total).toBe(orphanedAtN);
        expect(orphaned.body.items.every((r: ReportSummary) => r.snapshotOwner === null)).toBe(
          true,
        );
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

    it('cost per view in the detail is on a 30-day basis (same period as monthly views)', async () => {
      const d: ReportDetail = (await admin.get('/api/v1/reports/RPT_203')).body;
      const now = d.history[d.snapshotIdx]!;
      expect(now.monthlyActiveViews).toBeGreaterThan(0);
      const expected =
        (now.snowflakeCostUsd! * config.DAYS_PER_MONTH + now.awsCostUsd) / now.monthlyActiveViews;
      expect(d.fullyLoadedCostPerView).toBeCloseTo(expected, 9);
      expect(now.fullyLoadedCostPerView).toBeCloseTo(expected, 9);
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

  describe('GET /overview?scope=period', () => {
    /** Independent expectations straight from REPORT_SNAPSHOTS and the attribution results. */
    const expected = async (n: number) => {
      const [row] = await t.sql<{
        rows: number;
        success: number;
        failed: number;
        timed_out: number;
        unknown: number;
        orphaned: number;
        avg_load: number;
        cost: number;
        quarantined: number;
      }>(
        `SELECT count(*)::INTEGER AS rows,
                COUNT_IF(s.last_refresh_status = 'SUCCESS')::INTEGER AS success,
                COUNT_IF(s.last_refresh_status = 'FAILED')::INTEGER AS failed,
                COUNT_IF(s.last_refresh_status = 'TIMED_OUT')::INTEGER AS timed_out,
                COUNT_IF(s.last_refresh_status = 'UNKNOWN')::INTEGER AS unknown,
                COUNT(DISTINCT CASE WHEN s.owner_email IS NULL THEN s.report_id END)::INTEGER AS orphaned,
                AVG(s.avg_load_time_sec) AS avg_load,
                COALESCE(SUM(d.attributed_cost_usd), 0) AS cost,
                COUNT_IF(s.credits_clean IS NULL)::INTEGER AS quarantined
         FROM REPORT_SNAPSHOTS s
         LEFT JOIN REPORT_ATTRIBUTION_DAILY d
           ON d.report_id = s.report_id AND d.usage_date = s.snapshot_date
         WHERE s.snapshot_idx <= ${n}`,
      );
      const loads = (
        await t.sql<{ x: number }>(
          `SELECT avg_load_time_sec AS x FROM REPORT_SNAPSHOTS WHERE snapshot_idx <= ${n} ORDER BY x`,
        )
      ).map((r) => r.x);
      // PERCENTILE_CONT: linear interpolation at rank 0.95 × (n − 1).
      const pos = 0.95 * (loads.length - 1);
      const lo = Math.floor(pos);
      const p95 =
        loads[lo]! + (loads[Math.min(lo + 1, loads.length - 1)]! - loads[lo]!) * (pos - lo);
      return { ...row!, p95 };
    };

    it.each([LATEST_TICK, 4, 0])(
      'at snapshot %i: every KPI equals an independent recount',
      async (n) => {
        t.clock.set(n);
        try {
          const res = await admin.get('/api/v1/overview?scope=period');
          expect(res.status).toBe(200);
          const p = res.body;
          const e = await expected(n);
          expect(p).toMatchObject({
            scope: 'period',
            snapshotIdx: n,
            snapshotCount: n + 1,
            fromDate: '2026-09-21',
            reportCount: 100,
            refreshCount: e.rows,
            refresh: {
              SUCCESS: e.success,
              FAILED: e.failed,
              TIMED_OUT: e.timed_out,
              UNKNOWN: e.unknown,
            },
            everOrphanedCount: e.orphaned,
            quarantinedSnapshotCount: e.quarantined,
          });
          expect(e.rows).toBe(100 * (n + 1));
          expect(p.refreshSuccessRate).toBeCloseTo(e.success / e.rows, 12);
          expect(p.avgLoadTimeSec).toBeCloseTo(e.avg_load, 9);
          expect(p.p95LoadTimeSec).toBeCloseTo(e.p95, 9);
          expect(p.totals.snowflakeCostToDateUsd).toBeCloseTo(e.cost, 6);
        } finally {
          t.clock.set(LATEST_TICK);
        }
      },
    );

    it('at the last snapshot, cost to date equals all attributed report cost; today is unchanged', async () => {
      const p = (await admin.get('/api/v1/overview?scope=period')).body;
      const today = (await admin.get('/api/v1/overview')).body;
      expect(today.scope).toBe('today');
      expect((await admin.get('/api/v1/overview?scope=today')).body).toEqual(today);
      expect(p.totals.snowflakeCostToDateUsd).toBeCloseTo(today.totals.attributedCostUsd, 6);
      expect(p.everOrphanedCount).toBe(94);
      expect(p.refresh.FAILED + p.refresh.TIMED_OUT).toBe(382 + 182);
    });

    it('rejects an unknown scope', async () => {
      for (const path of ['/overview?scope=week', '/overview/trend?scope=']) {
        const res = await admin.get(`/api/v1${path}`);
        expect(res.status, path).toBe(400);
        expect(res.body.error.message).toMatch(/^query\.scope/);
      }
    });

    it('trend?scope=period: the histogram covers snapshots 0..N', async () => {
      t.clock.set(4);
      try {
        const res = (await admin.get('/api/v1/overview/trend?scope=period')).body;
        expect(res.scope).toBe('period');
        expect(res.latency.reduce((a: number, b: { count: number }) => a + b.count, 0)).toBe(500);
        const today = (await admin.get('/api/v1/overview/trend')).body;
        expect(today.scope).toBe('today');
        expect(today.latency.reduce((a: number, b: { count: number }) => a + b.count, 0)).toBe(100);
      } finally {
        t.clock.set(LATEST_TICK);
      }
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
