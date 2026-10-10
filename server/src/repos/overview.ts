import type { DuckDBValue } from '@duckdb/node-api';
import type { OverviewKpis, RefreshCounts } from '@pic/shared';
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
