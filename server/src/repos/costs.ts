/*
 * Cost attribution reads (/sql 04–07), scoped in SQL.
 *
 * Numbers that don't depend on ownership come from the results stored at ingest
 * (SQL_RESULTS); the owner always comes from the live REPORT_CURRENT_OWNER. The two row sets
 * whose membership depends on ownership (OWNER_CHARGEBACK_CURRENT, ANOMALY_ZOMBIE_REPORTS) are
 * read from the live views, so admin overrides show up immediately.
 *
 * Shares are computed over the rows in the caller's scope (a window over the filtered rows), so
 * an owner's shares sum to 1 over their own reports and reveal nothing about the portfolio total.
 */
import type { DuckDBValue } from '@duckdb/node-api';
import type {
  AnomalyReport,
  AwsViewsMismatch,
  ChargebackRow,
  ChargebackTotals,
  ChargebackView,
  CostReportsTotals,
  CostRow,
  PageWithTotals,
  PerViewOutlier,
  QuarantinedSnapshot,
  UnitEconomicsRow,
  UnitEconomicsTotals,
  ZombieReport,
} from '@pic/shared';
import { scopeSql, type Scope } from '../auth/scope.js';
import { config } from '../config.js';
import type { Queryable } from '../data/warehouse.js';
import { paginate, type PageQuery } from '../http/pagination.js';
import { RESULTS_SCHEMA } from '../sql/runner.js';

async function withTotals<T, U>(
  db: Queryable,
  baseSql: string,
  params: DuckDBValue[],
  orderBy: string,
  page: PageQuery,
  totalsSql: string,
): Promise<PageWithTotals<T, U>> {
  const result = await paginate<T>(db, baseSql, params, orderBy, page);
  const [totals] = await db.query<U>(`WITH scoped AS (${baseSql}) ${totalsSql}`, params);
  if (!totals) throw new Error('totals query returned no row');
  return { ...result, totals };
}

// ---- per-report attribution (04) --------------------------------------------------------

/** REPORT_ATTRIBUTION, including the always-present UNATTRIBUTED line for unscoped callers. */
export function listCostReports(
  db: Queryable,
  scope: Scope,
  orderBy: string,
  page: PageQuery,
): Promise<PageWithTotals<CostRow, CostReportsTotals>> {
  const params: DuckDBValue[] = [];
  const sql = `
    SELECT
      a.report_id            AS "reportId",
      a.report_name          AS "reportName",
      o.current_owner        AS "currentOwner",
      a.query_count          AS "queryCount",
      a.attributed_credits   AS "attributedCredits",
      a.active_credits       AS "activeCredits",
      a.overhead_credits     AS "overheadCredits",
      a.attributed_cost_usd  AS "attributedCostUsd",
      a.attributed_credits / NULLIF(SUM(a.attributed_credits) OVER (), 0) AS "shareOfTotal"
    FROM ${RESULTS_SCHEMA}.REPORT_ATTRIBUTION a
    LEFT JOIN REPORT_CURRENT_OWNER o ON o.report_id = a.report_id
    WHERE ${scopeSql(scope, 'o.current_owner', params)}`;
  return withTotals(
    db,
    sql,
    params,
    orderBy,
    page,
    `SELECT COUNT(*)::INTEGER                           AS "lineCount",
            COALESCE(SUM("queryCount"), 0)::INTEGER     AS "queryCount",
            COALESCE(SUM("attributedCredits"), 0)       AS "attributedCredits",
            COALESCE(SUM("attributedCostUsd"), 0)       AS "attributedCostUsd"
     FROM scoped`,
  );
}

// ---- unit economics (05) ----------------------------------------------------------------

