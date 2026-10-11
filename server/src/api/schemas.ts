/*
 * zod schemas for every request input and response, shared by the routes (validation), the
 * OpenAPI document (api/openapi.ts) and the response checks in tests. Each response schema is
 * pinned to its @pic/shared type with AssertEqual, so the TS types the client uses and the
 * runtime schemas can't drift apart.
 */
import type {
  ActiveAlertCounts,
  Alert,
  AlertRuleId,
  AlertStatus,
  IncidentRequest,
  ReplayCommand,
  ReplayState,
  Severity,
  AnomalyReport,
  AnomalyTotals,
  OrphanedReport,
  ViewerAnomalyTotals,
  ViewerOrphanedReport,
  AuditAction,
  OverviewResponse,
  PeriodOverview,
  BulkAckRequest,
  BulkAckResult,
  AuditLogEntry,
  AuthUser,
  AwsViewsMismatch,
  ChargebackRow,
  ChargebackTotals,
  ChargebackView,
  CostAssumptions,
  CostProjection,
  ViewerCostAssumptions,
  CostReportsTotals,
  CostRow,
  OwnerOverrideRequest,
  PageWithTotals,
  PerViewOutlier,
  QuarantinedSnapshot,
  UnitEconomicsRow,
  UnitEconomicsTotals,
  ViewerAnomalyReport,
  ViewerAwsViewsMismatch,
  ViewerChargebackRow,
  ViewerCostRow,
  ViewerPerViewOutlier,
  ViewerQuarantinedSnapshot,
  ViewerUnitEconomicsRow,
  ViewerZombieReport,
  ZombieReport,
  DataQualityResponse,
  DqFlag,
  DqRuleId,
  LoginResponse,
  OverviewKpis,
  OverviewTrend,
  OwnerOverrideInfo,
  RefreshStatus,
  ReportCost,
  ReportDetail,
  ReportSummary,
  SnapshotPoint,
  ViewerReportDetail,
  ViewerReportSummary,
  ViewerSnapshotPoint,
} from '@pic/shared';
import { config } from '../config.js';
import { pageQuerySchema, pageSchema } from '../http/pagination.js';
import { z } from './zod.js';

/** Compile-time check that a schema's output type is exactly the shared type. */
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
// Instantiating with a false argument is a type error that names both types.
export type AssertEqual<A, B> = Equals<A, B> extends true ? true : [A, 'is not', B];
const assertTrue = <T extends true>(): T | undefined => undefined;

export const roleSchema = z.enum(['admin', 'owner', 'viewer']).openapi('Role');

/** Owner emails are compared by exact match, so inputs are trimmed and lowercased like ingest. */
export const emailInput = z.string().trim().toLowerCase().email().max(254);

// ---- auth -------------------------------------------------------------------------------

export const authUserSchema = z.object({ email: z.string(), role: roleSchema }).openapi('AuthUser');
assertTrue<AssertEqual<z.infer<typeof authUserSchema>, AuthUser>>();

export const loginBodySchema = z
  .object({ email: emailInput, password: z.string().min(1).max(200) })
  .openapi('LoginRequest', {
    example: { email: 'admin@pureinsights.dev', password: 'Admin@123' },
  });

export const loginResponseSchema = z
  .object({
    user: authUserSchema,
    expiresAt: z.string().datetime().openapi({ description: 'When the session cookie expires' }),
  })
  .openapi('LoginResponse');
assertTrue<AssertEqual<z.infer<typeof loginResponseSchema>, LoginResponse>>();

// ---- shared enums -----------------------------------------------------------------------

export const refreshStatusSchema = z
  .enum(['SUCCESS', 'FAILED', 'TIMED_OUT', 'UNKNOWN'])
  .openapi('RefreshStatus');
assertTrue<AssertEqual<z.infer<typeof refreshStatusSchema>, RefreshStatus>>();
assertTrue<AssertEqual<RefreshStatus, (typeof config.REFRESH_STATUSES)[number]>>();

export const dqFlagSchema = z
  .enum([
    'ORPHANED',
    'NEGATIVE_CREDITS',
    'SLOW_LOAD',
    'COST_MISMATCH',
    'ZERO_VIEWS',
    'IMPOSSIBLE_CONCURRENCY',
    'UNKNOWN_REFRESH',
    'SLOW_BUT_HEALTHY',
    'OWNER_CHANGED',
  ])
  .openapi('DqFlag');
assertTrue<AssertEqual<z.infer<typeof dqFlagSchema>, DqFlag>>();

export const dqRuleIdSchema = z
  .enum(['DQ01', 'DQ02', 'DQ03', 'DQ04', 'DQ05', 'DQ06', 'DQ07', 'DQ08', 'DQ09'])
  .openapi('DqRuleId');
assertTrue<AssertEqual<z.infer<typeof dqRuleIdSchema>, DqRuleId>>();

const isoDate = z.string().date().openapi({ example: '2026-10-10' });
const usd = z.number().openapi({ description: 'USD, unrounded' });
const nullableUsd = usd.nullable();

