-- =============================================================================
-- 00_setup_parameters.sql
-- Purpose     : Every price, rate and threshold the suite uses, in one place. Later files
--               CROSS JOIN PARAMS instead of hard-coding numbers.
-- Inputs      : none
-- Outputs     : TABLE PARAMS (one row)
--                 credit_price_usd         USD per Snowflake credit
--                 simulated_overhead_rate  metered = query credits × (1 + rate)
--                 latency_warning_sec      DQ03 / DQ08 and WARNING alerts (> this)
--                 latency_critical_sec     CRITICAL alerts (> this)
--                 cost_robust_z            |modified z| above this is an outlier (DQ04, 06)
--                 cost_low_views           "low usage" views threshold (DQ04 hard rule, zombies)
--                 cost_high_aws_usd        AWS spend that is suspicious at low views (DQ04)
--                 recon_tolerance          absolute tolerance (credits) for 08 checks
--               TABLE PARAM_ORPHAN_MARKERS (marker): owner values meaning "no owner",
--                 compared after LOWER(TRIM(...)) (DQ01)
-- Assumptions :
--   * server/src/config.ts is the source of truth; startup fails if these values drift from it.
--   * credit_price_usd = 3.00 is an assumption (Enterprise on-demand is roughly $3/credit).
--   * simulated_overhead_rate is a synthetic proportional overhead, not measured idle time. It
--     only makes metered credits exceed query credits, as real warehouse bills do.
-- =============================================================================

CREATE OR REPLACE TABLE PARAMS AS
SELECT
    3.00::DOUBLE     AS credit_price_usd,
    0.15::DOUBLE     AS simulated_overhead_rate,
    15::DOUBLE       AS latency_warning_sec,
    30::DOUBLE       AS latency_critical_sec,
    3.5::DOUBLE      AS cost_robust_z,
    50::INTEGER      AS cost_low_views,
    300::DOUBLE      AS cost_high_aws_usd,
    0.000001::DOUBLE AS recon_tolerance;

CREATE OR REPLACE TABLE PARAM_ORPHAN_MARKERS AS
SELECT marker
FROM (VALUES (''), ('nan'), ('orphaned_report')) AS t(marker);
