-- =============================================================================
-- 05_unit_economics.sql
-- Purpose     : Cost per active view on a 30-day basis, per snapshot and per report, in two
--               variants:
--                 Snowflake-only  = 30-day Snowflake cost / views
--                 fully loaded    = (30-day Snowflake cost + monthly AWS hosting) / views
-- Inputs      : REPORT_SNAPSHOTS, REPORT_ATTRIBUTION_DAILY (04), REPORTS, REPORT_CURRENT_OWNER (01),
--               PARAMS
-- Outputs     : VIEW UNIT_ECONOMICS_SNAPSHOT (one row per report × snapshot)
--                 report_id, report_name, snapshot_idx, snapshot_date, owner_email, views,
--                 aws_cost_usd            the snapshot's AWS hosting (a monthly bill)
--                 attributed_credits      metered credits on the snapshot's day
--                 snowflake_cost_usd      attributed_credits × credit_price_usd (one day)
--                 snowflake_cost_30d_usd  snowflake_cost_usd × days_per_month
--                 fully_loaded_cost_usd   snowflake_cost_30d_usd + aws_cost_usd (30 days)
--                 snowflake_cost_per_view, fully_loaded_cost_per_view (30-day cost / views)
--               VIEW UNIT_ECONOMICS_REPORT (one row per report)
--                 report_id, report_name, current_owner, snapshot_count, costed_snapshot_count,
--                 snowflake_cost_usd      Σ daily Snowflake cost (the period's actual spend)
--                 snowflake_cost_30d_usd, aws_cost_usd, fully_loaded_cost_usd
--                                         Σ of the 30-day figures (the ratio's numerators)
--                 costed_views            Σ monthly views (the ratio's denominator, a weight)
--                 snowflake_cost_per_view, fully_loaded_cost_per_view
-- Assumptions :
--   * Periods. A snapshot's credits are spent during its own day (see 03/04), while
--     monthly_active_views counts 30 days. Dividing one day of cost by 30 days of views would
--     understate cost per view about 30×, so the Snowflake cost is scaled to 30 days first
--     (× days_per_month). aws_hosting_cost_usd is assumed to be a monthly bill (the CSV doesn't
--     say), so it is added as is. Numerator and denominator then both cover 30 days.
--   * Every division uses NULLIF(views, 0): a zero-view snapshot has a NULL unit cost, never
--     Infinity (DuckDB) or a division error (Snowflake). DQ05 flags those rows.
--   * A snapshot whose credits were quarantined (DQ02, credits_clean NULL) has unknown Snowflake
--     cost: attributed_credits and every derived cost are NULL, not 0. AWS cost is still known.
--   * Report level is the ratio of totals over costed snapshots:
--       Σ 30-day cost / NULLIF(Σ views, 0), both summed over snapshots with known credits.
--     This is the view-weighted average of the snapshot unit costs. Summing monthly views
--     across daily snapshots is not a count of distinct viewers; it only weights the average.
--     aws_cost_usd and fully_loaded_cost_usd are also summed over costed snapshots, so the
--     ratio's numerator and denominator cover the same snapshots. That makes aws_cost_usd here
--     smaller than the all-snapshot AWS total in 07 by the AWS of quarantined snapshots.
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
    c.attributed_credits * p.credit_price_usd * p.days_per_month                    AS snowflake_cost_30d_usd,
    c.attributed_credits * p.credit_price_usd * p.days_per_month + c.aws_cost_usd   AS fully_loaded_cost_usd,
    c.attributed_credits * p.credit_price_usd * p.days_per_month / NULLIF(c.views, 0)
                                                                                    AS snowflake_cost_per_view,
    (c.attributed_credits * p.credit_price_usd * p.days_per_month + c.aws_cost_usd)
        / NULLIF(c.views, 0)                                                        AS fully_loaded_cost_per_view
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
        SUM(u.snowflake_cost_30d_usd)                                           AS snowflake_cost_30d_usd,
        SUM(CASE WHEN u.attributed_credits IS NOT NULL THEN u.aws_cost_usd END) AS aws_cost_usd,
        SUM(u.fully_loaded_cost_usd)                                            AS fully_loaded_cost_usd,
        SUM(CASE WHEN u.attributed_credits IS NOT NULL THEN u.views END)        AS costed_views
    FROM UNIT_ECONOMICS_SNAPSHOT u
    GROUP BY u.report_id
)
SELECT
    r.report_id,
    r.report_name,
    o.current_owner,
    t.snapshot_count,
    t.costed_snapshot_count,
    t.snowflake_cost_usd,
    t.snowflake_cost_30d_usd,
    t.aws_cost_usd,
    t.fully_loaded_cost_usd,
    t.costed_views::INTEGER                                 AS costed_views,
    t.snowflake_cost_30d_usd / NULLIF(t.costed_views, 0)    AS snowflake_cost_per_view,
    t.fully_loaded_cost_usd / NULLIF(t.costed_views, 0)     AS fully_loaded_cost_per_view
FROM REPORTS r
JOIN REPORT_CURRENT_OWNER o ON o.report_id = r.report_id
JOIN totals t ON t.report_id = r.report_id
ORDER BY fully_loaded_cost_per_view DESC NULLS LAST, r.report_id;
