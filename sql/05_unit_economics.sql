-- =============================================================================
-- 05_unit_economics.sql
-- Purpose     : Cost per active view, per snapshot and per report, in two variants:
--                 Snowflake-only  = attributed credits × price / views
--                 fully loaded    = (attributed credits × price + AWS hosting) / views
-- Inputs      : REPORT_SNAPSHOTS, REPORT_ATTRIBUTION_DAILY (04), REPORTS, PARAMS
-- Outputs     : VIEW UNIT_ECONOMICS_SNAPSHOT (one row per report × snapshot)
--                 report_id, report_name, snapshot_idx, snapshot_date, owner_email, views,
--                 aws_cost_usd, attributed_credits, snowflake_cost_usd, fully_loaded_cost_usd,
--                 snowflake_cost_per_view, fully_loaded_cost_per_view
--               VIEW UNIT_ECONOMICS_REPORT (one row per report)
--                 report_id, report_name, current_owner, snapshot_count, costed_snapshot_count,
--                 snowflake_cost_usd, aws_cost_usd, fully_loaded_cost_usd, costed_views,
--                 snowflake_cost_per_view, fully_loaded_cost_per_view
-- Assumptions :
--   * Every division uses NULLIF(views, 0): a zero-view snapshot has a NULL unit cost, never
--     Infinity (DuckDB) or a division error (Snowflake). DQ05 flags those rows.
--   * A snapshot whose credits were quarantined (DQ02, credits_clean NULL) has unknown Snowflake
--     cost: attributed_credits and every derived cost are NULL, not 0. AWS cost is still known.
--   * Report level is the ratio of totals over costed snapshots:
--       Σ cost / NULLIF(Σ views, 0), both summed over snapshots with known credits.
--     This is the view-weighted average of the snapshot unit costs. Summing monthly views
--     across daily snapshots is not a count of distinct viewers; it only weights the average.
--     aws_cost_usd and fully_loaded_cost_usd are also summed over costed snapshots, so the
--     ratio's numerator and denominator cover the same snapshots.
--   * Credits here are attributed (metered) credits, so the simulated overhead is included.
-- =============================================================================

CREATE OR REPLACE VIEW UNIT_ECONOMICS_SNAPSHOT AS
WITH snapshot_credits AS (
    SELECT
        s.report_id,
        s.report_name,
        s.snapshot_idx,
        s.snapshot_date,
        s.owner_email,
        s.monthly_active_views AS views,
        s.aws_hosting_cost_usd AS aws_cost_usd,
        CASE WHEN s.credits_clean IS NULL THEN NULL
             ELSE COALESCE(d.attributed_credits, 0) END AS attributed_credits
    FROM REPORT_SNAPSHOTS s
    LEFT JOIN REPORT_ATTRIBUTION_DAILY d
      ON d.report_id = s.report_id AND d.usage_date = s.snapshot_date
)
SELECT
    c.report_id,
    c.report_name,
    c.snapshot_idx,
    c.snapshot_date,
    c.owner_email,
    c.views,
    c.aws_cost_usd,
    c.attributed_credits,
    c.attributed_credits * p.credit_price_usd                                       AS snowflake_cost_usd,
    c.attributed_credits * p.credit_price_usd + c.aws_cost_usd                      AS fully_loaded_cost_usd,
    c.attributed_credits * p.credit_price_usd / NULLIF(c.views, 0)                  AS snowflake_cost_per_view,
    (c.attributed_credits * p.credit_price_usd + c.aws_cost_usd) / NULLIF(c.views, 0)
                                                                                    AS fully_loaded_cost_per_view
FROM snapshot_credits c
CROSS JOIN PARAMS p
ORDER BY c.report_id, c.snapshot_idx;

CREATE OR REPLACE VIEW UNIT_ECONOMICS_REPORT AS
WITH totals AS (
    SELECT
        u.report_id,
        COUNT(*)::INTEGER                                                       AS snapshot_count,
        COUNT(u.attributed_credits)::INTEGER                                    AS costed_snapshot_count,
        SUM(u.snowflake_cost_usd)                                               AS snowflake_cost_usd,
        SUM(CASE WHEN u.attributed_credits IS NOT NULL THEN u.aws_cost_usd END) AS aws_cost_usd,
        SUM(u.fully_loaded_cost_usd)                                            AS fully_loaded_cost_usd,
        SUM(CASE WHEN u.attributed_credits IS NOT NULL THEN u.views END)        AS costed_views
    FROM UNIT_ECONOMICS_SNAPSHOT u
    GROUP BY u.report_id
)
SELECT
    r.report_id,
    r.report_name,
    r.current_owner,
    t.snapshot_count,
    t.costed_snapshot_count,
    t.snowflake_cost_usd,
    t.aws_cost_usd,
    t.fully_loaded_cost_usd,
    t.costed_views::INTEGER                                 AS costed_views,
    t.snowflake_cost_usd / NULLIF(t.costed_views, 0)        AS snowflake_cost_per_view,
    t.fully_loaded_cost_usd / NULLIF(t.costed_views, 0)     AS fully_loaded_cost_per_view
FROM REPORTS r
JOIN totals t ON t.report_id = r.report_id
ORDER BY fully_loaded_cost_per_view DESC NULLS LAST, r.report_id;
