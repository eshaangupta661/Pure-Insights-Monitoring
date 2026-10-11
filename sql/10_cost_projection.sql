-- =============================================================================
-- 10_cost_projection.sql
-- Purpose     : A simple cost forecast as the replay advances. For every period end N (the
--               replay's current snapshot) and scope, fit a straight line to the daily
--               Snowflake cost of snapshots 0..N, forecast snapshots N+1..last with a ±1.96σ
--               band, project the 30-day month-end total, and, while snapshots after N exist,
--               score the forecast against them (MAPE).
-- Inputs      : UNIT_ECONOMICS_SNAPSHOT (05), REPORT_CURRENT_OWNER (01), PERIOD_TO_DATE (09),
--               PARAMS
-- Outputs     : VIEW COST_DAILY_SERIES (one row per snapshot × scope)
--                 scope_kind ('ALL' | 'OWNER', one row per current owner, NULL = no owner),
--                 current_owner, snapshot_idx, snapshot_date,
--                 cost_usd                  Σ attributed Snowflake cost that day
--                 quarantined_count         report snapshots with unknown credits (DQ02)
--               VIEW COST_PROJECTION_FIT (one row per period end N × scope)
--                 period_end_idx, scope_kind, current_owner,
--                 point_count               N + 1 (snapshots in the fit)
--                 slope_usd_per_day, intercept_usd
--                                           least-squares line cost = intercept + slope × idx;
--                                           NULL when N = 0 (one point)
--                 residual_sd_usd           sqrt(Σ residual² / (n − 2)); NULL when n <= 2
--                 cost_to_date_usd          Σ cost_usd over 0..N
--                 run_rate_usd_per_day      cost_to_date_usd / (N + 1)
--                 days_elapsed, remaining_days   N + 1 and days_per_month − (N + 1), floored at 0
--                 projected_month_end_usd   cost_to_date_usd + run_rate × remaining_days
--                 holdout_count             snapshots after N (actuals the forecast is scored on)
--                 mape                      mean |actual − forecast| / actual over N+1..last;
--                                           NULL when there is no holdout or no fit
--               VIEW COST_PROJECTION (one row per period end N × scope × snapshot)
--                 period_end_idx, scope_kind, current_owner, snapshot_idx, snapshot_date,
--                 actual_cost_usd, is_replayed (snapshot_idx <= N),
--                 trend_cost_usd            intercept + slope × snapshot_idx (every snapshot)
--                 forecast_low_usd, forecast_high_usd
--                                           trend ± 1.96 × residual_sd, only after N
--               VIEW COST_PROJECTION_CHECKS (same columns as RECONCILIATION in 08; any FAIL
--               stops ingest and startup)
-- Assumptions :
--   * Every snapshot is one day (as in 09), so snapshot_idx is the day number and the slope is
--     USD per day. The month is days_per_month (30) days from snapshot 0; the data has fewer
--     snapshots, so the month end is always a projection.
--   * Cost is attributed Snowflake cost only. AWS hosting is a monthly bill (05), not a daily
--     series, so it is not forecast.
--   * Quarantined snapshots (DQ02) have unknown cost and add 0 to a day's total, as in 09's cost
--     to date; the run rate is therefore a slight underestimate on days with quarantined rows.
--   * The band is trend ± 1.96σ of the in-sample residuals: a rough 95% band that assumes
--     normal, independent residuals and ignores the uncertainty in the fitted line itself.
--   * Month-end uses the average daily cost to date (run rate), not the trend line, so it does
--     not extrapolate a slope fitted on a handful of points 10+ days out.
--   * Rows are grouped by current owner (REPORT_CURRENT_OWNER), the owner the API scopes on.
--     The view is live, so owner overrides apply.
--   * REGR_SLOPE / REGR_INTERCEPT take (y, x) in both Snowflake and DuckDB.
-- =============================================================================

CREATE OR REPLACE VIEW COST_DAILY_SERIES AS
SELECT
    CASE WHEN GROUPING(o.current_owner) = 1 THEN 'ALL' ELSE 'OWNER' END   AS scope_kind,
    o.current_owner,
    u.snapshot_idx,
    MIN(u.snapshot_date)                                                   AS snapshot_date,
    COALESCE(SUM(u.snowflake_cost_usd), 0)                                 AS cost_usd,
    COUNT_IF(u.attributed_credits IS NULL)::INTEGER                        AS quarantined_count
FROM UNIT_ECONOMICS_SNAPSHOT u
JOIN REPORT_CURRENT_OWNER o ON o.report_id = u.report_id
GROUP BY GROUPING SETS ((u.snapshot_idx), (u.snapshot_idx, o.current_owner));

CREATE OR REPLACE VIEW COST_PROJECTION_FIT AS
WITH
period_ends AS (
    SELECT DISTINCT snapshot_idx AS period_end_idx FROM COST_DAILY_SERIES
),
fit_points AS (
    SELECT e.period_end_idx, d.scope_kind, d.current_owner, d.snapshot_idx, d.cost_usd,
           d.quarantined_count
    FROM period_ends e
    JOIN COST_DAILY_SERIES d ON d.snapshot_idx <= e.period_end_idx
),
fit AS (
    SELECT
        period_end_idx,
        scope_kind,
        current_owner,
        COUNT(*)::INTEGER                                    AS point_count,
        -- One point has no slope: Snowflake returns NULL, DuckDB NaN, so guard explicitly.
        CASE WHEN COUNT(*) >= 2 THEN REGR_SLOPE(cost_usd, snapshot_idx::DOUBLE) END
                                                             AS slope_usd_per_day,
        CASE WHEN COUNT(*) >= 2 THEN REGR_INTERCEPT(cost_usd, snapshot_idx::DOUBLE) END
                                                             AS intercept_usd,
        SUM(cost_usd)                                        AS cost_to_date_usd,
        SUM(quarantined_count)::INTEGER                      AS quarantined_snapshot_count
    FROM fit_points
    GROUP BY period_end_idx, scope_kind, current_owner
),
residuals AS (
    SELECT
        f.period_end_idx,
        f.scope_kind,
        f.current_owner,
        SQRT(SUM(POWER(p.cost_usd - (f.intercept_usd + f.slope_usd_per_day * p.snapshot_idx), 2))
             / NULLIF(COUNT(*) - 2, 0))                      AS residual_sd_usd
    FROM fit f
    JOIN fit_points p
      ON p.period_end_idx = f.period_end_idx
     AND p.scope_kind = f.scope_kind
     AND p.current_owner IS NOT DISTINCT FROM f.current_owner
    GROUP BY f.period_end_idx, f.scope_kind, f.current_owner
),
holdout AS (
    SELECT
        f.period_end_idx,
        f.scope_kind,
        f.current_owner,
        COUNT(d.snapshot_idx)::INTEGER                       AS holdout_count,
        AVG(ABS(d.cost_usd - (f.intercept_usd + f.slope_usd_per_day * d.snapshot_idx))
            / NULLIF(d.cost_usd, 0))                         AS mape
    FROM fit f
    LEFT JOIN COST_DAILY_SERIES d
      ON d.scope_kind = f.scope_kind
     AND d.current_owner IS NOT DISTINCT FROM f.current_owner
     AND d.snapshot_idx > f.period_end_idx
    GROUP BY f.period_end_idx, f.scope_kind, f.current_owner
)
SELECT
    f.period_end_idx,
    f.scope_kind,
    f.current_owner,
    f.point_count,
    f.slope_usd_per_day,
    f.intercept_usd,
    r.residual_sd_usd,
    f.cost_to_date_usd,
    f.quarantined_snapshot_count,
    f.cost_to_date_usd / NULLIF(f.point_count, 0)                          AS run_rate_usd_per_day,
    (f.period_end_idx + 1)::INTEGER                                        AS days_elapsed,
    GREATEST(p.days_per_month - (f.period_end_idx + 1), 0)::INTEGER        AS remaining_days,
    f.cost_to_date_usd
        + f.cost_to_date_usd / NULLIF(f.point_count, 0)
          * GREATEST(p.days_per_month - (f.period_end_idx + 1), 0)         AS projected_month_end_usd,
    h.holdout_count,
    h.mape
FROM fit f
JOIN residuals r
  ON r.period_end_idx = f.period_end_idx
 AND r.scope_kind = f.scope_kind
 AND r.current_owner IS NOT DISTINCT FROM f.current_owner
JOIN holdout h
  ON h.period_end_idx = f.period_end_idx
 AND h.scope_kind = f.scope_kind
 AND h.current_owner IS NOT DISTINCT FROM f.current_owner
CROSS JOIN PARAMS p;

CREATE OR REPLACE VIEW COST_PROJECTION AS
SELECT
    f.period_end_idx,
    f.scope_kind,
    f.current_owner,
    d.snapshot_idx,
    d.snapshot_date,
    d.cost_usd                                                             AS actual_cost_usd,
    d.snapshot_idx <= f.period_end_idx                                     AS is_replayed,
    f.intercept_usd + f.slope_usd_per_day * d.snapshot_idx                 AS trend_cost_usd,
    CASE WHEN d.snapshot_idx > f.period_end_idx
         THEN f.intercept_usd + f.slope_usd_per_day * d.snapshot_idx - 1.96 * f.residual_sd_usd
    END                                                                    AS forecast_low_usd,
    CASE WHEN d.snapshot_idx > f.period_end_idx
         THEN f.intercept_usd + f.slope_usd_per_day * d.snapshot_idx + 1.96 * f.residual_sd_usd
    END                                                                    AS forecast_high_usd
FROM COST_PROJECTION_FIT f
JOIN COST_DAILY_SERIES d
  ON d.scope_kind = f.scope_kind
 AND d.current_owner IS NOT DISTINCT FROM f.current_owner;

CREATE OR REPLACE VIEW COST_PROJECTION_CHECKS AS
WITH
portfolio AS (
    SELECT * FROM COST_PROJECTION_FIT WHERE scope_kind = 'ALL'
),
owner_sums AS (
    SELECT period_end_idx, SUM(cost_to_date_usd) AS cost_to_date_usd
    FROM COST_PROJECTION_FIT
    WHERE scope_kind = 'OWNER'
    GROUP BY period_end_idx
),
fitted_residuals AS (
    -- Least squares with an intercept: in-sample residuals sum to 0 for every fit.
    SELECT c.period_end_idx, c.scope_kind, c.current_owner,
           SUM(c.actual_cost_usd - c.trend_cost_usd) AS residual_sum
    FROM COST_PROJECTION c
    WHERE c.is_replayed AND c.trend_cost_usd IS NOT NULL
    GROUP BY c.period_end_idx, c.scope_kind, c.current_owner
),
checks AS (
    SELECT 'F1_TO_DATE_EQ_PERIOD_TO_DATE' AS check_id, 'CONSISTENCY' AS check_kind,
           'Largest |cost to date − PERIOD_TO_DATE (09) Snowflake cost to date| over every N, portfolio (expected 0)' AS description,
           0::DOUBLE AS expected,
           MAX(ABS(f.cost_to_date_usd - t.snowflake_cost_to_date_usd))::DOUBLE AS actual
    FROM portfolio f
    JOIN PERIOD_TO_DATE t ON t.period_end_idx = f.period_end_idx AND t.scope_kind = 'ALL'
    UNION ALL
    SELECT 'F2_OWNER_SERIES_SUM_TO_PORTFOLIO', 'CONSISTENCY',
           'Largest |Σ owner cost to date − portfolio cost to date| over every N (expected 0)',
           0, MAX(ABS(o.cost_to_date_usd - p.cost_to_date_usd))
    FROM portfolio p JOIN owner_sums o ON o.period_end_idx = p.period_end_idx
    UNION ALL
    SELECT 'F3_RESIDUALS_SUM_TO_ZERO', 'CONSISTENCY',
           'Largest |Σ in-sample residuals| over every fit (least squares with intercept; expected 0)',
           0, MAX(ABS(residual_sum))
    FROM fitted_residuals
    UNION ALL
    SELECT 'F4_HOLDOUT_IS_REST_OF_SERIES', 'CONSISTENCY',
           'Portfolio fits whose holdout_count ≠ snapshots after N (expected 0)',
           0, COUNT_IF(holdout_count <> (SELECT MAX(period_end_idx) FROM portfolio) - period_end_idx)
    FROM portfolio
)
SELECT
    c.check_id,
    c.check_kind,
    c.description,
    c.expected,
    c.actual,
    ABS(c.actual - c.expected)                                               AS abs_diff,
    p.recon_tolerance                                                        AS tolerance,
    CASE WHEN ABS(c.actual - c.expected) <= p.recon_tolerance THEN 'PASS' ELSE 'FAIL' END AS status
FROM checks c
CROSS JOIN PARAMS p
ORDER BY c.check_id;
