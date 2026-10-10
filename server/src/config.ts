import { z } from 'zod';

const envSchema = z
  .object({
    PORT: z.coerce.number().int().positive().default(3000),
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    JWT_SECRET: z.string().min(1).optional(),
    TICK_MS: z.coerce.number().int().positive().default(10_000),
    SNAPSHOT_COUNT: z.coerce.number().int().positive().default(20),
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
  CREDIT_PRICE_USD: 3.0, // assumption
  IDLE_OVERHEAD: 0.15,

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
