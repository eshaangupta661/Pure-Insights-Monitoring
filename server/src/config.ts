import { z } from 'zod';

const envSchema = z
  .object({
    PORT: z.coerce.number().int().positive().default(3000),
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    JWT_SECRET: z.string().min(1).optional(),
    TICK_MS: z.coerce.number().int().positive().default(10_000),
    SNAPSHOT_COUNT: z.coerce.number().int().positive().default(20),
    // Render's free instance has 512MB and a fractional CPU; keep DuckDB well inside that.
    DUCKDB_THREADS: z.coerce.number().int().positive().default(1),
    DUCKDB_MEMORY_LIMIT: z
      .string()
      .regex(/^\d+(\.\d+)?\s*(KB|MB|GB|KiB|MiB|GiB)$/i)
      .default('256MB'),
  })
  .refine((e) => e.NODE_ENV !== 'production' || Boolean(e.JWT_SECRET), {
    path: ['JWT_SECRET'],
    message: 'JWT_SECRET is required when NODE_ENV=production',
  });

const env = envSchema.parse(process.env);

/** Single source of truth for parameters and thresholds. Keep in sync with /sql/00_setup_parameters.sql. */
export const config = {
  port: env.PORT,
  nodeEnv: env.NODE_ENV,
  // Dev/test fallback only; production parsing above guarantees a real secret.
  jwtSecret: env.JWT_SECRET ?? 'dev-only-insecure-secret',
  TICK_MS: env.TICK_MS,
  SNAPSHOT_COUNT: env.SNAPSHOT_COUNT,
  DUCKDB_THREADS: env.DUCKDB_THREADS,
  DUCKDB_MEMORY_LIMIT: env.DUCKDB_MEMORY_LIMIT,

  // Cost attribution (also in /sql/00_setup_parameters.sql).
  CREDIT_PRICE_USD: 3.0, // assumption
  /**
   * Synthetic proportional overhead: metered credits = query credits × (1 + rate). Not measured
   * idle time; it only makes metering exceed query usage the way real Snowflake bills do.
   */
  SIMULATED_OVERHEAD_RATE: 0.15,
  /** Absolute tolerance (credits) for the reconciliation checks in /sql/08_reconciliation.sql. */
  RECON_TOLERANCE: 1e-6,

  // Snowflake simulator only (server/src/ingest/snowflake-sim.ts); not used by the SQL suite.
  SIM_SEED: 20260921,
  /** A report runs on WAREHOUSES[fnv1a32(report_id) % 3]. */
  WAREHOUSES: ['REPORTING_WH_XS', 'REPORTING_WH_M', 'ADHOC_WH'],
  /**
   * Execution milliseconds per credit. Real Snowflake bills XS 1, S 2, M 4 credits/hour
   * (3,600,000 / 1,800,000 / 900,000 ms per credit); these keep the 1:2:4 ratios at 1/1000 time
   * scale (ADHOC_WH is a Small). Multiples of 100 so 2-decimal credits map to whole milliseconds.
   */
  MS_PER_CREDIT: { REPORTING_WH_XS: 3600, REPORTING_WH_M: 900, ADHOC_WH: 1800 },
  /** Spread of the lognormal weights that split a snapshot's credits across its queries. */
  SIM_EXEC_LOG_SIGMA: 0.8,
  /** Relative query volume per UTC hour (0–23): a business-day curve. */
  SIM_HOURLY_WEIGHTS: [1, 1, 1, 1, 1, 2, 3, 5, 8, 9, 9, 8, 7, 8, 9, 9, 8, 6, 4, 3, 2, 2, 1, 1],

  // Data quality (DQ03 / DQ04 / DQ08) and latency alert thresholds.
  LATENCY_WARNING_SEC: 15,
  LATENCY_CRITICAL_SEC: 30,
  COST_ROBUST_Z: 3.5,
  COST_LOW_VIEWS: 50,
  COST_HIGH_AWS_USD: 300,
  /** Snapshot 0 date; snapshot i = base + i days. Assumption: the CSV carries no dates. */
  SNAPSHOT_BASE_DATE: '2026-09-21',

  // Ingest normalization (DQ01 / DQ07).
  /** Owner values meaning "no owner", compared lowercase after trimming (pandas NaN is `nan`). */
  ORPHAN_OWNER_MARKERS: ['', 'nan', 'orphaned_report'],
  /** Allowed last_refresh_status values (after trim + uppercase); anything else fails ingest. */
  REFRESH_STATUSES: ['SUCCESS', 'FAILED', 'TIMED_OUT', 'UNKNOWN'],
} as const;

export type RefreshStatus = (typeof config.REFRESH_STATUSES)[number];
export type WarehouseName = (typeof config.WAREHOUSES)[number];