/** `?flag=true|false` (absent = no filter). */
const booleanQuery = z.enum(['true', 'false']).transform((v) => v === 'true');

// ---- alerts and replay ------------------------------------------------------------------

export const severitySchema = z.enum(['INFO', 'WARNING', 'CRITICAL']).openapi('Severity');
assertTrue<AssertEqual<z.infer<typeof severitySchema>, Severity>>();
export const alertStatusSchema = z
  .enum(['OPEN', 'ACKNOWLEDGED', 'RESOLVED'])
  .openapi('AlertStatus');
assertTrue<AssertEqual<z.infer<typeof alertStatusSchema>, AlertStatus>>();
export const alertRuleIdSchema = z
  .enum(['LATENCY', 'REFRESH_FAILED', 'REFRESH_UNKNOWN'])
  .openapi('AlertRuleId');
assertTrue<AssertEqual<z.infer<typeof alertRuleIdSchema>, AlertRuleId>>();

export const alertSchema = z
  .object({
    id: z.string().openapi({ example: '88990-RPT_203-LATENCY-7' }),
    reportId: z.string(),
    reportName: z.string(),
    ownerEmail: z.string().nullable().openapi({ description: 'Current owner when read' }),
    ruleId: alertRuleIdSchema,
    severity: severitySchema,
    status: alertStatusSchema,
    message: z.string(),
    value: z
      .number()
      .openapi({ description: 'Peak latency (s) while active, or 1 for a refresh rule' }),
    threshold: z.number(),
    openedTick: z.number().int(),
    openedAt: z.string().datetime().openapi({ description: 'Replay (virtual) time of openedTick' }),
    lastSeenTick: z.number().int(),
    streak: z.number().int().min(1).openapi({
      description:
        'Consecutive snapshots, ending at lastSeenTick, on which the report broke this rule',
    }),
    ackedBy: z.string().optional(),
    resolvedTick: z.number().int().optional(),
    synthetic: z.boolean().openapi({ description: 'Opened by an injected incident' }),
  })
  .openapi('Alert');
assertTrue<AssertEqual<z.infer<typeof alertSchema>, Alert>>();

export const activeAlertCountsSchema = z
  .object({
    total: z.number().int(),
    open: z.number().int(),
    acknowledged: z.number().int(),
    INFO: z.number().int(),
    WARNING: z.number().int(),
    CRITICAL: z.number().int(),
  })
  .openapi('ActiveAlertCounts');
assertTrue<AssertEqual<z.infer<typeof activeAlertCountsSchema>, ActiveAlertCounts>>();

/** `?severity=CRITICAL,WARNING`: one or more severities, comma separated. */
const severityListQuery = z
  .string()
  .transform((v) => v.split(',').map((s) => s.trim()))
  .pipe(z.array(severitySchema).min(1).max(3))
  .openapi({
    type: 'string',
    description: 'One or more severities, comma separated (INFO, WARNING, CRITICAL)',
    example: 'CRITICAL,WARNING',
  });

export const alertsQuerySchema = pageQuerySchema.extend({
  status: alertStatusSchema.optional(),
  severity: severityListQuery.optional(),
  resolved: booleanQuery
    .optional()
    .openapi({ description: 'false = leave out RESOLVED alerts (the default is to include them)' }),
  q: z
    .string()
    .trim()
    .max(100)
    .optional()
    .openapi({ description: 'Case-insensitive substring of the report id or name' }),
  rule: alertRuleIdSchema
    .optional()
    .openapi({ description: 'Only alerts of this type (LATENCY, REFRESH_FAILED, REFRESH_UNKNOWN)' }),
  sort: z
    .enum(['severity', 'report', 'snapshot'])
    .default('severity')
    .openapi({
      description:
        'severity (default): most severe first; within a severity, refresh failures by longest ' +
        'failing run, then load-time alerts by highest peak load time. report: by report id ' +
        'ascending. snapshot: most recently opened snapshot first. Resolved alerts come last ' +
        'in every order.',
    }),
});

export const BULK_ACK_MAX = 200;
export const bulkAckBodySchema = z
  .object({ alertIds: z.array(z.string().min(1).max(120)).min(1).max(BULK_ACK_MAX) })
  .openapi('BulkAckRequest', {
    example: { alertIds: ['88990-RPT_203-LATENCY-7', '88990-RPT_211-REFRESH_FAILED-4'] },
  });
assertTrue<AssertEqual<z.infer<typeof bulkAckBodySchema>, BulkAckRequest>>();

export const bulkAckResultSchema = z
  .object({
    acknowledged: z.array(alertSchema),
    newlyAcknowledged: z.number().int(),
    skipped: z.array(
      z.object({
        alertId: z.string(),
        code: z.enum(['NOT_FOUND', 'CONFLICT']),
        message: z.string(),
      }),
    ),
  })
  .openapi('BulkAckResult');
assertTrue<AssertEqual<z.infer<typeof bulkAckResultSchema>, BulkAckResult>>();