export function listUnitEconomics(
  db: Queryable,
  scope: Scope,
  orderBy: string,
  page: PageQuery,
): Promise<PageWithTotals<UnitEconomicsRow, UnitEconomicsTotals>> {
  const params: DuckDBValue[] = [];
  const sql = `
    SELECT
      e.report_id                   AS "reportId",
      e.report_name                 AS "reportName",
      o.current_owner               AS "currentOwner",
      e.snapshot_count              AS "snapshotCount",
      e.costed_snapshot_count       AS "costedSnapshotCount",
      e.snowflake_cost_usd          AS "snowflakeCostUsd",
      e.aws_cost_usd                AS "awsCostUsd",
      e.fully_loaded_cost_usd       AS "fullyLoadedCostUsd",
      e.costed_views                AS "costedViews",
      e.snowflake_cost_per_view     AS "snowflakeCostPerView",
      e.fully_loaded_cost_per_view  AS "fullyLoadedCostPerView"
    FROM ${RESULTS_SCHEMA}.UNIT_ECONOMICS_REPORT e
    JOIN REPORT_CURRENT_OWNER o ON o.report_id = e.report_id
    WHERE ${scopeSql(scope, 'o.current_owner', params)}`;
  return withTotals(
    db,
    sql,
    params,
    orderBy,
    page,
    // Ratio of totals over costed snapshots, like the per-report column (/sql/05).
    `SELECT COUNT(*)::INTEGER                             AS "reportCount",
            COALESCE(SUM("snowflakeCostUsd"), 0)          AS "snowflakeCostUsd",
            COALESCE(SUM("awsCostUsd"), 0)                AS "awsCostUsd",
            COALESCE(SUM("fullyLoadedCostUsd"), 0)        AS "fullyLoadedCostUsd",
            COALESCE(SUM("costedViews"), 0)::INTEGER      AS "costedViews",
            SUM("fullyLoadedCostUsd") / NULLIF(SUM("costedViews"), 0) AS "fullyLoadedCostPerView"
     FROM scoped`,
  );
}

// ---- anomalies (06) ---------------------------------------------------------------------

/**
 * How anomaly rows are ordered. 'severity' puts the most expensive / extreme first (admins,
 * owners). 'neutral' orders by report and snapshot only: viewers must not be able to read cost
 * ranks from the row order (the same reason http/sort.ts refuses cost sorts for them).
 */
export type AnomalyOrder = 'severity' | 'neutral';

export async function getAnomalies(
  db: Queryable,
  scope: Scope,
  order: AnomalyOrder,
): Promise<AnomalyReport> {
  const by = (severity: string, neutral: string) => (order === 'severity' ? severity : neutral);
  const scoped = (column: string) => {
    const params: DuckDBValue[] = [];
    return { where: scopeSql(scope, column, params), params };
  };

  const pv = scoped('o.current_owner');
  const perViewOutliers = await db.query<PerViewOutlier>(
    `SELECT x.report_id AS "reportId", x.report_name AS "reportName", o.current_owner AS "currentOwner",
            x.snapshot_idx AS "snapshotIdx", x.snapshot_date AS "snapshotDate", x.views,
            x.robust_z AS "robustZ", x.direction,
            x.fully_loaded_cost_per_view AS "fullyLoadedCostPerView"
     FROM ${RESULTS_SCHEMA}.ANOMALY_COST_PER_VIEW x
     JOIN REPORT_CURRENT_OWNER o ON o.report_id = x.report_id
     WHERE ${pv.where}
     ORDER BY ${by('ABS(x.robust_z) DESC, x.report_id, x.snapshot_idx', 'x.report_id, x.snapshot_idx')}`,
    pv.params,
  );

  // Live view: membership depends on the current owner (an orphaned report is a zombie).
  const z = scoped('z.current_owner');
  const zombieRows = await db.query<Omit<ZombieReport, 'estimatedMonthlySavingsUsd'>>(
    `SELECT z.report_id AS "reportId", z.report_name AS "reportName", z.current_owner AS "currentOwner",
            z.latest_snapshot_idx AS "latestSnapshotIdx", z.latest_views AS "latestViews", z.reason,
            z.latest_attributed_credits AS "latestAttributedCredits",
            z.latest_snowflake_cost_usd AS "latestSnowflakeCostUsd",
            z.total_attributed_credits AS "totalAttributedCredits",
            z.total_attributed_cost_usd AS "totalAttributedCostUsd"
     FROM ANOMALY_ZOMBIE_REPORTS z
     WHERE ${z.where}
     ORDER BY ${by('z.total_attributed_credits DESC, z.report_id', 'z.report_id')}`,
    z.params,
  );

  const zombies: ZombieReport[] = zombieRows.map((r) => ({
    ...r,
    estimatedMonthlySavingsUsd: r.latestSnowflakeCostUsd * config.SAVINGS_DAYS_PER_MONTH,
  }));

  const aws = scoped('o.current_owner');
  const awsViewsMismatch = await db.query<AwsViewsMismatch>(
    `SELECT m.report_id AS "reportId", m.report_name AS "reportName", o.current_owner AS "currentOwner",
            m.snapshot_idx AS "snapshotIdx", m.views, m.aws_log_z AS "awsLogZ", m.reason,
            m.aws_cost_usd AS "awsCostUsd", m.aws_cost_per_view AS "awsCostPerView"
     FROM ${RESULTS_SCHEMA}.ANOMALY_AWS_VIEWS_MISMATCH m
     JOIN REPORT_CURRENT_OWNER o ON o.report_id = m.report_id
     WHERE ${aws.where}
     ORDER BY ${by('m.aws_cost_per_view DESC NULLS FIRST, m.row_idx', 'm.report_id, m.snapshot_idx, m.row_idx')}`,
    aws.params,
  );

  const q = scoped('o.current_owner');
  const quarantinedSnapshots = await db.query<QuarantinedSnapshot>(
    `SELECT n.report_id AS "reportId", n.report_name AS "reportName", o.current_owner AS "currentOwner",
            n.snapshot_idx AS "snapshotIdx", n.reason, n.raw_credits AS "rawCredits"
     FROM ${RESULTS_SCHEMA}.ANOMALY_NEGATIVE_CREDITS n
     JOIN REPORT_CURRENT_OWNER o ON o.report_id = n.report_id
     WHERE ${q.where}
     ORDER BY ${by('n.raw_credits, n.row_idx', 'n.report_id, n.snapshot_idx, n.row_idx')}`,
    q.params,
  );

  return { perViewOutliers, zombies, awsViewsMismatch, quarantinedSnapshots };
}

