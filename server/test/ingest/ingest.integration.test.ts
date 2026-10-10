import fs from 'node:fs';
import type { DqSummary } from '@pic/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../../src/config.js';
import { all, closeDb, openDb, type Db } from '../../src/db.js';
import { runIngest } from '../../src/ingest/pipeline.js';
import { DQ_SUMMARY_PATH, RAW_CSV } from '../../src/paths.js';

/** Builds the warehouse from the real CSV in memory and asserts the profiled data facts. */
describe('ingest (real CSV → :memory: DuckDB)', () => {
  const csv = fs.readFileSync(RAW_CSV, 'utf8');
  let db: Db;
  let summary: DqSummary;

  const one = async <T>(sql: string): Promise<T> => {
    const [row] = await all<T>(db.conn, sql);
    if (row === undefined) throw new Error(`no rows: ${sql}`);
    return row;
  };
  const count = async (sql: string): Promise<number> => (await one<{ n: number }>(sql)).n;
  const flagCount = (flag: string) =>
    count(
      `SELECT count(*)::INTEGER AS n FROM REPORT_SNAPSHOTS WHERE list_contains(dq_flags, '${flag}')`,
    );
  const ruleRows = (id: string) => summary.rules.find((r) => r.ruleId === id)?.rowsAffected;

  beforeAll(async () => {
    db = await openDb(':memory:');
    summary = await runIngest(db.conn, csv);
  });

  afterAll(() => closeDb(db));

  describe('shape', () => {
    it('keeps every row: 2,000 raw and 2,000 cleaned', async () => {
      expect(await count('SELECT count(*)::INTEGER AS n FROM RAW_REPORT_SNAPSHOTS')).toBe(2000);
      expect(await count('SELECT count(*)::INTEGER AS n FROM REPORT_SNAPSHOTS')).toBe(2000);
      expect(summary.sourceRows).toBe(2000);
    });

    it('stores RAW_REPORT_SNAPSHOTS exactly as written in the CSV', async () => {
      const lines = csv.split(/\r?\n/).filter(Boolean).slice(1);
      const raw = await all<Record<string, string>>(
        db.conn,
        `SELECT concat_ws(',', report_id, report_name, owner_email, last_refresh_status, monthly_active_views,
                snowflake_credits_consumed, avg_load_time_sec, aws_hosting_cost_usd, query_count_last_30d,
                concurrent_user_peak) AS line
         FROM RAW_REPORT_SNAPSHOTS ORDER BY row_idx`,
      );
      expect(raw.map((r) => r.line)).toEqual(lines);
    });

    it('has 100 reports (RPT_200–RPT_299), each in all 20 snapshots', async () => {
      const r = await one<{ ids: number; lo: string; hi: string; minN: number; maxN: number }>(`
        SELECT count(*)::INTEGER AS ids, min(report_id) AS lo, max(report_id) AS hi,
               min(n)::INTEGER AS minN, max(n)::INTEGER AS maxN
        FROM (SELECT report_id, count(DISTINCT snapshot_idx) AS n FROM REPORT_SNAPSHOTS GROUP BY 1)`);
      expect(r).toEqual({
        ids: 100,
        lo: 'RPT_200',
        hi: 'RPT_299',
        minN: config.SNAPSHOT_COUNT,
        maxN: config.SNAPSHOT_COUNT,
      });
      expect(await count('SELECT count(*)::INTEGER AS n FROM REPORTS')).toBe(100);
    });

    it('assigns snapshot_idx = floor(row / 100) and dates 2026-09-21 … 2026-10-10', async () => {
      expect(
        await count(
          'SELECT count(*)::INTEGER AS n FROM REPORT_SNAPSHOTS WHERE snapshot_idx <> row_idx // 100',
        ),
      ).toBe(0);
      const d = await one<{ lo: string; hi: string; bad: number }>(`
        SELECT strftime(min(snapshot_date), '%Y-%m-%d') AS lo, strftime(max(snapshot_date), '%Y-%m-%d') AS hi,
               count(*) FILTER (WHERE snapshot_date <> DATE '2026-09-21' + snapshot_idx)::INTEGER AS bad
        FROM REPORT_SNAPSHOTS`);
      expect(d).toEqual({ lo: '2026-09-21', hi: '2026-10-10', bad: 0 });
    });
  });

  describe('data facts', () => {
    it('DQ01: 245 orphaned rows (128 nan + 117 ORPHANED_REPORT), owner normalized to NULL', async () => {
      expect(
        await count(
          "SELECT count(*)::INTEGER AS n FROM RAW_REPORT_SNAPSHOTS WHERE owner_email = 'nan'",
        ),
      ).toBe(128);
      expect(
        await count(
          "SELECT count(*)::INTEGER AS n FROM RAW_REPORT_SNAPSHOTS WHERE owner_email = 'ORPHANED_REPORT'",
        ),
      ).toBe(117);
      expect(
        await count(
          'SELECT count(*)::INTEGER AS n FROM REPORT_SNAPSHOTS WHERE owner_email IS NULL',
        ),
      ).toBe(245);
      expect(await flagCount('ORPHANED')).toBe(245);
    });

    it('refresh status counts', async () => {
      const rows = await all<{ s: string; n: number }>(
        db.conn,
        'SELECT last_refresh_status AS s, count(*)::INTEGER AS n FROM REPORT_SNAPSHOTS GROUP BY 1 ORDER BY 1',
      );
      expect(Object.fromEntries(rows.map((r) => [r.s, r.n]))).toEqual({
        FAILED: 382,
        SUCCESS: 1336,
        TIMED_OUT: 182,
        UNKNOWN: 100,
      });
      expect(await flagCount('UNKNOWN_REFRESH')).toBe(100);
    });

    it('DQ02: 24 negative credits (−13.6 … −0.8) quarantined with credits_clean NULL', async () => {
      const r = await one<{ n: number; lo: number; hi: number; cleanNull: number }>(`
        SELECT count(*)::INTEGER AS n, min(snowflake_credits_consumed) AS lo, max(snowflake_credits_consumed) AS hi,
               count(*) FILTER (WHERE credits_clean IS NULL)::INTEGER AS cleanNull
        FROM REPORT_SNAPSHOTS WHERE snowflake_credits_consumed < 0`);
      expect(r).toEqual({ n: 24, lo: -13.6, hi: -0.8, cleanNull: 24 });
      expect(
        await count(
          'SELECT count(*)::INTEGER AS n FROM REPORT_SNAPSHOTS WHERE credits_clean IS NULL',
        ),
      ).toBe(24);
      expect(
        await count("SELECT count(*)::INTEGER AS n FROM QUARANTINE WHERE rule_id = 'DQ02'"),
      ).toBe(24);
      expect(
        await count(`SELECT count(*)::INTEGER AS n FROM QUARANTINE q JOIN REPORT_SNAPSHOTS s USING (row_idx)
                     WHERE list_contains(s.dq_flags, 'NEGATIVE_CREDITS') AND CAST(q.raw_value AS DOUBLE) < 0`),
      ).toBe(24);
    });

    it('DQ03 / DQ08: latency 0.6–55.0; 1,490 rows > 15s; 1,004 SUCCESS but > 15s', async () => {
      const r = await one<{ lo: number; hi: number }>(
        'SELECT min(avg_load_time_sec) AS lo, max(avg_load_time_sec) AS hi FROM REPORT_SNAPSHOTS',
      );
      expect(r).toEqual({ lo: 0.6, hi: 55 });
      expect(await flagCount('SLOW_LOAD')).toBe(1490);
      expect(await flagCount('SLOW_BUT_HEALTHY')).toBe(1004);
    });

    it('DQ04: 30 cost mismatches, including all 18 rows with views < 50 and AWS > $300', async () => {
      expect(await flagCount('COST_MISMATCH')).toBe(30);
      const hard = 'monthly_active_views < 50 AND aws_hosting_cost_usd > 300';
      expect(await count(`SELECT count(*)::INTEGER AS n FROM REPORT_SNAPSHOTS WHERE ${hard}`)).toBe(
        18,
      );
      expect(
        await count(
          `SELECT count(*)::INTEGER AS n FROM REPORT_SNAPSHOTS WHERE ${hard} AND NOT list_contains(dq_flags, 'COST_MISMATCH')`,
        ),
      ).toBe(0);
    });

    it('AWS cost vs views correlation ≈ −0.03', async () => {
      const r = await one<{ c: number }>(
        'SELECT corr(aws_hosting_cost_usd, monthly_active_views) AS c FROM REPORT_SNAPSHOTS',
      );
      expect(r.c).toBeGreaterThanOrEqual(-0.035);
      expect(r.c).toBeLessThanOrEqual(-0.025);
    });

    it('DQ05: 4 zero-view rows; DQ06: 93 impossible-concurrency rows', async () => {
      expect(await flagCount('ZERO_VIEWS')).toBe(4);
      expect(await flagCount('IMPOSSIBLE_CONCURRENCY')).toBe(93);
    });

    it('DQ09: 1,782 ownership-change events; 7–13 owners per report', async () => {
      expect(await flagCount('OWNER_CHANGED')).toBe(1782);
      expect(await count('SELECT sum(owner_change_count)::INTEGER AS n FROM REPORTS')).toBe(1782);
      expect(
        await count(
          "SELECT count(*)::INTEGER AS n FROM REPORT_SNAPSHOTS WHERE snapshot_idx = 0 AND list_contains(dq_flags, 'OWNER_CHANGED')",
        ),
      ).toBe(0);
      const r = await one<{ lo: number; hi: number }>(`
        SELECT min(n)::INTEGER AS lo, max(n)::INTEGER AS hi
        FROM (SELECT report_id, count(DISTINCT owner_email) AS n FROM REPORT_SNAPSHOTS GROUP BY 1)`);
      expect(r).toEqual({ lo: 7, hi: 13 });
    });

    it('resolves current_owner from snapshot 19: 14 orphaned, user_3 owns 11', async () => {
      expect(await count('SELECT count(*)::INTEGER AS n FROM REPORTS WHERE is_orphaned')).toBe(14);
      expect(
        await count('SELECT count(*)::INTEGER AS n FROM REPORTS WHERE current_owner IS NULL'),
      ).toBe(14);
      expect(
        await count(
          "SELECT count(*)::INTEGER AS n FROM REPORTS WHERE current_owner = 'user_3@company.com'",
        ),
      ).toBe(11);
      expect(
        await count(`SELECT count(*)::INTEGER AS n FROM REPORTS r JOIN REPORT_SNAPSHOTS s
                       ON s.report_id = r.report_id AND s.snapshot_idx = ${config.SNAPSHOT_COUNT - 1}
                     WHERE r.current_owner IS DISTINCT FROM s.owner_email
                        OR r.owner_history[${config.SNAPSHOT_COUNT}] IS DISTINCT FROM s.owner_email
                        OR len(r.owner_history) <> ${config.SNAPSHOT_COUNT}`),
      ).toBe(0);
    });
  });

  describe('DQ_RESULTS', () => {
    it('has 9 rules whose counts match the flags in REPORT_SNAPSHOTS', async () => {
      const results = await all<{ rule_id: string; rows_affected: number }>(
        db.conn,
        'SELECT rule_id, rows_affected FROM DQ_RESULTS ORDER BY rule_id',
      );
      expect(results).toHaveLength(9);
      for (const rule of summary.rules) {
        expect(await flagCount(rule.flag)).toBe(rule.rowsAffected);
        expect(results.find((r) => r.rule_id === rule.ruleId)?.rows_affected).toBe(
          rule.rowsAffected,
        );
      }
      expect(ruleRows('DQ01')).toBe(245);
      expect(ruleRows('DQ02')).toBe(24);
    });

    it('DQ09 is an info-level event, not a defect', async () => {
      const r = await one<{ rule_name: string; severity: string; treatment: string }>(
        "SELECT rule_name, severity, treatment FROM DQ_RESULTS WHERE rule_id = 'DQ09'",
      );
      expect(r.rule_name).toBe('Ownership change (event)');
      expect(r.severity).toBe('info');
      expect(r.treatment).toMatch(/^Expected event, not a defect/);
    });
  });

  it('matches the committed data/dq_summary.json (re-run `npm run ingest` if rules changed)', () => {
    const committed = JSON.parse(fs.readFileSync(DQ_SUMMARY_PATH, 'utf8')) as DqSummary;
    expect(summary).toEqual(committed);
    expect(summary.rules.every((r) => r.sampleReportIds.length <= 3)).toBe(true);
  });
});