export const alertIdParamsSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(120)
    .openapi({ param: { name: 'id', in: 'path' }, example: '88990-RPT_203-LATENCY-7' }),
});

export const replayStateSchema = z
  .object({
    tick: z.number().int(),
    cycle: z.number().int(),
    snapshotDate: isoDate,
    paused: z.boolean(),
    speed: z.number(),
    speeds: z.array(z.number()),
    tickMs: z.number().int(),
  })
  .openapi('ReplayState');
assertTrue<AssertEqual<z.infer<typeof replayStateSchema>, ReplayState>>();

export const replayCommandSchema = z
  .discriminatedUnion('action', [
    z.object({ action: z.literal('pause') }),
    z.object({ action: z.literal('resume') }),
    z.object({ action: z.literal('jump_to_end') }),
    z.object({
      action: z.literal('speed'),
      value: z
        .number()
        .refine((v) => (config.REPLAY_SPEEDS as readonly number[]).includes(v), {
          message: `must be one of ${config.REPLAY_SPEEDS.join(', ')}`,
        })
        .openapi({ enum: [...config.REPLAY_SPEEDS] }),
    }),
  ])
  .openapi('ReplayCommand', { example: { action: 'speed', value: 5 } });
assertTrue<AssertEqual<z.infer<typeof replayCommandSchema>, ReplayCommand>>();

export const incidentBodySchema = z
  .object({
    reportId: z.string().regex(/^RPT_\d+$/, 'must look like RPT_123'),
    kind: z.enum(['LATENCY_SPIKE', 'REFRESH_FAILED']),
  })
  .openapi('IncidentRequest', { example: { reportId: 'RPT_203', kind: 'LATENCY_SPIKE' } });
assertTrue<AssertEqual<z.infer<typeof incidentBodySchema>, IncidentRequest>>();

// ---- overview ---------------------------------------------------------------------------

export const overviewQuerySchema = z.object({
  scope: z
    .enum(['today', 'period'])
    .default('today')
    .openapi({ description: 'today = the replay snapshot N; period = snapshots 0..N' }),
});

const healthRingSchema = z
  .object({
    count: z.number().int(),
    total: z.number().int(),
    rate: z.number().nullable(),
    previousRate: z.number().nullable(),
  })
  .openapi('HealthRing');

export const systemHealthSchema = z
  .object({ refresh: healthRingSchema, latency: healthRingSchema, ownership: healthRingSchema })
  .openapi('SystemHealth', { description: 'Aggregates; visible to every role' });

export const overviewSchema = z
  .object({
    scope: z.literal('today'),
    tick: z.number().int(),
    snapshotIdx: z.number().int(),
    snapshotDate: isoDate,
    reportCount: z.number().int(),
    orphanedCount: z.number().int(),
    refresh: z.object({
      SUCCESS: z.number().int(),
      FAILED: z.number().int(),
      TIMED_OUT: z.number().int(),
      UNKNOWN: z.number().int(),
    }),
    slowCount: z.number().int(),
    criticalSlowCount: z.number().int(),
    avgLoadTimeSec: z.number().nullable(),
    maxLoadTimeSec: z.number().nullable(),
    totalViews: z.number().int(),
    health: systemHealthSchema,
    alerts: activeAlertCountsSchema,
    totals: z
      .object({
        attributedCostUsd: usd,
        snapshotSnowflakeCostUsd: usd,
        snapshotAwsCostUsd: usd,
      })
      .openapi('OverviewCostTotals', { description: 'Aggregates; visible to every role' }),
  })
  .openapi('OverviewKpis');
assertTrue<AssertEqual<z.infer<typeof overviewSchema>, OverviewKpis>>();

export const periodOverviewSchema = z
  .object({
    scope: z.literal('period'),
    tick: z.number().int(),
    snapshotIdx: z.number().int(),
    fromDate: isoDate,
    toDate: isoDate,
    snapshotCount: z.number().int(),
    reportCount: z.number().int(),
    refresh: z.object({
      SUCCESS: z.number().int(),
      FAILED: z.number().int(),
      TIMED_OUT: z.number().int(),
      UNKNOWN: z.number().int(),
    }),
    refreshCount: z.number().int(),
    refreshSuccessRate: z.number().nullable(),
    everOrphanedCount: z.number().int(),
    quarantinedSnapshotCount: z.number().int(),
    avgLoadTimeSec: z.number().nullable(),
    p95LoadTimeSec: z.number().nullable(),
    health: systemHealthSchema,
    totals: z
      .object({ snowflakeCostToDateUsd: usd })
      .openapi('PeriodCostTotals', { description: 'Aggregates; visible to every role' }),
  })
  .openapi('PeriodOverview');
assertTrue<AssertEqual<z.infer<typeof periodOverviewSchema>, PeriodOverview>>();

export const overviewResponseSchema = z
  .discriminatedUnion('scope', [overviewSchema, periodOverviewSchema])
  .openapi('OverviewResponse');
assertTrue<AssertEqual<z.infer<typeof overviewResponseSchema>, OverviewResponse>>();