// ---- owner chargeback (07) --------------------------------------------------------------

/**
 * point_in_time reads the stored OWNER_CHARGEBACK (snapshot owners don't change at runtime);
 * current reads the live OWNER_CHARGEBACK_CURRENT, which follows overrides. An owner sees only
 * their own line; UNOWNED and UNATTRIBUTED are visible to unscoped callers.
 */
export function listChargeback(
  db: Queryable,
  scope: Scope,
  view: ChargebackView,
  orderBy: string,
  page: PageQuery,
): Promise<PageWithTotals<ChargebackRow, ChargebackTotals>> {
  const source =
    view === 'current' ? 'OWNER_CHARGEBACK_CURRENT' : `${RESULTS_SCHEMA}.OWNER_CHARGEBACK`;
  const params: DuckDBValue[] = [];
  const sql = `
    SELECT
      c.owner,
      c.report_count        AS "reportCount",
      c.snapshot_count      AS "snapshotCount",
      c.attributed_credits  AS "attributedCredits",
      c.snowflake_cost_usd  AS "snowflakeCostUsd",
      c.aws_cost_usd        AS "awsCostUsd",
      c.total_cost_usd      AS "totalCostUsd",
      c.total_cost_usd / NULLIF(SUM(c.total_cost_usd) OVER (), 0) AS "shareOfTotalCost"
    FROM ${source} c
    WHERE ${scopeSql(scope, 'c.owner', params)}`;
  return withTotals(
    db,
    sql,
    params,
    orderBy,
    page,
    `SELECT COUNT(*)::INTEGER                     AS "lineCount",
            COALESCE(SUM("attributedCredits"), 0) AS "attributedCredits",
            COALESCE(SUM("snowflakeCostUsd"), 0)  AS "snowflakeCostUsd",
            COALESCE(SUM("awsCostUsd"), 0)        AS "awsCostUsd",
            COALESCE(SUM("totalCostUsd"), 0)      AS "totalCostUsd"
     FROM scoped`,
  );
}
