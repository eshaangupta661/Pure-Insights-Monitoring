/*
 * Reports at the replay's current snapshot, scoped in SQL.
 *
 * Two owners per row. `snapshotOwner` is the owner at the replay's snapshot (what the UI shows);
 * `currentOwner` comes from REPORT_CURRENT_OWNER (live: admin overrides apply) and is what scoping
 * filters on. Cost comes from the results stored at ingest (SQL_RESULTS), which is fine because
 * cost doesn't depend on ownership; their current_owner columns are never read (frozen at ingest).
 */
import type { DuckDBValue } from '@duckdb/node-api';
import type {
  OwnerOverrideInfo,
  Page,
  ReportCost,
  ReportDetail,
  ReportSummary,
  SnapshotPoint,
} from '@pic/shared';
import type { ReportsQuery } from '../api/schemas.js';
import { scopeSql, type Scope } from '../auth/scope.js';
import { config } from '../config.js';
import type { Queryable } from '../data/warehouse.js';
import { paginate } from '../http/pagination.js';
import { RESULTS_SCHEMA } from '../sql/runner.js';
import { isoTimestampSql } from './audit.js';

/** The owner shown at the replay's snapshot: an admin override wins, else that snapshot's owner. */
const OWNER_AT_SNAPSHOT = 'CASE WHEN o.is_overridden THEN o.current_owner ELSE s.owner_email END';

const SUMMARY_SELECT = `
  SELECT
    s.report_id                    AS "reportId",
    s.report_name                  AS "reportName",
    s.owner_email                  AS "snapshotOwner",
    o.current_owner                AS "currentOwner",
    (${OWNER_AT_SNAPSHOT}) IS NULL AS "isOrphaned",
    o.is_overridden                AS "isOverridden",
    s.snapshot_idx                 AS "snapshotIdx",
    s.snapshot_date                AS "snapshotDate",
    s.last_refresh_status          AS "refreshStatus",
    s.avg_load_time_sec            AS "loadTimeSec",
    s.monthly_active_views         AS "monthlyActiveViews",
    s.concurrent_user_peak         AS "concurrentUserPeak",
    s.dq_flags                     AS "dqFlags",
    r.owner_change_count           AS "ownerChangeCount",
    u.snowflake_cost_usd           AS "snowflakeCostUsd",
    u.aws_cost_usd                 AS "awsCostUsd",
    u.fully_loaded_cost_per_view   AS "fullyLoadedCostPerView",
    a.attributed_cost_usd          AS "attributedCostUsd"
  FROM REPORT_SNAPSHOTS s
  JOIN REPORTS r                ON r.report_id = s.report_id
  JOIN REPORT_CURRENT_OWNER o   ON o.report_id = s.report_id
  JOIN ${RESULTS_SCHEMA}.UNIT_ECONOMICS_SNAPSHOT u
                                ON u.report_id = s.report_id AND u.snapshot_idx = s.snapshot_idx
  JOIN ${RESULTS_SCHEMA}.REPORT_ATTRIBUTION a ON a.report_id = s.report_id`;

const SORT_COLUMNS: Record<ReportsQuery['sort'], string> = {
  reportId: '"reportId"',
  loadTime: '"loadTimeSec"',
  views: '"monthlyActiveViews"',
  status: '"refreshStatus"',
};

export async function listReports(
  db: Queryable,
  scope: Scope,
  tick: number,
  query: ReportsQuery,
): Promise<Page<ReportSummary>> {
  const params: DuckDBValue[] = [tick];
  const where = ['s.snapshot_idx = $1', scopeSql(scope, 'o.current_owner', params)];
  if (query.q) {
    params.push(query.q.toLowerCase());
    const n = `$${params.length}`;
    where.push(
      `(contains(lower(s.report_id), ${n}) OR contains(lower(s.report_name), ${n})` +
        ` OR contains(COALESCE(s.owner_email, ''), ${n})` +
        ` OR (o.is_overridden AND contains(COALESCE(o.current_owner, ''), ${n})))`,
    );
  }
  if (query.status) {
    params.push(query.status);
    where.push(`s.last_refresh_status = $${params.length}`);
  }
  if (query.orphaned !== undefined)
    where.push(`(${OWNER_AT_SNAPSHOT}) IS ${query.orphaned ? '' : 'NOT '}NULL`);
  if (query.slow !== undefined) {
    params.push(config.LATENCY_WARNING_SEC);
    where.push(`${query.slow ? '' : 'NOT '}(s.avg_load_time_sec > $${params.length})`);
  }

  // Whitelisted column, then report_id so the order is total and pages never overlap.
  const direction = query.order === 'desc' ? 'DESC' : 'ASC';
  const orderBy = `${SORT_COLUMNS[query.sort]} ${direction}, "reportId" ASC`;
  return paginate<ReportSummary>(
    db,
    `${SUMMARY_SELECT} WHERE ${where.join(' AND ')}`,
    params,
    orderBy,
    query,
  );
}

