import type { DuckDBValue } from '@duckdb/node-api';
import type {
  LatencyBucket,
  OverviewKpis,
  OverviewScope,
  OverviewTrend,
  PeriodOverview,
  RefreshCounts,
} from '@pic/shared';
import { scopeSql, type Scope } from '../auth/scope.js';
import { config } from '../config.js';
import type { Queryable } from '../data/warehouse.js';
import { snapshotDateFor } from '../realtime/clock.js';
import { RESULTS_SCHEMA } from '../sql/runner.js';

interface OverviewRow extends RefreshCounts {
  reportCount: number;
  orphanedCount: number;
  slowCount: number;
  criticalSlowCount: number;
  avgLoadTimeSec: number | null;
  maxLoadTimeSec: number | null;
  totalViews: number;
  attributedCostUsd: number;
  snapshotSnowflakeCostUsd: number;
  snapshotAwsCostUsd: number;
}

/** KPIs for the snapshot at `tick`, over the reports in scope. Alert counts come from the engine. */
export async function getOverview(
  db: Queryable,
  scope: Scope,
  tick: number,
): Promise<Omit<OverviewKpis, 'alerts'>> {
  const params: DuckDBValue[] = [tick, config.LATENCY_WARNING_SEC, config.LATENCY_CRITICAL_SEC];
  const [row] = await db.query<OverviewRow>(
    `SELECT
       COUNT(*)::INTEGER                                              AS "reportCount",
       COUNT_IF(o.is_orphaned)::INTEGER                               AS "orphanedCount",
       COUNT_IF(s.last_refresh_status = 'SUCCESS')::INTEGER           AS "SUCCESS",
       COUNT_IF(s.last_refresh_status = 'FAILED')::INTEGER            AS "FAILED",
       COUNT_IF(s.last_refresh_status = 'TIMED_OUT')::INTEGER         AS "TIMED_OUT",
       COUNT_IF(s.last_refresh_status = 'UNKNOWN')::INTEGER           AS "UNKNOWN",
       COUNT_IF(s.avg_load_time_sec > $2)::INTEGER                    AS "slowCount",
       COUNT_IF(s.avg_load_time_sec > $3)::INTEGER                    AS "criticalSlowCount",
       AVG(s.avg_load_time_sec)                                       AS "avgLoadTimeSec",
       MAX(s.avg_load_time_sec)                                       AS "maxLoadTimeSec",
       COALESCE(SUM(s.monthly_active_views), 0)::INTEGER              AS "totalViews",
       COALESCE(SUM(a.attributed_cost_usd), 0)                        AS "attributedCostUsd",
       COALESCE(SUM(u.snowflake_cost_usd), 0)                         AS "snapshotSnowflakeCostUsd",
       COALESCE(SUM(u.aws_cost_usd), 0)                               AS "snapshotAwsCostUsd"
     FROM REPORT_SNAPSHOTS s
     JOIN REPORT_CURRENT_OWNER o ON o.report_id = s.report_id
     JOIN ${RESULTS_SCHEMA}.UNIT_ECONOMICS_SNAPSHOT u
       ON u.report_id = s.report_id AND u.snapshot_idx = s.snapshot_idx
     JOIN ${RESULTS_SCHEMA}.REPORT_ATTRIBUTION a ON a.report_id = s.report_id
     WHERE s.snapshot_idx = $1 AND ${scopeSql(scope, 'o.current_owner', params)}`,
    params,
  );
  if (!row) throw new Error('overview query returned no row');

  return {
    scope: 'today',
    tick,
    snapshotIdx: tick,
    snapshotDate: snapshotDateFor(tick),
    reportCount: row.reportCount,
    orphanedCount: row.orphanedCount,
    refresh: {
      SUCCESS: row.SUCCESS,
      FAILED: row.FAILED,
      TIMED_OUT: row.TIMED_OUT,
      UNKNOWN: row.UNKNOWN,
    },
    slowCount: row.slowCount,
    criticalSlowCount: row.criticalSlowCount,
    avgLoadTimeSec: row.avgLoadTimeSec,
    maxLoadTimeSec: row.maxLoadTimeSec,
    totalViews: row.totalViews,
    totals: {
      attributedCostUsd: row.attributedCostUsd,
      snapshotSnowflakeCostUsd: row.snapshotSnowflakeCostUsd,
      snapshotAwsCostUsd: row.snapshotAwsCostUsd,
    },
  };
}

/**
 * Period to date: snapshots 0..`tick`, over the caller's scope, read from the live
 * PERIOD_TO_DATE view (/sql/09; live because rows are grouped by current owner). Unscoped
 * callers get the portfolio row; an owner gets their own row. Nothing is computed here.
 */
