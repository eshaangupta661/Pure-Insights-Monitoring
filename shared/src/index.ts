/** Types shared by client and server. Fields marked "filled in Phase N" are placeholders. */

export type Role = 'admin' | 'owner' | 'viewer';
export type Severity = 'INFO' | 'WARNING' | 'CRITICAL';
export type AlertStatus = 'OPEN' | 'ACKNOWLEDGED' | 'RESOLVED';

/** LATENCY: > 15 s WARNING, > 30 s CRITICAL. REFRESH_FAILED: FAILED/TIMED_OUT. REFRESH_UNKNOWN: INFO. */
export type AlertRuleId = 'LATENCY' | 'REFRESH_FAILED' | 'REFRESH_UNKNOWN';

/**
 * One alert. `id` is deterministic (`<cycle>-<reportId>-<ruleId>-<openedTick>`), so replaying
 * ticks rebuilds the same alerts. `ownerEmail` is the report's current owner when read.
 */
export interface Alert {
  id: string;
  reportId: string;
  reportName: string;
  ownerEmail: string | null;
  ruleId: AlertRuleId;
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

/** Alerts that are not RESOLVED (OPEN + ACKNOWLEDGED), in the caller's scope. */
export interface ActiveAlertCounts {
  total: number;
  open: number;
  acknowledged: number;
  INFO: number;
  WARNING: number;
  CRITICAL: number;
}

/** GET/POST /admin/replay. The tick is derived from virtual time; nothing counts ticks. */
export interface ReplayState {
  tick: number;
  /** How many full 20-snapshot replays have passed (alert ids include it). */
  cycle: number;
  snapshotDate: string;
  paused: boolean;
  speed: number;
  /** Speed multipliers the `speed` command accepts (REPLAY_SPEEDS). */
  speeds: number[];
  tickMs: number;
}

export type ReplayCommand =
  { action: 'pause' } | { action: 'resume' } | { action: 'speed'; value: number };

/* ---- WebSocket (Socket.IO namespace ALERTS_NAMESPACE; see docs/WEBSOCKET.md) ------------- */

export const ALERTS_NAMESPACE = '/alerts';

/** `tick`: the replay moved to a new snapshot, or was paused/resumed. */
export interface TickEvent {
  tick: number;
  snapshotDate: string;
  paused: boolean;
}

/** client → server `alert:ack`. */
export interface AlertAckRequest {
  alertId: string;
}

/** The `alert:ack` callback. Error codes match the REST API's. */
export type AlertAckResponse = { ok: true; alert: Alert } | { ok: false; error: ApiError['error'] };

export interface ServerToClientEvents {
  tick: (event: TickEvent) => void;
  /** Active (OPEN + ACKNOWLEDGED) alerts in scope; replaces the client's list. */
  'alert:snapshot': (alerts: Alert[]) => void;
  'alert:opened': (alert: Alert) => void;
  'alert:updated': (alert: Alert) => void;
  'kpi:update': (kpis: OverviewKpis) => void;
}

export interface ClientToServerEvents {
  'alert:ack': (request: AlertAckRequest, callback: (response: AlertAckResponse) => void) => void;
}

/** POST /alerts/ack: acknowledge several alerts in one audited step. */
export interface BulkAckRequest {
  alertIds: string[];
}

/** Why one alert in a bulk ack was left alone. NOT_FOUND also covers alerts outside your scope. */
export interface BulkAckSkipped {
  alertId: string;
  code: 'NOT_FOUND' | 'CONFLICT';
  message: string;
}

export interface BulkAckResult {
  /** Every requested alert that is now ACKNOWLEDGED, including ones that already were. */
  acknowledged: Alert[];
  /** How many of `acknowledged` this request changed (the rest were already acknowledged). */
  newlyAcknowledged: number;
  skipped: BulkAckSkipped[];
}

export type IncidentKind = 'LATENCY_SPIKE' | 'REFRESH_FAILED';

export interface IncidentRequest {
  reportId: string;
  kind: IncidentKind;
}

export type RefreshStatus = 'SUCCESS' | 'FAILED' | 'TIMED_OUT' | 'UNKNOWN';

/*
 * Role-dependent shapes: `Viewer*` types are what a viewer receives (no per-report cost); the
 * unprefixed type extends it with cost fields for admins and owners. Money is unrounded USD.
 */

export interface RefreshCounts {
  SUCCESS: number;
  FAILED: number;
  TIMED_OUT: number;
  UNKNOWN: number;
}

/** Portfolio (or, for an owner, their reports') cost aggregates. Visible to every role. */
export interface OverviewCostTotals {
  /** Attributed Snowflake cost over all snapshots. */
  attributedCostUsd: number;
  /** Snowflake cost of the current snapshot (quarantined snapshots count as unknown, i.e. 0 here). */
  snapshotSnowflakeCostUsd: number;
  snapshotAwsCostUsd: number;
}

/** GET /overview: the replay's current snapshot, scoped to the caller. */
export interface OverviewKpis {
  tick: number;
  snapshotIdx: number;
  snapshotDate: string;
  reportCount: number;
  orphanedCount: number;
  refresh: RefreshCounts;
  /** Reports above LATENCY_WARNING_SEC / LATENCY_CRITICAL_SEC at this snapshot. */
  slowCount: number;
  criticalSlowCount: number;
  avgLoadTimeSec: number | null;
  maxLoadTimeSec: number | null;
  totalViews: number;
  alerts: ActiveAlertCounts;
  totals: OverviewCostTotals;
}

/** One snapshot's refresh-status counts over the reports in scope (GET /overview/trend). */
export interface TrendPoint {
  snapshotIdx: number;
  snapshotDate: string;
  refresh: RefreshCounts;
  /** Reports above LATENCY_WARNING_SEC at this snapshot. */
  slowCount: number;
}

/** A load-time histogram bucket: lowerSec <= load time < upperSec (null = open-ended). */
export interface LatencyBucket {
  lowerSec: number;
  upperSec: number | null;
  count: number;
}

/**
 * GET /overview/trend: every snapshot's refresh counts, and the load-time histogram of the
 * replay's current snapshot (bucket edges from LATENCY_BUCKET_EDGES_SEC), over the caller's scope.
 */
export interface OverviewTrend {
  /** The replay's current snapshot; later points are what the replay has yet to reach. */
  currentIdx: number;
  points: TrendPoint[];
  latency: LatencyBucket[];
  /** Load times above these are WARNING / CRITICAL (LATENCY_WARNING_SEC / _CRITICAL_SEC). */
  thresholds: { warningSec: number; criticalSec: number };
}

/** A report at the replay's current snapshot, as every role sees it. */
export interface ViewerReportSummary {
  reportId: string;
  reportName: string;
  /** The owner at this snapshot (REPORT_SNAPSHOTS.owner_email); null = orphaned then. */
  snapshotOwner: string | null;
  /**
   * Effective owner used for scoping: the admin override if one exists, else the latest
   * snapshot's owner. Show it only when `isOverridden`; otherwise it is a future snapshot's owner.
   */
  currentOwner: string | null;
  /** No owner at this snapshot: the override's owner when overridden, else `snapshotOwner`. */
  isOrphaned: boolean;
  isOverridden: boolean;
  snapshotIdx: number;
  snapshotDate: string;
  refreshStatus: RefreshStatus;
  loadTimeSec: number;
  monthlyActiveViews: number;
  concurrentUserPeak: number;
  dqFlags: DqFlag[];
  ownerChangeCount: number;
}

/** ViewerReportSummary plus cost (admins, and owners for their own reports). */
export interface ReportSummary extends ViewerReportSummary {
  /** This snapshot's Snowflake cost (one day); null when its credits were quarantined (DQ02). */
  snowflakeCostUsd: number | null;
  /** This snapshot's AWS hosting (assumed monthly). */
  awsCostUsd: number;
  /**
   * 30-day basis: (snowflakeCostUsd × DAYS_PER_MONTH + awsCostUsd) / monthly views, so cost and
   * views cover the same period. null for zero views (DQ05) or quarantined credits.
   */
  fullyLoadedCostPerView: number | null;
  /** Attributed Snowflake cost over all snapshots. */
  attributedCostUsd: number;
}

export interface ViewerSnapshotPoint {
  snapshotIdx: number;
  snapshotDate: string;
  /** The owner in that snapshot (point-in-time); null = orphaned. */
  ownerEmail: string | null;
  refreshStatus: RefreshStatus;
  loadTimeSec: number;
  monthlyActiveViews: number;
  concurrentUserPeak: number;
  queryCount: number;
  dqFlags: DqFlag[];
}

export interface SnapshotPoint extends ViewerSnapshotPoint {
  /** As reported in the CSV; may be negative (DQ02). */
  creditsReported: number;
  /** null when quarantined. */
  attributedCredits: number | null;
  /** One day of Snowflake cost. */
  snowflakeCostUsd: number | null;
  /** Monthly AWS hosting (assumed). */
  awsCostUsd: number;
  /** 30-day cost: snowflakeCostUsd × DAYS_PER_MONTH + awsCostUsd. */
  fullyLoadedCostUsd: number | null;
  /** fullyLoadedCostUsd / monthly views (both 30 days). */
  fullyLoadedCostPerView: number | null;
}

export interface OwnerOverrideInfo {
  ownerEmail: string | null;
  setBy: string;
  setAt: string;
  reason: string | null;
}

/** A report's cost over all snapshots (/sql 04 and 05). */
export interface ReportCost {
  queryCount: number;
  attributedCredits: number;
  attributedCostUsd: number;
  /** Snapshots with known credits (not quarantined). */
  costedSnapshotCount: number;
  /** Σ 30-day cost (Snowflake × DAYS_PER_MONTH + AWS) over costed snapshots; the ratio's numerator. */
  fullyLoadedCostUsd: number | null;
  /** View-weighted average 30-day cost per view over costed snapshots. */
  fullyLoadedCostPerView: number | null;
}

export interface ViewerReportDetail extends ViewerReportSummary {
  /** Owner per snapshot, in snapshot order (null = orphaned). */
  ownerHistory: (string | null)[];
  override: OwnerOverrideInfo | null;
  history: ViewerSnapshotPoint[];
}

export interface ReportDetail extends ReportSummary {
  ownerHistory: (string | null)[];
  override: OwnerOverrideInfo | null;
  history: SnapshotPoint[];
  cost: ReportCost;
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

/** GET /costs/reports, viewer variant: which reports exist and how busy they are, no money. */
export interface ViewerCostRow {
  reportId: string;
  reportName: string;
  currentOwner: string | null;
  queryCount: number;
}

/** Aggregates over the rows in scope; every role sees them. */
export interface CostReportsTotals {
  lineCount: number;
  queryCount: number;
  attributedCredits: number;
  attributedCostUsd: number;
}

/** A page plus scope-wide aggregates (never per row). */
export interface PageWithTotals<T, Totals> extends Page<T> {
  totals: Totals;
}

/** GET /costs/unit-economics (/sql/05 UNIT_ECONOMICS_REPORT, effective owner). */
export interface ViewerUnitEconomicsRow {
  reportId: string;
  reportName: string;
  currentOwner: string | null;
  snapshotCount: number;
}

export interface UnitEconomicsRow extends ViewerUnitEconomicsRow {
  costedSnapshotCount: number;
  /** Σ daily Snowflake cost over costed snapshots (actual spend in the period). */
  snowflakeCostUsd: number | null;
  /** Σ AWS hosting over costed snapshots only (the ratio's basis; /costs/chargeback counts all). */
  awsCostUsd: number | null;
  /** Σ 30-day fully loaded cost over costed snapshots (the ratio's numerator). */
  fullyLoadedCostUsd: number | null;
  /** Σ monthly views over costed snapshots: a weight for the average, not distinct viewers. */
  costedViews: number | null;
  /** 30-day basis, view-weighted over costed snapshots. */
  snowflakeCostPerView: number | null;
  fullyLoadedCostPerView: number | null;
}

export interface UnitEconomicsTotals {
  reportCount: number;
  snowflakeCostUsd: number;
  /** Over costed snapshots only, like the rows. The all-snapshot AWS total is in chargeback totals. */
  awsCostUsd: number;
  fullyLoadedCostUsd: number;
  /** Σ monthly views over costed snapshots: the weight, not a count of viewers. */
  costedViews: number;
  /** Ratio of totals: Σ 30-day fully loaded cost / Σ costed views. */
  fullyLoadedCostPerView: number | null;
}

/** /sql/06 anomalies, each section with the effective owner. Short lists, not paginated. */
export interface ViewerPerViewOutlier {
  reportId: string;
  reportName: string;
  currentOwner: string | null;
  snapshotIdx: number;
  snapshotDate: string;
  views: number;
  direction: 'HIGH' | 'LOW';
}
/** robustZ is not in the viewer shape: with `views` it reveals cost per view up to two constants. */
export interface PerViewOutlier extends ViewerPerViewOutlier {
  robustZ: number;
  fullyLoadedCostPerView: number;
}

/**
 * A report with no owner at the replay's snapshot (an admin override wins), whatever its usage.
 * Recommended action: reassign. Orphans carry no savings estimate (see ZombieReport).
 */
export interface ViewerOrphanedReport {
  reportId: string;
  reportName: string;
  /** Effective owner used for scoping (override, else latest snapshot's owner). */
  currentOwner: string | null;
  snapshotIdx: number;
  snapshotDate: string;
  /** That snapshot's own owner; non-null only when an override set the report to no owner. */
  snapshotOwner: string | null;
  isOverridden: boolean;
  views: number;
  /** Also a zombie at this snapshot (views < COST_LOW_VIEWS). */
  isZombie: boolean;
}
export interface OrphanedReport extends ViewerOrphanedReport {
  /** This snapshot's attributed credits; null when quarantined (DQ02). */
  attributedCredits: number | null;
  snowflakeCostUsd: number | null;
  totalAttributedCredits: number;
  totalAttributedCostUsd: number;
}

/**
 * A report almost nobody uses at the replay's snapshot (views < COST_LOW_VIEWS), owned or not.
 * Recommended action: retire. The only source of estimated savings.
 */
export interface ViewerZombieReport {
  reportId: string;
  reportName: string;
  currentOwner: string | null;
  snapshotIdx: number;
  snapshotDate: string;
  /** Also unowned at this snapshot. */
  isOrphaned: boolean;
  views: number;
}
export interface ZombieReport extends ViewerZombieReport {
  /** This snapshot's attributed credits; null when quarantined (DQ02). */
  attributedCredits: number | null;
  snowflakeCostUsd: number | null;
  /** This snapshot's Snowflake cost × DAYS_PER_MONTH; null when its cost is unknown. */
  estimatedMonthlySavingsUsd: number | null;
  /** The same estimate in credits. */
  estimatedMonthlySavingsCredits: number | null;
  totalAttributedCredits: number;
  totalAttributedCostUsd: number;
}

/** Counts over the caller's scope at the replay's snapshot. */
export interface ViewerAnomalyTotals {
  orphanedCount: number;
  zombieCount: number;
  /** Reports in both lists. */
  orphanedZombieCount: number;
}
export interface AnomalyTotals extends ViewerAnomalyTotals {
  /** This snapshot's Snowflake cost of the orphaned reports (known costs only). */
  orphanedSnowflakeCostUsd: number;
  /** Sum of zombie savings (known costs only). Orphans never contribute. */
  estimatedMonthlySavingsUsd: number;
  estimatedMonthlySavingsCredits: number;
}

export interface ViewerAwsViewsMismatch {
  reportId: string;
  reportName: string;
  currentOwner: string | null;
  snapshotIdx: number;
  views: number;
  reason: 'HARD_RULE' | 'ROBUST_Z' | 'BOTH';
}
export interface AwsViewsMismatch extends ViewerAwsViewsMismatch {
  /** Not in the viewer shape (it is a transform of log AWS cost per view). */
  awsLogZ: number | null;
  awsCostUsd: number;
  awsCostPerView: number | null;
}

export interface ViewerQuarantinedSnapshot {
  reportId: string;
  reportName: string;
  currentOwner: string | null;
  snapshotIdx: number;
  reason: string;
}
export interface QuarantinedSnapshot extends ViewerQuarantinedSnapshot {
  rawCredits: number;
}

export interface ViewerAnomalyReport {
  /** The replay's snapshot that `orphaned`, `zombies` and `totals` describe. */
  snapshotIdx: number;
  perViewOutliers: ViewerPerViewOutlier[];
  orphaned: ViewerOrphanedReport[];
  zombies: ViewerZombieReport[];
  awsViewsMismatch: ViewerAwsViewsMismatch[];
  quarantinedSnapshots: ViewerQuarantinedSnapshot[];
  totals: ViewerAnomalyTotals;
}
export interface AnomalyReport {
  snapshotIdx: number;
  perViewOutliers: PerViewOutlier[];
  orphaned: OrphanedReport[];
  zombies: ZombieReport[];
  awsViewsMismatch: AwsViewsMismatch[];
  quarantinedSnapshots: QuarantinedSnapshot[];
  totals: AnomalyTotals;
}

/** point_in_time: each snapshot charged to that snapshot's owner; current: to today's owner. */
export type ChargebackView = 'point_in_time' | 'current';

/** GET /costs/chargeback (/sql/07). owner is an email, 'UNOWNED' or 'UNATTRIBUTED'. */
export interface ViewerChargebackRow {
  owner: string;
  reportCount: number;
  snapshotCount: number;
}
export interface ChargebackRow extends ViewerChargebackRow {
  attributedCredits: number;
  snowflakeCostUsd: number;
  awsCostUsd: number;
  totalCostUsd: number;
  /** Share of the total over the lines in the caller's scope. */
  shareOfTotalCost: number | null;
}
export interface ChargebackTotals {
  lineCount: number;
  attributedCredits: number;
  snowflakeCostUsd: number;
  awsCostUsd: number;
  totalCostUsd: number;
}

export interface OwnerOverrideRequest {
  /** New owner (trimmed, lowercased); null marks the report orphaned. */
  ownerEmail: string | null;
  reason?: string;
}

export type AuditAction =
  'OWNER_OVERRIDE' | 'ALERT_ACK' | 'ALERT_ACK_BULK' | 'REPLAY_CONTROL' | 'INCIDENT_INJECT';

export interface AuditLogEntry {
  id: string;
  at: string;
  actorEmail: string;
  action: AuditAction;
  target: string;
  details: Record<string, unknown>;
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

export interface DataQualityRule extends DqResult {
  flag: DqFlag;
  /** First few distinct report_ids (row order) with the flag. */
  sampleReportIds: string[];
}

/** Shape of data/dq_summary.json. */
export interface DqSummary {
  sourceRows: number;
  rules: DataQualityRule[];
}

/** GET /data-quality, scoped to the caller's reports (all 20 snapshots of each). */
export interface DataQualityResponse {
  /** Snapshot rows the counts are over (2,000 unscoped). */
  scopedRows: number;
  rules: DataQualityRule[];
  /** Rows of those reports copied to QUARANTINE (DQ02). */
  quarantinedRows: number;
  /** /sql/02 recomputes each rule in SQL; PASS when it agrees with the TypeScript rule. */
  checks: { ruleId: DqRuleId; status: 'PASS' | 'FAIL' }[];
}

export interface ApiError {
  error: { code: string; message: string };
}

/** The signed-in user (GET /auth/me). Emails are lowercase. */
export interface AuthUser {
  email: string;
  role: Role;
}

/** POST /auth/login. The JWT itself is only in the httpOnly cookie, never in the body. */
export interface LoginResponse {
  user: AuthUser;
  /** ISO timestamp when the session cookie's token expires. */
  expiresAt: string;
}

/** Every paginated list endpoint. `page` is 1-based; a page past the end has no items. */
export interface Page<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

export interface HealthResponse {
  status: 'ok';
  tick: number;
  uptime: number;
}
