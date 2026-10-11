import fs from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../../src/config.js';
import { all, closeDb, openDb, type Db } from '../../src/db.js';
import { runIngest } from '../../src/ingest/pipeline.js';
import { RAW_CSV } from '../../src/paths.js';
import {
  FINGERPRINT_TABLE,
  RESULTS_SCHEMA,
  ReconciliationError,
  SqlSuiteError,
  currentFingerprintInputs,
  getSqlResults,
  loadSqlResults,
  runSqlSuite,
  suiteFingerprint,
  type SqlResults,
} from '../../src/sql/runner.js';

/** The full suite against the real CSV in an in-memory warehouse. */
const csv = fs.readFileSync(RAW_CSV, 'utf8');
const RATE = 1 + config.SIMULATED_OVERHEAD_RATE;

async function buildWarehouse(): Promise<Db> {
  const db = await openDb(':memory:');
  await runIngest(db.conn, csv);
  return db;
}

const sum = (xs: readonly (number | null)[]) => xs.reduce<number>((s, x) => s + (x ?? 0), 0);

describe('SQL suite (real CSV → :memory:)', () => {
  let db: Db;
  let results: SqlResults;
  const one = async <T>(sql: string): Promise<T> => {
    const [row] = await all<T>(db.conn, sql);
    if (row === undefined) throw new Error(`no rows: ${sql}`);
    return row;
  };

  beforeAll(async () => {
    db = await buildWarehouse();
    results = await runSqlSuite(db.conn);
  }, 60_000);
  afterAll(() => closeDb(db));

  describe('verification', () => {
    it('passes every RECONCILIATION check, each tagged with its kind', () => {
      const rows = results.views.RECONCILIATION;
      expect(rows.map((r) => [r.check_id, r.check_kind, r.status])).toEqual([
        ['C1_QUERIES_EQ_METERED', 'CONSERVATION', 'PASS'],
        ['C2_EACH_HOUR_EQ_METERED', 'CONSERVATION', 'PASS'],
        ['C3_REPORTS_PLUS_UNATTRIBUTED_EQ_QUERIES', 'CONSERVATION', 'PASS'],
        ['C4_CHARGEBACK_POINT_IN_TIME_EQ_QUERIES', 'CONSERVATION', 'PASS'],
        ['C5_CHARGEBACK_CURRENT_EQ_QUERIES', 'CONSERVATION', 'PASS'],
        ['G1_SNAPSHOT_RECOVERS_CREDITS_CLEAN', 'GROUND_TRUTH', 'PASS'],
        ['G2_REPORT_RECOVERS_CREDITS_CLEAN', 'GROUND_TRUTH', 'PASS'],
        ['G3_QUARANTINED_HAVE_NO_QUERIES', 'GROUND_TRUTH', 'PASS'],
        ['G4_ALL_QUERIES_TAGGED', 'GROUND_TRUTH', 'PASS'],
        ['K1_ORPHANED_EQ_DQ01', 'CONSISTENCY', 'PASS'],
        ['K2_ZOMBIES_EQ_LOW_VIEWS', 'CONSISTENCY', 'PASS'],
        ['K3_SAVINGS_EQ_ZOMBIE_QUERY_CREDITS', 'CONSISTENCY', 'PASS'],
        ['K4_ORPHAN_ONLY_HAS_NO_SAVINGS', 'CONSISTENCY', 'PASS'],
      ]);
      for (const r of rows) {
        expect(r.abs_diff, r.check_id).not.toBeNull();
        expect(r.abs_diff!, r.check_id).toBeLessThanOrEqual(config.RECON_TOLERANCE);
      }
    });

    it('SQL DQ counts equal the TypeScript rule counts for all 9 rules', () => {
      expect(results.views.DQ_CHECKS).toHaveLength(9);
      expect(
        results.views.DQ_CHECKS.every((r) => r.status === 'PASS' && r.sql_rows === r.ts_rows),
      ).toBe(true);
    });

    it('Σ metered = Σ attributed to 1e-6, read straight from ACCOUNT_USAGE', async () => {
      const r = await one<{ metered: number; attributed: number }>(`
        SELECT (SELECT SUM(CREDITS_USED) FROM ACCOUNT_USAGE.WAREHOUSE_METERING_HISTORY) AS metered,
               (SELECT SUM(attributed_credits) FROM QUERY_ATTRIBUTED_COST) AS attributed`);
      expect(Math.abs(r.metered - r.attributed)).toBeLessThan(1e-6);
      expect(
        Math.abs(
          sum(results.views.REPORT_ATTRIBUTION.map((x) => x.attributed_credits)) - r.metered,
        ),
      ).toBeLessThan(1e-6);
    });

    it('each query gets (1 + rate) × its simulated true credits (ground truth used only here)', async () => {
      const r = await one<{ n: number; max_gap: number }>(`
        SELECT count(*)::INTEGER AS n,
               MAX(ABS(c.attributed_credits - q._SIM_TRUE_CREDITS * ${RATE})) AS max_gap
        FROM QUERY_ATTRIBUTED_COST c JOIN ACCOUNT_USAGE.QUERY_HISTORY q USING (QUERY_ID)`);
      expect(r.n).toBe(83_003);
      expect(r.max_gap).toBeLessThan(1e-9);
    });

    it('splits queries that cross an hour across both metered hours', async () => {
      const r = await one<{ spanning: number; multi_slice: number }>(`
        SELECT count(*)::INTEGER AS spanning,
               count_if(slices > 1)::INTEGER AS multi_slice
        FROM (SELECT QUERY_ID, count(*) AS slices FROM QUERY_HOUR_COST GROUP BY 1) s
        JOIN ACCOUNT_USAGE.QUERY_HISTORY q USING (QUERY_ID)
        WHERE date_trunc('hour', q.START_TIME) <> date_trunc('hour', q.END_TIME - INTERVAL 1 MILLISECOND)`);
      expect(r.spanning).toBeGreaterThan(100);
      expect(r.multi_slice).toBe(r.spanning);
    });
  });

  describe('report attribution and unit economics', () => {
    it('has an always-present UNATTRIBUTED line, 0 here because every query is tagged', () => {
      const lines = results.views.REPORT_ATTRIBUTION.filter((r) => r.report_id === 'UNATTRIBUTED');
      expect(lines).toEqual([
        expect.objectContaining({ current_owner: null, query_count: 0, attributed_credits: 0 }),
      ]);
    });

    it('covers all 100 reports; active + overhead = attributed, overhead / active = rate', () => {
      const allLines = results.views.REPORT_ATTRIBUTION;
      const rows = allLines.filter((r) => r.report_id !== 'UNATTRIBUTED');
      expect(allLines).toHaveLength(101);
      expect(rows).toHaveLength(100);
      for (const r of rows) {
        expect(r.active_credits + r.overhead_credits).toBeCloseTo(r.attributed_credits, 9);
        expect(r.overhead_credits / r.active_credits).toBeCloseTo(
          config.SIMULATED_OVERHEAD_RATE,
          12,
        );
        expect(r.attributed_cost_usd).toBeCloseTo(
          r.attributed_credits * config.CREDIT_PRICE_USD,
          6,
        );
      }
      expect(sum(allLines.map((r) => r.share_of_total))).toBeCloseTo(1, 12);
    });

    it('zero-view snapshots have NULL unit cost in both variants, not Infinity', () => {
      const zero = results.views.UNIT_ECONOMICS_SNAPSHOT.filter((r) => r.views === 0);
      expect(zero.map((r) => r.report_id).sort()).toEqual([
        'RPT_223',
        'RPT_230',
        'RPT_278',
        'RPT_299',
      ]);
      for (const r of zero) {
        expect(r.snowflake_cost_per_view).toBeNull();
        expect(r.fully_loaded_cost_per_view).toBeNull();
        expect(r.fully_loaded_cost_usd).not.toBeNull(); // the cost is known; only the ratio is undefined
      }
    });

    it('cost per view uses one period: one-day Snowflake cost × 30 + monthly AWS, over 30-day views', () => {
      const days = config.DAYS_PER_MONTH;
      const costed = results.views.UNIT_ECONOMICS_SNAPSHOT.filter(
        (r) => r.snowflake_cost_usd !== null && r.views > 0,
      );
      expect(costed.length).toBeGreaterThan(1900);
      for (const r of costed) {
        expect(r.snowflake_cost_30d_usd!).toBeCloseTo(r.snowflake_cost_usd! * days, 6);
        expect(r.fully_loaded_cost_usd!).toBeCloseTo(
          r.snowflake_cost_usd! * days + r.aws_cost_usd,
          6,
        );
        expect(r.snowflake_cost_per_view!).toBeCloseTo(r.snowflake_cost_30d_usd! / r.views, 9);
        expect(r.fully_loaded_cost_per_view!).toBeCloseTo(r.fully_loaded_cost_usd! / r.views, 9);
      }
      // Report level: ratio of the 30-day sums over the same (costed) snapshots.
      for (const e of results.views.UNIT_ECONOMICS_REPORT) {
        const snaps = results.views.UNIT_ECONOMICS_SNAPSHOT.filter(
          (r) => r.report_id === e.report_id && r.attributed_credits !== null,
        );
        const views = sum(snaps.map((r) => r.views));
        expect(e.costed_views).toBe(views);
        expect(e.snowflake_cost_usd!).toBeCloseTo(sum(snaps.map((r) => r.snowflake_cost_usd)), 6);
        if (views > 0)
          expect(e.fully_loaded_cost_per_view!).toBeCloseTo(
            sum(snaps.map((r) => r.fully_loaded_cost_usd)) / views,
            9,
          );
      }
    });

    it('quarantined snapshots have unknown (NULL) Snowflake cost, not 0', () => {
      const unknown = results.views.UNIT_ECONOMICS_SNAPSHOT.filter(
        (r) => r.attributed_credits === null,
      );
      expect(unknown).toHaveLength(24);
      expect(
        unknown.every((r) => r.snowflake_cost_usd === null && r.snowflake_cost_per_view === null),
      ).toBe(true);
    });

    it('no cached view contains Infinity or NaN (DuckDB returns Infinity for x / 0)', () => {
      const bad: string[] = [];
      for (const [view, rows] of Object.entries(results.views)) {
        for (const row of rows as object[]) {
          for (const [col, v] of Object.entries(row)) {
            const nonFinite =
              (typeof v === 'number' && !Number.isFinite(v)) ||
              (typeof v === 'string' && /^-?(Infinity|inf)$|^NaN$/i.test(v));
            if (nonFinite) bad.push(`${view}.${col}=${String(v)}`);
          }
        }
      }
      expect(bad).toEqual([]);
    });
  });

  describe('owner chargeback', () => {
    const line = (rows: SqlResults['views']['OWNER_CHARGEBACK'], owner: string) => {
      const r = rows.find((x) => x.owner === owner);
      if (!r) throw new Error(`no chargeback line for ${owner}`);
      return r;
    };

    it('OWNER_CHARGEBACK_CURRENT: UNOWNED = the 14 orphaned reports, user_3 owns 11', () => {
      const rows = results.views.OWNER_CHARGEBACK_CURRENT;
      expect(line(rows, 'UNOWNED').report_count).toBe(14);
      expect(line(rows, 'UNOWNED').snapshot_count).toBe(14 * config.SNAPSHOT_COUNT);
      expect(line(rows, 'user_3@company.com').report_count).toBe(11);
    });

    it('OWNER_CHARGEBACK (point-in-time): UNOWNED = the 245 DQ01 snapshots', () => {
      const unowned = line(results.views.OWNER_CHARGEBACK, 'UNOWNED');
      expect(unowned.snapshot_count).toBe(245);
      expect(unowned.report_count).toBeGreaterThan(14);
    });

    it('OWNER_CHARGEBACK matches an independent GROUP BY snapshot owner', async () => {
      const expected = await all<{
        owner: string;
        snapshots: number;
        reports: number;
        credits: number;
      }>(
        db.conn,
        `SELECT COALESCE(s.owner_email, 'UNOWNED') AS owner, count(*)::INTEGER AS snapshots,
                count(DISTINCT s.report_id)::INTEGER AS reports,
                COALESCE(SUM(d.attributed_credits), 0) AS credits
         FROM REPORT_SNAPSHOTS s
         LEFT JOIN REPORT_ATTRIBUTION_DAILY d ON d.report_id = s.report_id AND d.usage_date = s.snapshot_date
         GROUP BY 1 ORDER BY 1`,
      );
      const rows = results.views.OWNER_CHARGEBACK;
      expect(rows).toHaveLength(expected.length + 1); // + the UNATTRIBUTED line
      for (const e of expected) {
        const r = line(rows, e.owner);
        expect(r.snapshot_count, e.owner).toBe(e.snapshots);
        expect(r.report_count, e.owner).toBe(e.reports);
        expect(Math.abs(r.attributed_credits - e.credits), e.owner).toBeLessThan(1e-6);
      }
    });

    it('ownership churn shows up: user_3 point-in-time ≠ current-owner total', () => {
      const pit = line(results.views.OWNER_CHARGEBACK, 'user_3@company.com');
      const cur = line(results.views.OWNER_CHARGEBACK_CURRENT, 'user_3@company.com');
      expect(pit.snapshot_count).not.toBe(cur.snapshot_count);
      expect(Math.abs(pit.attributed_credits - cur.attributed_credits)).toBeGreaterThan(1000);
    });

    it('both chargebacks carry UNOWNED and UNATTRIBUTED lines and sum to total attribution', () => {
      const total = sum(results.views.REPORT_ATTRIBUTION.map((r) => r.attributed_credits));
      for (const view of ['OWNER_CHARGEBACK', 'OWNER_CHARGEBACK_CURRENT'] as const) {
        const rows = results.views[view];
        expect(line(rows, 'UNATTRIBUTED'), view).toEqual(
          expect.objectContaining({ report_count: 0, snapshot_count: 0, attributed_credits: 0 }),
        );
        expect(line(rows, 'UNOWNED').report_count, view).toBeGreaterThan(0);
        expect(Math.abs(sum(rows.map((r) => r.attributed_credits)) - total), view).toBeLessThan(
          1e-6,
        );
        expect(sum(rows.map((r) => r.share_of_total_cost)), view).toBeCloseTo(1, 12);
      }
    });
  });

  describe('anomalies', () => {
    it('24 negative-credit rows from the quarantine (−13.6 … −0.8)', () => {
      const rows = results.views.ANOMALY_NEGATIVE_CREDITS;
      expect(rows).toHaveLength(24);
      expect(Math.min(...rows.map((r) => r.raw_credits))).toBe(-13.6);
      expect(Math.max(...rows.map((r) => r.raw_credits))).toBe(-0.8);
    });

    it('30 AWS-vs-views mismatches, 18 of them on the hard rule', () => {
      const rows = results.views.ANOMALY_AWS_VIEWS_MISMATCH;
      expect(rows).toHaveLength(30);
      expect(rows.filter((r) => r.reason !== 'ROBUST_Z')).toHaveLength(18);
      expect(rows.filter((r) => r.reason === 'BOTH')).toHaveLength(15);
    });

    it('orphaned: the 245 snapshots with no owner (14 at the latest), any usage, no savings', () => {
      const rows = results.views.ANOMALY_ORPHANED_REPORTS;
      expect(rows).toHaveLength(245);
      expect(rows.every((r) => r.snapshot_owner === null && !r.is_overridden)).toBe(true);
      expect(rows.filter((r) => r.snapshot_idx === config.SNAPSHOT_COUNT - 1)).toHaveLength(14);
      for (const r of rows) {
        expect(r.is_zombie).toBe(r.views < config.COST_LOW_VIEWS);
        expect(r).not.toHaveProperty('estimated_monthly_savings_usd');
      }
      // Any usage: orphans with plenty of views are listed too.
      expect(rows.some((r) => r.views >= config.COST_LOW_VIEWS)).toBe(true);
    });

    it('zombies: the 68 low-view snapshots (5 at the latest), owned or not, with savings', () => {
      const rows = results.views.ANOMALY_ZOMBIE_REPORTS;
      expect(rows).toHaveLength(68);
      expect(rows.filter((r) => r.snapshot_idx === config.SNAPSHOT_COUNT - 1)).toHaveLength(5);
      expect(rows.every((r) => r.views < config.COST_LOW_VIEWS)).toBe(true);
      expect(rows.some((r) => r.is_orphaned)).toBe(true);
      expect(rows.some((r) => !r.is_orphaned)).toBe(true);
      for (const r of rows) {
        if (r.attributed_credits === null) {
          // Quarantined credits (DQ02): unknown cost, so unknown savings, not 0.
          expect(r.estimated_monthly_savings_credits).toBeNull();
          expect(r.estimated_monthly_savings_usd).toBeNull();
        } else {
          expect(r.estimated_monthly_savings_credits).toBeCloseTo(
            r.attributed_credits * config.DAYS_PER_MONTH,
            9,
          );
          expect(r.estimated_monthly_savings_usd).toBeCloseTo(
            r.attributed_credits * config.CREDIT_PRICE_USD * config.DAYS_PER_MONTH,
            6,
          );
        }
      }
      expect(rows.filter((r) => r.attributed_credits === null)).toHaveLength(1);
    });

    it('cost-per-view outliers all exceed the robust-z threshold', () => {
      const rows = results.views.ANOMALY_COST_PER_VIEW;
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => Math.abs(r.robust_z) > config.COST_ROBUST_Z)).toBe(true);
    });
  });

  describe('owner overrides (REPORT_CURRENT_OWNER)', () => {
    const USER_3 = 'user_3@company.com';
    const chargebackLine = async (owner: string) =>
      one<{ report_count: number; attributed_credits: number }>(
        `SELECT report_count, attributed_credits FROM OWNER_CHARGEBACK_CURRENT WHERE owner = '${owner}'`,
      );
    afterAll(() => db.conn.run('DELETE FROM OWNER_OVERRIDES'));

    it('with no overrides the view equals REPORTS.current_owner', async () => {
      const r = await one<{ n: number; differ: number; overridden: number }>(`
        SELECT count(*)::INTEGER AS n,
               count_if(o.current_owner IS DISTINCT FROM r.current_owner)::INTEGER AS differ,
               count_if(o.is_overridden)::INTEGER AS overridden
        FROM REPORT_CURRENT_OWNER o JOIN REPORTS r USING (report_id)`);
      expect(r).toEqual({ n: 100, differ: 0, overridden: 0 });
    });

    it('an override moves cost between owners in the live views; every check still PASSes', async () => {
      const { report_id: moved } = await one<{ report_id: string }>(
        `SELECT report_id FROM REPORTS WHERE current_owner = '${USER_3}' ORDER BY report_id LIMIT 1`,
      );
      const { report_id: orphaned } = await one<{ report_id: string }>(
        `SELECT report_id FROM REPORTS WHERE current_owner IS NULL ORDER BY report_id LIMIT 1`,
      );
      const before = await chargebackLine(USER_3);
      const movedCredits = (
        await one<{ c: number }>(
          `SELECT attributed_credits AS c FROM REPORT_ATTRIBUTION WHERE report_id = '${moved}'`,
        )
      ).c;

      await db.conn.run(
        `INSERT INTO OWNER_OVERRIDES VALUES
           ('${moved}', 'new.owner@company.com', 'admin@pureinsights.dev', now()::TIMESTAMP, 'test'),
           ('${orphaned}', '${USER_3}', 'admin@pureinsights.dev', now()::TIMESTAMP, 'test')`,
      );

      const after = await chargebackLine(USER_3);
      const orphanedCredits = (
        await one<{ c: number }>(
          `SELECT attributed_credits AS c FROM REPORT_ATTRIBUTION WHERE report_id = '${orphaned}'`,
        )
      ).c;
      expect(after.report_count).toBe(before.report_count); // −1 moved away, +1 adopted
      expect(after.attributed_credits - before.attributed_credits).toBeCloseTo(
        orphanedCredits - movedCredits,
        6,
      );
      expect((await chargebackLine('new.owner@company.com')).report_count).toBe(1);
      expect((await chargebackLine('UNOWNED')).report_count).toBe(13);

      // No longer orphaned at any snapshot (the override wins); a zombie row stays, now owned.
      const orphanRows = await all<{ n: number }>(
        db.conn,
        `SELECT count(*)::INTEGER AS n FROM ANOMALY_ORPHANED_REPORTS WHERE report_id = '${orphaned}'`,
      );
      expect(orphanRows[0]!.n).toBe(0);
      const zombie = await all<{ is_orphaned: boolean; current_owner: string }>(
        db.conn,
        `SELECT is_orphaned, current_owner FROM ANOMALY_ZOMBIE_REPORTS WHERE report_id = '${orphaned}'`,
      );
      expect(zombie.every((z) => !z.is_orphaned && z.current_owner === USER_3)).toBe(true);

      const recon = await all<{ check_id: string; status: string }>(
        db.conn,
        'SELECT check_id, status FROM RECONCILIATION',
      );
      expect(recon.filter((r) => r.status !== 'PASS')).toEqual([]);

      // Stored results are frozen at ingest (no overrides); the API must not read owners from them.
      const stored = await one<{ report_count: number }>(
        `SELECT report_count FROM ${RESULTS_SCHEMA}.OWNER_CHARGEBACK_CURRENT WHERE owner = 'UNOWNED'`,
      );
      expect(stored.report_count).toBe(14);
    });

    it('an override to NULL orphans the report', async () => {
      await db.conn.run('DELETE FROM OWNER_OVERRIDES');
      const { report_id } = await one<{ report_id: string }>(
        `SELECT report_id FROM REPORTS WHERE current_owner = '${USER_3}' ORDER BY report_id LIMIT 1`,
      );
      await db.conn.run(
        `INSERT INTO OWNER_OVERRIDES VALUES ('${report_id}', NULL, 'admin@pureinsights.dev', now()::TIMESTAMP, NULL)`,
      );
      const r = await one<{ current_owner: string | null; is_orphaned: boolean }>(
        `SELECT current_owner, is_orphaned FROM REPORT_CURRENT_OWNER WHERE report_id = '${report_id}'`,
      );
      expect(r).toEqual({ current_owner: null, is_orphaned: true });
      expect((await chargebackLine('UNOWNED')).report_count).toBe(15);
    });
  });

  describe('stored results (startup path)', () => {
    it('loadSqlResults returns what runSqlSuite stored, and getSqlResults serves it', async () => {
      const stored = await loadSqlResults(db.conn);
      expect(stored.mode).toBe('stored');
      expect(stored.views).toEqual(results.views);
      expect(getSqlResults()).toBe(stored);
    });

    it('stores a SUITE_FINGERPRINT of the current /sql files and PARAMS', async () => {
      const [row] = await all<{ fingerprint: string }>(
        db.conn,
        `SELECT fingerprint FROM ${RESULTS_SCHEMA}.${FINGERPRINT_TABLE}`,
      );
      expect(row?.fingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(row?.fingerprint).toBe(suiteFingerprint());
    });

    it('the fingerprint changes with any /sql file edit or PARAMS value', () => {
      const inputs = currentFingerprintInputs();
      expect(Object.keys(inputs.sql)).toHaveLength(9); // 00–08
      expect(inputs.params).toMatchObject({
        SIMULATED_OVERHEAD_RATE: 0.15,
        ORPHAN_OWNER_MARKERS: config.ORPHAN_OWNER_MARKERS,
      });
      const base = suiteFingerprint(inputs);
      expect(suiteFingerprint(currentFingerprintInputs())).toBe(base);
      const file = '05_unit_economics.sql';
      const editedSql = { ...inputs.sql, [file]: `${inputs.sql[file]}\n-- a comment` };
      expect(suiteFingerprint({ ...inputs, sql: editedSql })).not.toBe(base);
      const editedParams = { ...inputs.params, CREDIT_PRICE_USD: 3.01 };
      expect(suiteFingerprint({ ...inputs, params: editedParams })).not.toBe(base);
    });

    it('startup refuses results whose SUITE_FINGERPRINT does not match', async () => {
      await db.conn.run(
        `UPDATE ${RESULTS_SCHEMA}.${FINGERPRINT_TABLE} SET fingerprint = 'built-from-older-sql'`,
      );
      await expect(loadSqlResults(db.conn)).rejects.toThrow(SqlSuiteError);
      await expect(loadSqlResults(db.conn)).rejects.toThrow(
        /SUITE_FINGERPRINT mismatch: .*different \/sql files or PARAMS.*Run `npm run ingest`/,
      );
    });

    it('refuses a warehouse with no stored results', async () => {
      await db.conn.run(`DROP SCHEMA ${RESULTS_SCHEMA} CASCADE`);
      await expect(loadSqlResults(db.conn)).rejects.toThrow(
        /No stored SQL results.*npm run ingest/,
      );
    });
  });
});