const refreshCountsSchema = z.object({
  SUCCESS: z.number().int(),
  FAILED: z.number().int(),
  TIMED_OUT: z.number().int(),
  UNKNOWN: z.number().int(),
});

export const overviewTrendSchema = z
  .object({
    scope: z.enum(['today', 'period']),
    currentIdx: z.number().int(),
    points: z.array(
      z.object({
        snapshotIdx: z.number().int(),
        snapshotDate: isoDate,
        refresh: refreshCountsSchema,
        slowCount: z.number().int(),
      }),
    ),
    latency: z.array(
      z.object({
        lowerSec: z.number(),
        upperSec: z.number().nullable(),
        count: z.number().int(),
      }),
    ),
    thresholds: z.object({ warningSec: z.number(), criticalSec: z.number() }),
  })
  .openapi('OverviewTrend');
assertTrue<AssertEqual<z.infer<typeof overviewTrendSchema>, OverviewTrend>>();

// ---- reports ----------------------------------------------------------------------------

export const reportIdParamsSchema = z.object({
  id: z
    .string()
    .regex(/^RPT_\d+$/, 'must look like RPT_123')
    .openapi({ param: { name: 'id', in: 'path' }, example: 'RPT_203' }),
});

export const REPORT_SORTS = ['reportId', 'loadTime', 'views', 'status'] as const;

export const reportsQuerySchema = pageQuerySchema.extend({
  q: z.string().trim().max(100).optional().openapi({
    description:
      'Case-insensitive substring of report id, name, owner at this snapshot or override owner',
  }),
  status: refreshStatusSchema.optional(),
  orphaned: booleanQuery
    .optional()
    .openapi({ description: 'true = no owner at this snapshot (the override wins)' }),
  slow: booleanQuery
    .optional()
    .openapi({ description: `true = load time > ${config.LATENCY_WARNING_SEC}s at this snapshot` }),
  sort: z.enum(REPORT_SORTS).default('reportId'),
  order: z.enum(['asc', 'desc']).default('asc'),
});
export type ReportsQuery = z.infer<typeof reportsQuerySchema>;

export const viewerReportSummarySchema = z
  .object({
    reportId: z.string(),
    reportName: z.string(),
    snapshotOwner: z
      .string()
      .nullable()
      .openapi({ description: 'Owner at the replay snapshot (null = no owner then)' }),
    currentOwner: z.string().nullable().openapi({
      description:
        'Effective owner used for scoping: the admin override if any, else the latest snapshot’s owner',
    }),
    isOrphaned: z.boolean().openapi({
      description: 'No owner at this snapshot (the override wins when one exists)',
    }),
    isOverridden: z.boolean(),
    snapshotIdx: z.number().int(),
    snapshotDate: isoDate,
    refreshStatus: refreshStatusSchema,
    loadTimeSec: z.number(),
    monthlyActiveViews: z.number().int(),
    concurrentUserPeak: z.number().int(),
    dqFlags: z.array(dqFlagSchema),
    ownerChangeCount: z.number().int(),
  })
  .openapi('ViewerReportSummary');
assertTrue<AssertEqual<z.infer<typeof viewerReportSummarySchema>, ViewerReportSummary>>();

export const reportSummarySchema = viewerReportSummarySchema
  .extend({
    snowflakeCostUsd: nullableUsd,
    awsCostUsd: usd,
    fullyLoadedCostPerView: nullableUsd,
    attributedCostUsd: usd,
  })
  .openapi('ReportSummary');
assertTrue<AssertEqual<z.infer<typeof reportSummarySchema>, ReportSummary>>();

export const viewerSnapshotPointSchema = z
  .object({
    snapshotIdx: z.number().int(),
    snapshotDate: isoDate,
    ownerEmail: z.string().nullable(),
    refreshStatus: refreshStatusSchema,
    loadTimeSec: z.number(),
    monthlyActiveViews: z.number().int(),
    concurrentUserPeak: z.number().int(),
    queryCount: z.number().int(),
    dqFlags: z.array(dqFlagSchema),
  })
  .openapi('ViewerSnapshotPoint');
assertTrue<AssertEqual<z.infer<typeof viewerSnapshotPointSchema>, ViewerSnapshotPoint>>();

export const snapshotPointSchema = viewerSnapshotPointSchema
  .extend({
    creditsReported: z.number(),
    attributedCredits: z.number().nullable(),
    snowflakeCostUsd: nullableUsd,
    awsCostUsd: usd,
    fullyLoadedCostUsd: nullableUsd,
    fullyLoadedCostPerView: nullableUsd,
  })
  .openapi('SnapshotPoint');
assertTrue<AssertEqual<z.infer<typeof snapshotPointSchema>, SnapshotPoint>>();

export const ownerOverrideInfoSchema = z
  .object({
    ownerEmail: z.string().nullable(),
    setBy: z.string(),
    setAt: z.string().datetime(),
    reason: z.string().nullable(),
  })
  .openapi('OwnerOverrideInfo');