/** One report with its 20-snapshot history, or null when it doesn't exist or is out of scope. */
export async function getReport(
  db: Queryable,
  scope: Scope,
  tick: number,
  reportId: string,
): Promise<ReportDetail | null> {
  const params: DuckDBValue[] = [tick, reportId];
  const [summary] = await db.query<ReportSummary>(
    `${SUMMARY_SELECT}
     WHERE s.snapshot_idx = $1 AND s.report_id = $2 AND ${scopeSql(scope, 'o.current_owner', params)}`,
    params,
  );
  // Everything below is keyed by a report the scoped query just returned.
  if (!summary) return null;

  const history = await db.query<SnapshotPoint>(
    `SELECT
       s.snapshot_idx                 AS "snapshotIdx",
       s.snapshot_date                AS "snapshotDate",
       s.owner_email                  AS "ownerEmail",
       s.last_refresh_status          AS "refreshStatus",
       s.avg_load_time_sec            AS "loadTimeSec",
       s.monthly_active_views         AS "monthlyActiveViews",
       s.concurrent_user_peak         AS "concurrentUserPeak",
       s.query_count_last_30d         AS "queryCount",
       s.dq_flags                     AS "dqFlags",
       s.snowflake_credits_consumed   AS "creditsReported",
       u.attributed_credits           AS "attributedCredits",
       u.snowflake_cost_usd           AS "snowflakeCostUsd",
       u.aws_cost_usd                 AS "awsCostUsd",
       u.fully_loaded_cost_usd        AS "fullyLoadedCostUsd",
       u.fully_loaded_cost_per_view   AS "fullyLoadedCostPerView"
     FROM REPORT_SNAPSHOTS s
     JOIN ${RESULTS_SCHEMA}.UNIT_ECONOMICS_SNAPSHOT u
       ON u.report_id = s.report_id AND u.snapshot_idx = s.snapshot_idx
     WHERE s.report_id = $1
     ORDER BY s.snapshot_idx`,
    [reportId],
  );

  const [owners] = await db.query<{ ownerHistory: (string | null)[] }>(
    'SELECT owner_history AS "ownerHistory" FROM REPORTS WHERE report_id = $1',
    [reportId],
  );

  const [override] = await db.query<OwnerOverrideInfo>(
    `SELECT owner_email AS "ownerEmail", set_by AS "setBy",
            ${isoTimestampSql('set_at')} AS "setAt", reason
     FROM OWNER_OVERRIDES WHERE report_id = $1`,
    [reportId],
  );

  const [cost] = await db.query<ReportCost>(
    `SELECT
       a.query_count               AS "queryCount",
       a.attributed_credits        AS "attributedCredits",
       a.attributed_cost_usd       AS "attributedCostUsd",
       e.costed_snapshot_count     AS "costedSnapshotCount",
       e.fully_loaded_cost_usd     AS "fullyLoadedCostUsd",
       e.fully_loaded_cost_per_view AS "fullyLoadedCostPerView"
     FROM ${RESULTS_SCHEMA}.REPORT_ATTRIBUTION a
     JOIN ${RESULTS_SCHEMA}.UNIT_ECONOMICS_REPORT e ON e.report_id = a.report_id
     WHERE a.report_id = $1`,
    [reportId],
  );
  if (!owners || !cost) throw new Error(`${reportId}: REPORTS or cost rows missing`);

  return {
    ...summary,
    ownerHistory: owners.ownerHistory,
    override: override ?? null,
    history,
    cost,
  };
}
