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
  AnomalyTotals,
  AwsViewsMismatch,
  ChargebackRow,
  ChargebackTotals,
  ChargebackView,
  CostReportsTotals,
  CostRow,
  OrphanedReport,
  PageWithTotals,
  PerViewOutlier,
  QuarantinedSnapshot,
  UnitEconomicsRow,
  UnitEconomicsTotals,
  ZombieReport,
} from '@pic/shared';
import { scopeSql, type Scope } from '../auth/scope.js';
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
  tick: number,
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

  // Live views at the replay's snapshot: membership depends on the owner (overrides apply).
  const atTick = (column: string) => {
    const s = scoped(column);
    s.params.push(tick);
    return { where: `${s.where} AND snapshot_idx = $${s.params.length}`, params: s.params };
  };
  const orphan = atTick('current_owner');
  const orphaned = await db.query<OrphanedReport>(
    `SELECT report_id AS "reportId", report_name AS "reportName", current_owner AS "currentOwner",
            snapshot_idx AS "snapshotIdx", snapshot_date AS "snapshotDate",
            snapshot_owner AS "snapshotOwner", is_overridden AS "isOverridden", views,
            is_zombie AS "isZombie", attributed_credits AS "attributedCredits",
            snowflake_cost_usd AS "snowflakeCostUsd",
            total_attributed_credits AS "totalAttributedCredits",
            total_attributed_cost_usd AS "totalAttributedCostUsd"
     FROM ANOMALY_ORPHANED_REPORTS
     WHERE ${orphan.where}
     ORDER BY ${by('snowflake_cost_usd DESC NULLS LAST, report_id', 'report_id')}`,
    orphan.params,
  );

  const z = atTick('current_owner');
  const zombies = await db.query<ZombieReport>(
    `SELECT report_id AS "reportId", report_name AS "reportName", current_owner AS "currentOwner",
            snapshot_idx AS "snapshotIdx", snapshot_date AS "snapshotDate",
            is_orphaned AS "isOrphaned", views, attributed_credits AS "attributedCredits",
            snowflake_cost_usd AS "snowflakeCostUsd",
            estimated_monthly_savings_usd AS "estimatedMonthlySavingsUsd",
            estimated_monthly_savings_credits AS "estimatedMonthlySavingsCredits",
            total_attributed_credits AS "totalAttributedCredits",
            total_attributed_cost_usd AS "totalAttributedCostUsd"
     FROM ANOMALY_ZOMBIE_REPORTS
     WHERE ${z.where}
     ORDER BY ${by('estimated_monthly_savings_usd DESC NULLS LAST, report_id', 'report_id')}`,
    z.params,
  );

  // Sums of the /sql/06 columns over the scoped rows; savings come from the zombie view only.
  const t = atTick('current_owner');
  const [totals] = await db.query<AnomalyTotals>(
    `WITH o AS (SELECT * FROM ANOMALY_ORPHANED_REPORTS WHERE ${t.where}),
          zz AS (SELECT * FROM ANOMALY_ZOMBIE_REPORTS WHERE ${t.where})
     SELECT (SELECT COUNT(*) FROM o)::INTEGER                          AS "orphanedCount",
            (SELECT COUNT(*) FROM zz)::INTEGER                         AS "zombieCount",
            (SELECT COUNT_IF(is_orphaned) FROM zz)::INTEGER            AS "orphanedZombieCount",
            (SELECT COALESCE(SUM(snowflake_cost_usd), 0) FROM o)       AS "orphanedSnowflakeCostUsd",
            (SELECT COALESCE(SUM(estimated_monthly_savings_usd), 0) FROM zz)
                                                                       AS "estimatedMonthlySavingsUsd",
            (SELECT COALESCE(SUM(estimated_monthly_savings_credits), 0) FROM zz)
                                                                       AS "estimatedMonthlySavingsCredits"`,
    t.params,
  );
  if (!totals) throw new Error('anomaly totals query returned no row');

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

  return {
    snapshotIdx: tick,
    perViewOutliers,
    orphaned,
    zombies,
    awsViewsMismatch,
    quarantinedSnapshots,
    totals,
  };
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