assertTrue<AssertEqual<z.infer<typeof ownerOverrideInfoSchema>, OwnerOverrideInfo>>();

export const reportCostSchema = z
  .object({
    queryCount: z.number().int(),
    attributedCredits: z.number(),
    attributedCostUsd: usd,
    costedSnapshotCount: z.number().int(),
    fullyLoadedCostUsd: nullableUsd,
    fullyLoadedCostPerView: nullableUsd,
  })
  .openapi('ReportCost');
assertTrue<AssertEqual<z.infer<typeof reportCostSchema>, ReportCost>>();

export const viewerReportDetailSchema = viewerReportSummarySchema
  .extend({
    ownerHistory: z.array(z.string().nullable()),
    override: ownerOverrideInfoSchema.nullable(),
    history: z.array(viewerSnapshotPointSchema),
  })
  .openapi('ViewerReportDetail');
assertTrue<AssertEqual<z.infer<typeof viewerReportDetailSchema>, ViewerReportDetail>>();

export const reportDetailSchema = reportSummarySchema
  .extend({
    ownerHistory: z.array(z.string().nullable()),
    override: ownerOverrideInfoSchema.nullable(),
    history: z.array(snapshotPointSchema),
    cost: reportCostSchema,
  })
  .openapi('ReportDetail');
assertTrue<AssertEqual<z.infer<typeof reportDetailSchema>, ReportDetail>>();

// ---- data quality -----------------------------------------------------------------------

export const dataQualitySchema = z
  .object({
    scopedRows: z.number().int(),
    rules: z.array(
      z
        .object({
          ruleId: dqRuleIdSchema,
          ruleName: z.string(),
          severity: z.enum(['high', 'medium', 'low', 'info']),
          rowsAffected: z.number().int(),
          treatment: z.string(),
          flag: dqFlagSchema,
          sampleReportIds: z.array(z.string()),
        })
        .openapi('DataQualityRule'),
    ),
    quarantinedRows: z.number().int(),
    checks: z.array(z.object({ ruleId: dqRuleIdSchema, status: z.enum(['PASS', 'FAIL']) })),
  })
  .openapi('DataQualityResponse');
assertTrue<AssertEqual<z.infer<typeof dataQualitySchema>, DataQualityResponse>>();

// ---- costs ------------------------------------------------------------------------------

/**
 * Sort keys. Sorting by a cost column would leak cost ranks to viewers, so cost sorts are 403
 * for them (http/sort.ts) and their default is the non-cost key.
 */
const order = z
  .enum(['asc', 'desc'])
  .optional()
  .openapi({ description: 'Default depends on `sort`' });

export const costReportsQuerySchema = pageQuerySchema.extend({
  sort: z
    .enum(['cost', 'queries', 'reportId'])
    .optional()
    .openapi({ description: 'Default `cost` (desc); viewers: `reportId`, and cost sorts are 403' }),
  order,
});
export type CostReportsQuery = z.infer<typeof costReportsQuerySchema>;

export const unitEconomicsQuerySchema = pageQuerySchema.extend({
  sort: z
    .enum(['costPerView', 'reportId'])
    .optional()
    .openapi({ description: 'Default `costPerView` (desc, nulls last); viewers: `reportId`' }),
  order,
});
export type UnitEconomicsQuery = z.infer<typeof unitEconomicsQuerySchema>;

export const chargebackViewSchema = z.enum(['point_in_time', 'current']).openapi('ChargebackView');
assertTrue<AssertEqual<z.infer<typeof chargebackViewSchema>, ChargebackView>>();

export const chargebackQuerySchema = pageQuerySchema.extend({
  view: chargebackViewSchema.optional().openapi({
    description:
      'Default `point_in_time` for admins and viewers, `current` for owners. Owners may not ' +
      'request `point_in_time` (403): it charges past snapshots to whoever owned them then, ' +
      'which includes reports the owner no longer owns.',
  }),
  sort: z
    .enum(['cost', 'owner'])
    .optional()
    .openapi({ description: 'Default `cost` (desc); viewers: `owner`' }),
  order,
});
export type ChargebackQuery = z.infer<typeof chargebackQuerySchema>;

export const viewerCostRowSchema = z
  .object({
    reportId: z.string().openapi({ description: "RPT_xxx, or 'UNATTRIBUTED'" }),
    reportName: z.string(),
    currentOwner: z.string().nullable(),
    queryCount: z.number().int(),
  })
  .openapi('ViewerCostRow');
assertTrue<AssertEqual<z.infer<typeof viewerCostRowSchema>, ViewerCostRow>>();

export const costRowSchema = viewerCostRowSchema
  .extend({
    attributedCredits: z.number(),
    activeCredits: z.number(),
    overheadCredits: z.number(),
    attributedCostUsd: usd,
    shareOfTotal: z
      .number()
      .nullable()
      .openapi({ description: "Share of attributed credits over the rows in the caller's scope" }),
  })
  .openapi('CostRow');
assertTrue<AssertEqual<z.infer<typeof costRowSchema>, CostRow>>();

