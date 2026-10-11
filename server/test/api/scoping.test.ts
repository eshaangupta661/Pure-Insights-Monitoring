import type {
  AnomalyReport,
  CostRow,
  DataQualityResponse,
  ReportDetail,
  ReportSummary,
} from '@pic/shared';
import type { Agent } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DuckDBValue } from '@duckdb/node-api';
import { config } from '../../src/config.js';
import { buildTestApp, type TestApp } from '../helpers/app.js';
import { loginAs } from '../helpers/auth.js';

const OWNER = 'user_3@company.com';

/** Owners see only reports whose current owner is their email, on every endpoint. */
describe('owner scoping (user_3, who owns 11 reports)', () => {
  let t: TestApp;
  let owner: Agent;
  let mine: string[];
  let foreign: string;

  beforeAll(async () => {
    t = await buildTestApp();
    owner = await loginAs(t.app, 'owner');
    mine = (
      await t.sql<{ report_id: string }>(
        `SELECT report_id FROM REPORTS WHERE current_owner = '${OWNER}' ORDER BY report_id`,
      )
    ).map((r) => r.report_id);
    foreign = (
      await t.sql<{ report_id: string }>(
        `SELECT report_id FROM REPORTS WHERE current_owner IS DISTINCT FROM '${OWNER}' ORDER BY report_id LIMIT 1`,
      )
    )[0]!.report_id;
  }, 60_000);
  afterAll(() => t.close());

  it('GET /reports: exactly their 11 reports, all with currentOwner = their email', async () => {
    expect(mine).toHaveLength(11);
    const res = await owner.get('/api/v1/reports?pageSize=100');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(11);
    const items: ReportSummary[] = res.body.items;
    expect(items.map((r) => r.reportId)).toEqual(mine);
    expect(items.every((r) => r.currentOwner === OWNER)).toBe(true);
    // Owners get full cost for their own reports.
    expect(items.every((r) => typeof r.attributedCostUsd === 'number')).toBe(true);
  });

  it('the filter runs in SQL: the COUNT query itself is scoped and binds the email', async () => {
    const seen: { sql: string; params: DuckDBValue[] }[] = [];
    const original = t.warehouse.query.bind(t.warehouse);
    t.warehouse.query = <T>(sql: string, params: DuckDBValue[] = []) => {
      seen.push({ sql, params });
      return original<T>(sql, params);
    };
    try {
      const res = await owner.get('/api/v1/reports?pageSize=2');
      expect(res.body).toMatchObject({ total: 11, pageSize: 2 });
      expect(res.body.items).toHaveLength(2);
    } finally {
      t.warehouse.query = original;
    }
    const countQuery = seen.find((q) => q.sql.includes('COUNT(*)'));
    expect(countQuery?.params).toContain(OWNER);
    expect(countQuery?.sql).toMatch(/o\.current_owner = \$\d+/);
    expect(seen.every((q) => !q.sql.includes(OWNER))).toBe(true); // bound, never interpolated
  });

  it('pagination edges within the scope', async () => {
    const last = await owner.get('/api/v1/reports?page=3&pageSize=5');
    expect(last.body).toMatchObject({ total: 11, page: 3 });
    expect(last.body.items).toHaveLength(1);
    const past = await owner.get('/api/v1/reports?page=4&pageSize=5');
    expect(past.body).toEqual({ items: [], page: 4, pageSize: 5, total: 11 });
    const orphaned = await owner.get('/api/v1/reports?orphaned=true');
    expect(orphaned.body).toEqual({ items: [], page: 1, pageSize: 25, total: 0 });
  });

  it('GET /reports/:id: their report 200 with cost; another owner’s is 404 like a missing one', async () => {
    const own = await owner.get(`/api/v1/reports/${mine[0]}`);
    expect(own.status).toBe(200);
    expect((own.body as ReportDetail).cost.attributedCostUsd).toBeGreaterThan(0);

    const other = await owner.get(`/api/v1/reports/${foreign}`);
    const missing = await owner.get('/api/v1/reports/RPT_999');
    expect(other.status).toBe(404);
    expect(other.body.error.code).toBe('NOT_FOUND');
    expect(missing.status).toBe(404);
  });

  it('GET /overview counts only their reports; totals are their own', async () => {
    const k = (await owner.get('/api/v1/overview')).body;
    expect(k.reportCount).toBe(11);
    expect(k.orphanedCount).toBe(0);
    const items: ReportSummary[] = (await owner.get('/api/v1/reports?pageSize=100')).body.items;
    const sum = items.reduce((s, r) => s + r.attributedCostUsd, 0);
    expect(k.totals.attributedCostUsd).toBeCloseTo(sum, 6);
  });

  it('GET /overview/trend counts only their reports', async () => {
    const t = (await owner.get('/api/v1/overview/trend')).body;
    const total = (r: Record<string, number>) => Object.values(r).reduce((a, b) => a + b, 0);
    expect(
      t.points.every((p: { refresh: Record<string, number> }) => total(p.refresh) === 11),
    ).toBe(true);
    expect(t.latency.reduce((a: number, b: { count: number }) => a + b.count, 0)).toBe(11);
  });

  it('GET /costs/reports and /costs/unit-economics: only their reports, full cost, shares over their scope', async () => {
    const costs = await owner.get('/api/v1/costs/reports?pageSize=100');
    expect(costs.body.total).toBe(11);
    const rows: CostRow[] = costs.body.items;
    expect(rows.map((r) => r.reportId).sort()).toEqual(mine);
    expect(rows.reduce((s, r) => s + (r.shareOfTotal ?? 0), 0)).toBeCloseTo(1, 12);
    expect(costs.body.totals.attributedCostUsd).toBeCloseTo(
      rows.reduce((s, r) => s + r.attributedCostUsd, 0),
      6,
    );

    const unit = await owner.get('/api/v1/costs/unit-economics?pageSize=100');
    expect(unit.body.total).toBe(11);
    expect(unit.body.items.every((r: { currentOwner: string }) => r.currentOwner === OWNER)).toBe(
      true,
    );
  });

  it('GET /costs/anomalies: every section lists only their reports (no orphan zombies)', async () => {
    const a: AnomalyReport = (await owner.get('/api/v1/costs/anomalies')).body;
    const sections = [a.perViewOutliers, a.zombies, a.awsViewsMismatch, a.quarantinedSnapshots];
    for (const rows of sections) {
      expect(rows.every((r) => mine.includes(r.reportId) && r.currentOwner === OWNER)).toBe(true);
    }
    expect(a.zombies.every((z) => z.reason === 'LOW_USAGE')).toBe(true);
    const [expected] = await t.sql<{ n: number }>(
      `SELECT count(*)::INTEGER AS n FROM SQL_RESULTS.ANOMALY_AWS_VIEWS_MISMATCH
       WHERE report_id IN (${mine.map((id) => `'${id}'`).join(',')})`,
    );
    expect(a.awsViewsMismatch).toHaveLength(expected!.n);
  });

  it('GET /costs/chargeback: only their own current-owner line (the default for owners)', async () => {
    for (const qs of ['', '?view=current']) {
      const res = await owner.get(`/api/v1/costs/chargeback${qs}`);
      expect(res.status, qs).toBe(200);
      expect(res.body.total, qs).toBe(1);
      expect(res.body.items[0]).toMatchObject({ owner: OWNER, reportCount: 11 });
      expect(res.body.items[0].shareOfTotalCost).toBeCloseTo(1, 12);
      expect(res.body.totals.lineCount).toBe(1);
    }
  });

  it('GET /costs/chargeback?view=point_in_time is 403 for owners (it covers reports they no longer own)', async () => {
    const res = await owner.get('/api/v1/costs/chargeback?view=point_in_time');
    expect(res.status).toBe(403);
    expect(res.body.error).toEqual({
      code: 'FORBIDDEN',
      message: 'Point-in-time chargeback is admin-only; owners can use view=current',
    });
    // Why: user_3's point-in-time line spans many more reports than the 11 they own today.
    const [pit] = await t.sql<{ reports: number }>(
      `SELECT report_count AS reports FROM SQL_RESULTS.OWNER_CHARGEBACK WHERE owner = '${OWNER}'`,
    );
    expect(pit!.reports).toBeGreaterThan(11);
  });

  it('GET /data-quality counts over their reports’ 220 rows only', async () => {
    const dq: DataQualityResponse = (await owner.get('/api/v1/data-quality')).body;
    expect(dq.scopedRows).toBe(11 * config.SNAPSHOT_COUNT);
    const ids = mine.map((id) => `'${id}'`).join(',');
    const [expected] = await t.sql<{ orphaned: number; quarantined: number }>(
      `SELECT count_if(list_contains(dq_flags, 'ORPHANED'))::INTEGER AS orphaned,
              (SELECT count(*) FROM QUARANTINE WHERE report_id IN (${ids}))::INTEGER AS quarantined
       FROM REPORT_SNAPSHOTS WHERE report_id IN (${ids})`,
    );
    expect(dq.rules.find((r) => r.ruleId === 'DQ01')?.rowsAffected).toBe(expected!.orphaned);
    expect(dq.quarantinedRows).toBe(expected!.quarantined);
    for (const rule of dq.rules) {
      expect(
        rule.sampleReportIds.every((id) => mine.includes(id)),
        rule.ruleId,
      ).toBe(true);
    }
  });
});