export async function getPeriodOverview(
  db: Queryable,
  scope: Scope,
  tick: number,
): Promise<PeriodOverview> {
  const params: DuckDBValue[] = [tick];
  const where =
    scope.kind === 'all'
      ? `scope_kind = 'ALL'`
      : `scope_kind = 'OWNER' AND ${scopeSql(scope, 'current_owner', params)}`;
  const [row] = await db.query<{
    reportCount: number;
    SUCCESS: number;
    FAILED: number;
    TIMED_OUT: number;
    UNKNOWN: number;
    refreshCount: number;
    refreshSuccessRate: number | null;
    everOrphanedCount: number;
    quarantinedSnapshotCount: number;
    avgLoadTimeSec: number | null;
    p95LoadTimeSec: number | null;
    snowflakeCostToDateUsd: number;
  }>(
    `SELECT report_count               AS "reportCount",
            success_count              AS "SUCCESS",
            failed_count               AS "FAILED",
            timed_out_count            AS "TIMED_OUT",
            unknown_count              AS "UNKNOWN",
            refresh_count              AS "refreshCount",
            refresh_success_rate       AS "refreshSuccessRate",
            ever_orphaned_count        AS "everOrphanedCount",
            quarantined_snapshot_count AS "quarantinedSnapshotCount",
            avg_load_time_sec          AS "avgLoadTimeSec",
            p95_load_time_sec          AS "p95LoadTimeSec",
            snowflake_cost_to_date_usd AS "snowflakeCostToDateUsd"
     FROM PERIOD_TO_DATE
     WHERE period_end_idx = $1 AND ${where}`,
    params,
  );
  // An owner with no reports has no row: an empty period, not an error.
  return {
    scope: 'period',
    tick,
    snapshotIdx: tick,
    fromDate: snapshotDateFor(0),
    toDate: snapshotDateFor(tick),
    snapshotCount: tick + 1,
    reportCount: row?.reportCount ?? 0,
    refresh: {
      SUCCESS: row?.SUCCESS ?? 0,
      FAILED: row?.FAILED ?? 0,
      TIMED_OUT: row?.TIMED_OUT ?? 0,
      UNKNOWN: row?.UNKNOWN ?? 0,
    },
    refreshCount: row?.refreshCount ?? 0,
    refreshSuccessRate: row?.refreshSuccessRate ?? null,
    everOrphanedCount: row?.everOrphanedCount ?? 0,
    quarantinedSnapshotCount: row?.quarantinedSnapshotCount ?? 0,
    avgLoadTimeSec: row?.avgLoadTimeSec ?? null,
    p95LoadTimeSec: row?.p95LoadTimeSec ?? null,
    totals: { snowflakeCostToDateUsd: row?.snowflakeCostToDateUsd ?? 0 },
  };
}

interface TrendRow extends RefreshCounts {
  snapshotIdx: number;
  slowCount: number;
}

/** Counts load times into [0, e1), [e1, e2) … [eN, ∞) for the edges in `edges` (ascending). */
export function bucketLatencies(
  loadTimes: readonly number[],
  edges: readonly number[],
): LatencyBucket[] {
  const buckets: LatencyBucket[] = [0, ...edges].map((lowerSec, i) => ({
    lowerSec,
    upperSec: edges[i] ?? null,
    count: 0,
  }));
  for (const t of loadTimes) {
    const i = edges.filter((edge) => t >= edge).length;
    buckets[i]!.count += 1;
  }
  return buckets;
}

/**
 * Refresh counts for every snapshot, and the load-time histogram over the scope: of snapshot
 * `tick` (today) or of snapshots 0..`tick` (period).
 */
export async function getOverviewTrend(
  db: Queryable,
  scope: Scope,
  tick: number,
  overviewScope: OverviewScope = 'today',
): Promise<OverviewTrend> {
  const trendParams: DuckDBValue[] = [config.LATENCY_WARNING_SEC];
  const rows = await db.query<TrendRow>(
    `SELECT
       s.snapshot_idx::INTEGER                                        AS "snapshotIdx",
       COUNT_IF(s.last_refresh_status = 'SUCCESS')::INTEGER           AS "SUCCESS",
       COUNT_IF(s.last_refresh_status = 'FAILED')::INTEGER            AS "FAILED",
       COUNT_IF(s.last_refresh_status = 'TIMED_OUT')::INTEGER         AS "TIMED_OUT",
       COUNT_IF(s.last_refresh_status = 'UNKNOWN')::INTEGER           AS "UNKNOWN",
       COUNT_IF(s.avg_load_time_sec > $1)::INTEGER                    AS "slowCount"
     FROM REPORT_SNAPSHOTS s
     JOIN REPORT_CURRENT_OWNER o ON o.report_id = s.report_id
     WHERE ${scopeSql(scope, 'o.current_owner', trendParams)}
     GROUP BY s.snapshot_idx
     ORDER BY s.snapshot_idx`,
    trendParams,
  );

  const loadParams: DuckDBValue[] = [tick];
  const loads = await db.query<{ loadTimeSec: number }>(
    `SELECT s.avg_load_time_sec AS "loadTimeSec"
     FROM REPORT_SNAPSHOTS s
     JOIN REPORT_CURRENT_OWNER o ON o.report_id = s.report_id
     WHERE s.snapshot_idx ${overviewScope === 'period' ? '<=' : '='} $1
       AND ${scopeSql(scope, 'o.current_owner', loadParams)}`,
    loadParams,
  );

  return {
    scope: overviewScope,
    currentIdx: tick,
    points: rows.map((r) => ({
      snapshotIdx: r.snapshotIdx,
      snapshotDate: snapshotDateFor(r.snapshotIdx),
      refresh: { SUCCESS: r.SUCCESS, FAILED: r.FAILED, TIMED_OUT: r.TIMED_OUT, UNKNOWN: r.UNKNOWN },
      slowCount: r.slowCount,
    })),
    latency: bucketLatencies(
      loads.map((l) => l.loadTimeSec),
      config.LATENCY_BUCKET_EDGES_SEC,
    ),
    thresholds: {
      warningSec: config.LATENCY_WARNING_SEC,
      criticalSec: config.LATENCY_CRITICAL_SEC,
    },
  };
}