export const costReportsTotalsSchema = z
  .object({
    lineCount: z.number().int(),
    queryCount: z.number().int(),
    attributedCredits: z.number(),
    attributedCostUsd: usd,
  })
  .openapi('CostReportsTotals', {
    description: 'Aggregates over the scope; visible to every role',
  });
assertTrue<AssertEqual<z.infer<typeof costReportsTotalsSchema>, CostReportsTotals>>();

export const viewerUnitEconomicsRowSchema = z
  .object({
    reportId: z.string(),
    reportName: z.string(),
    currentOwner: z.string().nullable(),
    snapshotCount: z.number().int(),
  })
  .openapi('ViewerUnitEconomicsRow');
assertTrue<AssertEqual<z.infer<typeof viewerUnitEconomicsRowSchema>, ViewerUnitEconomicsRow>>();

export const unitEconomicsRowSchema = viewerUnitEconomicsRowSchema
  .extend({
    costedSnapshotCount: z.number().int(),
    snowflakeCostUsd: nullableUsd,
    awsCostUsd: nullableUsd,
    fullyLoadedCostUsd: nullableUsd,
    costedViews: z.number().int().nullable(),
    snowflakeCostPerView: nullableUsd,
    fullyLoadedCostPerView: nullableUsd,
  })
  .openapi('UnitEconomicsRow');
assertTrue<AssertEqual<z.infer<typeof unitEconomicsRowSchema>, UnitEconomicsRow>>();

export const unitEconomicsTotalsSchema = z
  .object({
    reportCount: z.number().int(),
    snowflakeCostUsd: usd,
    awsCostUsd: usd,
    fullyLoadedCostUsd: usd,
    costedViews: z.number().int(),
    fullyLoadedCostPerView: nullableUsd,
  })
  .openapi('UnitEconomicsTotals');
assertTrue<AssertEqual<z.infer<typeof unitEconomicsTotalsSchema>, UnitEconomicsTotals>>();

const anomalyBase = {
  reportId: z.string(),
  reportName: z.string(),
  currentOwner: z.string().nullable(),
};

export const viewerPerViewOutlierSchema = z
  .object({
    ...anomalyBase,
    snapshotIdx: z.number().int(),
    snapshotDate: isoDate,
    views: z.number().int(),
    direction: z.enum(['HIGH', 'LOW']),
  })
  .openapi('ViewerPerViewOutlier');
assertTrue<AssertEqual<z.infer<typeof viewerPerViewOutlierSchema>, ViewerPerViewOutlier>>();
export const perViewOutlierSchema = viewerPerViewOutlierSchema
  .extend({ robustZ: z.number(), fullyLoadedCostPerView: usd })
  .openapi('PerViewOutlier');
assertTrue<AssertEqual<z.infer<typeof perViewOutlierSchema>, PerViewOutlier>>();

export const viewerOrphanedReportSchema = z
  .object({
    ...anomalyBase,
    snapshotIdx: z.number().int(),
    snapshotDate: isoDate,
    snapshotOwner: z.string().nullable(),
    isOverridden: z.boolean(),
    views: z.number().int(),
    isZombie: z.boolean(),
  })
  .openapi('ViewerOrphanedReport');
assertTrue<AssertEqual<z.infer<typeof viewerOrphanedReportSchema>, ViewerOrphanedReport>>();
export const orphanedReportSchema = viewerOrphanedReportSchema
  .extend({
    attributedCredits: z.number().nullable(),
    snowflakeCostUsd: nullableUsd,
    totalAttributedCredits: z.number(),
    totalAttributedCostUsd: usd,
  })
  .openapi('OrphanedReport');
assertTrue<AssertEqual<z.infer<typeof orphanedReportSchema>, OrphanedReport>>();

export const viewerZombieReportSchema = z
  .object({
    ...anomalyBase,
    snapshotIdx: z.number().int(),
    snapshotDate: isoDate,
    isOrphaned: z.boolean(),
    views: z.number().int(),
  })
  .openapi('ViewerZombieReport');
assertTrue<AssertEqual<z.infer<typeof viewerZombieReportSchema>, ViewerZombieReport>>();
export const zombieReportSchema = viewerZombieReportSchema
  .extend({
    attributedCredits: z.number().nullable(),
    snowflakeCostUsd: nullableUsd,
    estimatedMonthlySavingsUsd: nullableUsd,
    estimatedMonthlySavingsCredits: z.number().nullable(),
    totalAttributedCredits: z.number(),
    totalAttributedCostUsd: usd,
  })
  .openapi('ZombieReport');
assertTrue<AssertEqual<z.infer<typeof zombieReportSchema>, ZombieReport>>();

export const viewerAnomalyTotalsSchema = z
  .object({
    orphanedCount: z.number().int(),
    zombieCount: z.number().int(),
    orphanedZombieCount: z.number().int(),
  })
  .openapi('ViewerAnomalyTotals');
