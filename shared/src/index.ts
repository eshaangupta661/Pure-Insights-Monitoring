/** Types shared by client and server. Fields marked "filled in Phase N" are placeholders. */

export type Role = 'admin' | 'owner' | 'viewer';
export type Severity = 'INFO' | 'WARNING' | 'CRITICAL';
export type AlertStatus = 'OPEN' | 'ACKNOWLEDGED' | 'RESOLVED';

export interface Alert {
  id: string;
  reportId: string;
  reportName: string;
  ownerEmail: string | null;
  ruleId: string;
  severity: Severity;
  status: AlertStatus;
  message: string;
  value: number;
  threshold: number;
  openedTick: number;
  openedAt: string;
  lastSeenTick: number;
  ackedBy?: string;
  resolvedTick?: number;
  synthetic: boolean;
}

/** filled in Phase 3 */
export interface OverviewKpis {
  tick: number;
}

/** filled in Phase 3 */
export interface ReportSummary {
  reportId: string;
  reportName: string;
  currentOwner: string | null;
}

/** filled in Phase 3 */
export interface ReportDetail extends ReportSummary {
  ownerHistory: string[];
}

/**
 * One report's attributed Snowflake cost over all snapshots (/sql/04_report_attribution.sql).
 * reportId 'UNATTRIBUTED' is the always-present line for untagged / unknown-report queries.
 * Credits are metered credits; active + overhead = attributed under the simulated overhead rate.
 * Unrounded; round at presentation.
 */
export interface CostRow {
  reportId: string;
  reportName: string;
  currentOwner: string | null;
  queryCount: number;
  attributedCredits: number;
  activeCredits: number;
  overheadCredits: number;
  attributedCostUsd: number;
  shareOfTotal: number | null;
}

export type DqRuleId =
  'DQ01' | 'DQ02' | 'DQ03' | 'DQ04' | 'DQ05' | 'DQ06' | 'DQ07' | 'DQ08' | 'DQ09';
export type DqSeverity = 'high' | 'medium' | 'low' | 'info';

/** Per-row flags stored in REPORT_SNAPSHOTS.dq_flags (one per DQ rule). */
export type DqFlag =
  | 'ORPHANED'
  | 'NEGATIVE_CREDITS'
  | 'SLOW_LOAD'
  | 'COST_MISMATCH'
  | 'ZERO_VIEWS'
  | 'IMPOSSIBLE_CONCURRENCY'
  | 'UNKNOWN_REFRESH'
  | 'SLOW_BUT_HEALTHY'
  | 'OWNER_CHANGED';

export interface DqResult {
  ruleId: DqRuleId;
  ruleName: string;
  severity: DqSeverity;
  rowsAffected: number;
  treatment: string;
}

/** Shape of data/dq_summary.json. */
export interface DqSummary {
  sourceRows: number;
  rules: (DqResult & { flag: DqFlag; sampleReportIds: string[] })[];
}

export interface ApiError {
  error: { code: string; message: string };
}

export interface HealthResponse {
  status: 'ok';
  tick: number;
  uptime: number;
}