describe('fail-loud (tampered warehouse)', () => {
  let db: Db;
  const metering = 'ACCOUNT_USAGE.WAREHOUSE_METERING_HISTORY';

  let baselineAttributed = 0;
  /** Σ over the materialized 03 table, i.e. what the last runSqlSuite rebuilt. */
  const queryTableTotal = async (): Promise<number> => {
    const [r] = await all<{ credits: number }>(
      db.conn,
      'SELECT SUM(attributed_credits) AS credits FROM QUERY_ATTRIBUTED_COST',
    );
    return r!.credits;
  };

  beforeAll(async () => {
    db = await buildWarehouse();
    // Untampered baseline: passes, and builds the 03 tables that each tamper must rebuild.
    await runSqlSuite(db.conn);
    baselineAttributed = await queryTableTotal();
  }, 60_000);
  afterAll(() => closeDb(db));

  const failuresOf = async (): Promise<string[]> => {
    try {
      await runSqlSuite(db.conn);
    } catch (err) {
      if (err instanceof ReconciliationError) return err.failures.map((f) => f.split(' ')[0]!);
      throw err;
    }
    return [];
  };

  // The untampered warehouse passes (first describe), so each exact failure list below is caused
  // by its tampering alone.
  it('a drifted PARAMS value stops the suite before it runs, naming the key', async () => {
    await db.conn.run('UPDATE PARAMS SET simulated_overhead_rate = 0.2');
    await expect(runSqlSuite(db.conn)).rejects.toThrow(SqlSuiteError);
    await expect(runSqlSuite(db.conn)).rejects.toThrow(
      /simulated_overhead_rate: sql=0.2 config=0.15/,
    );
    await expect(loadSqlResults(db.conn)).rejects.toThrow(/simulated_overhead_rate/);
    await db.conn.run('UPDATE PARAMS SET simulated_overhead_rate = 0.15');
  });

  it('+1 credit on one metered hour: conservation still holds, ground truth fails', async () => {
    await db.conn.run(`UPDATE ${metering} SET CREDITS_USED = CREDITS_USED + 1
                       WHERE START_TIME = TIMESTAMP '2026-09-25 14:00:00' AND WAREHOUSE_NAME = 'REPORTING_WH_M'`);
    const failures = await failuresOf();
    // 03 spreads whatever is metered, so totals still balance; only the simulator's answer disagrees.
    expect(failures).toEqual([
      'G1_SNAPSHOT_RECOVERS_CREDITS_CLEAN',
      'G2_REPORT_RECOVERS_CREDITS_CLEAN',
    ]);
    // The failure comes from recomputed data: the 03 tables were rebuilt and carry the extra credit.
    expect((await queryTableTotal()) - baselineAttributed).toBeCloseTo(1, 6);
    // Failing results are never stored.
    const [stored] = await all<{ n: number }>(
      db.conn,
      `SELECT count(*)::INTEGER AS n FROM information_schema.schemata WHERE schema_name = '${RESULTS_SCHEMA}'`,
    );
    expect(stored?.n).toBe(0);
    await db.conn.run(`UPDATE ${metering} SET CREDITS_USED = CREDITS_USED_COMPUTE`);
  }, 30_000);

  it('a metered hour with no queries (idle warehouse) breaks conservation', async () => {
    await db.conn.run(`INSERT INTO ${metering} VALUES
      (TIMESTAMP '2030-01-01 00:00:00', TIMESTAMP '2030-01-01 01:00:00', 'ADHOC_WH', 5, 5, 0)`);
    const failures = await failuresOf();
    expect(failures).toEqual(['C1_QUERIES_EQ_METERED', 'C2_EACH_HOUR_EQ_METERED']);
    // Rebuilt 03 tables: the +1 above was restored, and the idle hour allocates to no query.
    expect(Math.abs((await queryTableTotal()) - baselineAttributed)).toBeLessThan(1e-6);
    const [slices] = await all<{ n: number }>(
      db.conn,
      `SELECT count(*)::INTEGER AS n FROM QUERY_HOUR_COST WHERE hour_start = TIMESTAMP '2030-01-01 00:00:00'`,
    );
    expect(slices?.n).toBe(0);
    await db.conn.run(`DELETE FROM ${metering} WHERE START_TIME = TIMESTAMP '2030-01-01 00:00:00'`);
  }, 30_000);

  it('an untagged query (real-world ad hoc usage): conservation holds via UNATTRIBUTED; only ground truth fails', async () => {
    await db.conn.run(`INSERT INTO ACCOUNT_USAGE.QUERY_HISTORY VALUES
      ('adhoc-0001', '', 'REPORTING_WH_M', 'ANALYST', 'SYSADMIN',
       TIMESTAMP '2026-09-25 14:10:00', TIMESTAMP '2026-09-25 14:20:00', 600000, 'SUCCESS', NULL)`);
    const failures = await failuresOf();
    // It takes a share of its hour from tagged queries (G1, G2) and is untagged (G4).
    expect(failures).toEqual([
      'G1_SNAPSHOT_RECOVERS_CREDITS_CLEAN',
      'G2_REPORT_RECOVERS_CREDITS_CLEAN',
      'G4_ALL_QUERIES_TAGGED',
    ]);
    // Its credits are reported, not lost: the same amount on every UNATTRIBUTED line.
    const [r] = await all<{ query: number; report_line: number; pit: number; cur: number }>(
      db.conn,
      `SELECT (SELECT attributed_credits FROM QUERY_ATTRIBUTED_COST WHERE QUERY_ID = 'adhoc-0001') AS query,
              (SELECT attributed_credits FROM REPORT_ATTRIBUTION WHERE report_id = 'UNATTRIBUTED') AS report_line,
              (SELECT attributed_credits FROM OWNER_CHARGEBACK WHERE owner = 'UNATTRIBUTED') AS pit,
              (SELECT attributed_credits FROM OWNER_CHARGEBACK_CURRENT WHERE owner = 'UNATTRIBUTED') AS cur`,
    );
    expect(r!.query).toBeGreaterThan(0);
    for (const v of [r!.report_line, r!.pit, r!.cur])
      expect(Math.abs(v - r!.query)).toBeLessThan(1e-9);
    await db.conn.run(`DELETE FROM ACCOUNT_USAGE.QUERY_HISTORY WHERE QUERY_ID = 'adhoc-0001'`);
  }, 30_000);
});