assertTrue<AssertEqual<z.infer<typeof viewerAnomalyTotalsSchema>, ViewerAnomalyTotals>>();
export const anomalyTotalsSchema = viewerAnomalyTotalsSchema
  .extend({
    orphanedSnowflakeCostUsd: usd,
    estimatedMonthlySavingsUsd: usd,
    estimatedMonthlySavingsCredits: z.number(),
  })
  .openapi('AnomalyTotals');
assertTrue<AssertEqual<z.infer<typeof anomalyTotalsSchema>, AnomalyTotals>>();

export const viewerAwsViewsMismatchSchema = z
  .object({
    ...anomalyBase,
    snapshotIdx: z.number().int(),
    views: z.number().int(),
    reason: z.enum(['HARD_RULE', 'ROBUST_Z', 'BOTH']),
  })
  .openapi('ViewerAwsViewsMismatch');
assertTrue<AssertEqual<z.infer<typeof viewerAwsViewsMismatchSchema>, ViewerAwsViewsMismatch>>();
export const awsViewsMismatchSchema = viewerAwsViewsMismatchSchema
  .extend({ awsLogZ: z.number().nullable(), awsCostUsd: usd, awsCostPerView: nullableUsd })
  .openapi('AwsViewsMismatch');
assertTrue<AssertEqual<z.infer<typeof awsViewsMismatchSchema>, AwsViewsMismatch>>();

export const viewerQuarantinedSnapshotSchema = z
  .object({ ...anomalyBase, snapshotIdx: z.number().int(), reason: z.string() })
  .openapi('ViewerQuarantinedSnapshot');
assertTrue<
  AssertEqual<z.infer<typeof viewerQuarantinedSnapshotSchema>, ViewerQuarantinedSnapshot>
>();
export const quarantinedSnapshotSchema = viewerQuarantinedSnapshotSchema
  .extend({ rawCredits: z.number() })
  .openapi('QuarantinedSnapshot');
assertTrue<AssertEqual<z.infer<typeof quarantinedSnapshotSchema>, QuarantinedSnapshot>>();

export const anomalyReportSchema = z
  .object({
    snapshotIdx: z.number().int(),
    perViewOutliers: z.array(perViewOutlierSchema),
    orphaned: z.array(orphanedReportSchema),
    zombies: z.array(zombieReportSchema),
    awsViewsMismatch: z.array(awsViewsMismatchSchema),
    quarantinedSnapshots: z.array(quarantinedSnapshotSchema),
    totals: anomalyTotalsSchema,
  })
  .openapi('AnomalyReport');
assertTrue<AssertEqual<z.infer<typeof anomalyReportSchema>, AnomalyReport>>();

export const viewerAnomalyReportSchema = z
  .object({
    snapshotIdx: z.number().int(),
    perViewOutliers: z.array(viewerPerViewOutlierSchema),
    orphaned: z.array(viewerOrphanedReportSchema),
    zombies: z.array(viewerZombieReportSchema),
    awsViewsMismatch: z.array(viewerAwsViewsMismatchSchema),
    quarantinedSnapshots: z.array(viewerQuarantinedSnapshotSchema),
    totals: viewerAnomalyTotalsSchema,
  })
  .openapi('ViewerAnomalyReport');
assertTrue<AssertEqual<z.infer<typeof viewerAnomalyReportSchema>, ViewerAnomalyReport>>();

export const viewerChargebackRowSchema = z
  .object({
    owner: z.string().openapi({ description: "Lowercase email, 'UNOWNED' or 'UNATTRIBUTED'" }),
    reportCount: z.number().int(),
    snapshotCount: z.number().int(),
  })
  .openapi('ViewerChargebackRow');
assertTrue<AssertEqual<z.infer<typeof viewerChargebackRowSchema>, ViewerChargebackRow>>();

export const chargebackRowSchema = viewerChargebackRowSchema
  .extend({
    attributedCredits: z.number(),
    snowflakeCostUsd: usd,
    awsCostUsd: usd,
    totalCostUsd: usd,
    shareOfTotalCost: z.number().nullable(),
  })
  .openapi('ChargebackRow');
assertTrue<AssertEqual<z.infer<typeof chargebackRowSchema>, ChargebackRow>>();

export const chargebackTotalsSchema = z
  .object({
    lineCount: z.number().int(),
    attributedCredits: z.number(),
    snowflakeCostUsd: usd,
    awsCostUsd: usd,
    totalCostUsd: usd,
  })
  .openapi('ChargebackTotals');
assertTrue<AssertEqual<z.infer<typeof chargebackTotalsSchema>, ChargebackTotals>>();

export const costParametersSchema = z
  .object({
    creditPriceUsd: usd,
    simulatedOverheadRate: z.number(),
    snapshotDays: z.number().int(),
    daysPerMonth: z.number().int(),
    costLowViews: z.number().int(),
    costHighAwsUsd: usd,
    costRobustZ: z.number(),
  })
  .openapi('CostParameters', { description: 'PARAMS (/sql/00) plus fixed assumptions' });

