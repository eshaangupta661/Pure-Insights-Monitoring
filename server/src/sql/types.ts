/*
 * Row shapes of the /sql views the runner caches, as returned by getRowObjectsJson:
 * DOUBLE → number (NULL → null), INTEGER → number, DATE → 'YYYY-MM-DD'. Column comments live in
 * the SQL file headers.
 */

export type PassFail = 'PASS' | 'FAIL';

export interface DqCheckRow {
  rule_id: string;
  sql_rows: number;
  ts_rows: number | null;
  status: PassFail;
}

export interface ReportAttributionDailyRow {
  report_id: string;
  usage_date: string;
  query_count: number;
  attributed_credits: number;
  attributed_cost_usd: number;
}

export interface ReportAttributionRow {
  /** RPT_xxx, or 'UNATTRIBUTED' for the always-present line of untagged / unknown-report queries. */
  report_id: string;
  report_name: string;
  current_owner: string | null;
  query_count: number;
  attributed_credits: number;
  active_credits: number;
  overhead_credits: number;
  attributed_cost_usd: number;
  share_of_total: number | null;
}

export interface UnitEconomicsSnapshotRow {
  report_id: string;
  report_name: string;
  snapshot_idx: number;
  snapshot_date: string;
  owner_email: string | null;
  views: number;
  aws_cost_usd: number;
  attributed_credits: number | null;
  snowflake_cost_usd: number | null;
  snowflake_cost_30d_usd: number | null;
  fully_loaded_cost_usd: number | null;
  snowflake_cost_per_view: number | null;
  fully_loaded_cost_per_view: number | null;
}

export interface UnitEconomicsReportRow {
  report_id: string;
  report_name: string;
  current_owner: string | null;
  snapshot_count: number;
  costed_snapshot_count: number;
  snowflake_cost_usd: number | null;
  snowflake_cost_30d_usd: number | null;
  aws_cost_usd: number | null;
  fully_loaded_cost_usd: number | null;
  costed_views: number | null;
  snowflake_cost_per_view: number | null;
  fully_loaded_cost_per_view: number | null;
}

export interface AnomalyCostPerViewRow {
  report_id: string;
  report_name: string;
  snapshot_idx: number;
  snapshot_date: string;
  views: number;
  fully_loaded_cost_per_view: number;
  robust_z: number;
  direction: 'HIGH' | 'LOW';
}

export interface AnomalyOrphanedRow {
  report_id: string;
  report_name: string;
  snapshot_idx: number;
  snapshot_date: string;
  current_owner: string | null;
  snapshot_owner: string | null;
  is_overridden: boolean;
  views: number;
  attributed_credits: number | null;
  snowflake_cost_usd: number | null;
  snowflake_cost_30d_usd: number | null;
  is_zombie: boolean;
  total_attributed_credits: number;
  total_attributed_cost_usd: number;
}

export interface AnomalyZombieRow {
  report_id: string;
  report_name: string;
  snapshot_idx: number;
  snapshot_date: string;
  current_owner: string | null;
  is_orphaned: boolean;
  views: number;
  attributed_credits: number | null;
  snowflake_cost_usd: number | null;
  snowflake_cost_30d_usd: number | null;
  estimated_monthly_savings_credits: number | null;
  estimated_monthly_savings_usd: number | null;
  total_attributed_credits: number;
  total_attributed_cost_usd: number;
}

export interface AnomalyAwsViewsMismatchRow {
  row_idx: number;
  report_id: string;
  report_name: string;
  snapshot_idx: number;
  views: number;
  aws_cost_usd: number;
  aws_cost_per_view: number | null;
  aws_log_z: number | null;
  reason: 'HARD_RULE' | 'ROBUST_Z' | 'BOTH';
}

export interface AnomalyNegativeCreditsRow {
  row_idx: number;
  report_id: string;
  report_name: string;
  snapshot_idx: number;
  current_owner: string | null;
  raw_credits: number;
  reason: string;
}

export interface OwnerChargebackRow {
  /** Lowercase email, 'UNOWNED' (orphaned reports) or 'UNATTRIBUTED' (untagged queries). */
  owner: string;
  report_count: number;
  snapshot_count: number;
  attributed_credits: number;
  snowflake_cost_usd: number;
  aws_cost_usd: number;
  total_cost_usd: number;
  share_of_total_cost: number | null;
}

export interface PeriodToDateRow {
  period_end_idx: number;
  scope_kind: 'ALL' | 'OWNER';
  current_owner: string | null;
  from_date: string;
  to_date: string;
  snapshot_count: number;
  report_count: number;
  refresh_count: number;
  success_count: number;
  failed_count: number;
  timed_out_count: number;
  unknown_count: number;
  refresh_success_rate: number | null;
  ever_orphaned_count: number;
  snowflake_credits_to_date: number;
  snowflake_cost_to_date_usd: number;
  quarantined_snapshot_count: number;
  avg_load_time_sec: number | null;
  p95_load_time_sec: number | null;
}

export interface ReconciliationRow {
  check_id: string;
  check_kind: 'CONSERVATION' | 'GROUND_TRUTH' | 'CONSISTENCY';
  description: string;
  expected: number | null;
  actual: number | null;
  abs_diff: number | null;
  tolerance: number;
  status: PassFail;
}

/** Every cached view and its row type. */
export interface SqlViewRows {
  DQ_CHECKS: DqCheckRow;
  REPORT_ATTRIBUTION_DAILY: ReportAttributionDailyRow;
  REPORT_ATTRIBUTION: ReportAttributionRow;
  UNIT_ECONOMICS_SNAPSHOT: UnitEconomicsSnapshotRow;
  UNIT_ECONOMICS_REPORT: UnitEconomicsReportRow;
  ANOMALY_COST_PER_VIEW: AnomalyCostPerViewRow;
  ANOMALY_ORPHANED_REPORTS: AnomalyOrphanedRow;
  ANOMALY_ZOMBIE_REPORTS: AnomalyZombieRow;
  ANOMALY_AWS_VIEWS_MISMATCH: AnomalyAwsViewsMismatchRow;
  ANOMALY_NEGATIVE_CREDITS: AnomalyNegativeCreditsRow;
  OWNER_CHARGEBACK: OwnerChargebackRow;
  OWNER_CHARGEBACK_CURRENT: OwnerChargebackRow;
  RECONCILIATION: ReconciliationRow;
  PERIOD_TO_DATE: PeriodToDateRow;
  PERIOD_TO_DATE_CHECKS: ReconciliationRow;
}

export type CachedView = keyof SqlViewRows;