export const viewerCostAssumptionsSchema = z
  .object({ snapshotIdx: z.number().int(), snapshotDate: isoDate, params: costParametersSchema })
  .openapi('ViewerCostAssumptions');
assertTrue<AssertEqual<z.infer<typeof viewerCostAssumptionsSchema>, ViewerCostAssumptions>>();

export const costAssumptionsSchema = viewerCostAssumptionsSchema
  .extend({
    example: z
      .object({
        reportId: z.string(),
        reportName: z.string(),
        currentOwner: z.string().nullable(),
        snapshotIdx: z.number().int(),
        snapshotDate: isoDate,
        queryHour: z
          .object({
            queryId: z.string(),
            warehouseName: z.string(),
            hourStart: z.string(),
            hourMeteredCredits: z.number(),
            execMsInHour: z.number(),
            hourExecMs: z.number(),
            attributedCredits: z.number(),
          })
          .nullable(),
        queryCount: z.number().int(),
        attributedCredits: z.number(),
        activeCredits: z.number(),
        overheadCredits: z.number(),
        snowflakeCostUsd: usd,
        snowflakeCost30dUsd: usd,
        awsCostUsd: usd,
        fullyLoadedCostUsd: usd,
        views: z.number().int(),
        snowflakeCostPerView: nullableUsd,
        fullyLoadedCostPerView: nullableUsd,
      })
      .nullable()
      .openapi('CostWorkedExample'),
  })
  .openapi('CostAssumptions');
assertTrue<AssertEqual<z.infer<typeof costAssumptionsSchema>, CostAssumptions>>();

export const costProjectionSchema = z
  .object({
    currentIdx: z.number().int(),
    daysElapsed: z.number().int(),
    remainingDays: z.number().int(),
    daysPerMonth: z.number().int(),
    holdoutCount: z.number().int(),
    mape: z.number().nullable(),
    quarantinedSnapshotCount: z.number().int(),
    totals: z
      .object({
        points: z.array(
          z.object({
            snapshotIdx: z.number().int(),
            snapshotDate: isoDate,
            actualCostUsd: usd,
            replayed: z.boolean(),
            trendCostUsd: nullableUsd,
            forecastLowUsd: nullableUsd,
            forecastHighUsd: nullableUsd,
          }),
        ),
        fit: z.object({
          pointCount: z.number().int(),
          slopeUsdPerDay: nullableUsd,
          interceptUsd: nullableUsd,
          residualSdUsd: nullableUsd,
        }),
        costToDateUsd: usd,
        runRateUsdPerDay: nullableUsd,
        projectedMonthEndUsd: nullableUsd,
      })
      .openapi('CostProjectionTotals', { description: 'Aggregates; visible to every role' }),
  })
  .openapi('CostProjection');
assertTrue<AssertEqual<z.infer<typeof costProjectionSchema>, CostProjection>>();

/** Page<item> plus scope-wide `totals`. */
export function pageWithTotalsSchema<T extends z.ZodTypeAny, U extends z.ZodTypeAny>(
  item: T,
  totals: U,
) {
  return pageSchema(item).extend({ totals });
}
assertTrue<
  AssertEqual<
    z.infer<
      ReturnType<typeof pageWithTotalsSchema<typeof costRowSchema, typeof costReportsTotalsSchema>>
    >,
    PageWithTotals<CostRow, CostReportsTotals>
  >
>();

// ---- owner override and audit log -------------------------------------------------------

export const ownerOverrideBodySchema = z
  .object({
    ownerEmail: emailInput
      .nullable()
      .openapi({ description: 'New owner (trimmed, lowercased); null marks the report orphaned' }),
    reason: z.string().trim().min(1).max(500).optional(),
  })
  .openapi('OwnerOverrideRequest', {
    example: { ownerEmail: 'user_3@company.com', reason: 'Team reorg' },
  });
assertTrue<AssertEqual<z.infer<typeof ownerOverrideBodySchema>, OwnerOverrideRequest>>();

export const auditActionSchema = z
  .enum(['OWNER_OVERRIDE', 'ALERT_ACK', 'ALERT_ACK_BULK', 'REPLAY_CONTROL', 'INCIDENT_INJECT'])
  .openapi('AuditAction');
assertTrue<AssertEqual<z.infer<typeof auditActionSchema>, AuditAction>>();

export const auditLogQuerySchema = pageQuerySchema.extend({ action: auditActionSchema.optional() });
export type AuditLogQuery = z.infer<typeof auditLogQuerySchema>;

export const auditLogEntrySchema = z
  .object({
    id: z.string().uuid(),
    at: z.string().datetime(),
    actorEmail: z.string(),
    action: auditActionSchema,
    target: z.string(),
    details: z.record(z.string(), z.unknown()),
  })
  .openapi('AuditLogEntry');
assertTrue<AssertEqual<z.infer<typeof auditLogEntrySchema>, AuditLogEntry>>();

// ---- errors -----------------------------------------------------------------------------

export const apiErrorSchema = z
  .object({ error: z.object({ code: z.string(), message: z.string() }) })
  .openapi('ApiError');
