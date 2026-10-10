-- =============================================================================
-- 04_report_attribution.sql
-- Purpose     : Roll query-level cost up to reports through QUERY_TAG, per day and in total.
-- Inputs      : QUERY_ATTRIBUTED_COST (03), REPORTS, PARAMS
-- Outputs     : VIEW REPORT_ATTRIBUTION_DAILY (one row per report × usage_date with queries)
--                 report_id, usage_date, query_count, attributed_credits, attributed_cost_usd
--               VIEW REPORT_ATTRIBUTION (one row per report in REPORTS, including reports with
--               no queries, plus one 'UNATTRIBUTED' line that is always present)
--                 report_id            RPT_xxx, or 'UNATTRIBUTED' for queries whose tag is
--                                      missing, invalid or names an unknown report
--                 report_name, current_owner (NULL on the UNATTRIBUTED line), query_count,
--                 attributed_credits   metered credits allocated to the line
--                 active_credits       attributed_credits / (1 + simulated_overhead_rate)
--                 overhead_credits     attributed_credits − active_credits
--                 attributed_cost_usd  attributed_credits × credit_price_usd
--                 share_of_total       the line's fraction of all attributed credits
-- Assumptions :
--   * Queries are attributed to the day they started (usage_date), so a refresh that runs past
--     midnight still counts toward its own snapshot.
--   * Untagged spend is shown, not dropped: the UNATTRIBUTED line makes Σ REPORT_ATTRIBUTION
--     equal Σ query-attributed credits on any account (08 C3). It is 0 here because the
--     simulator tags every query (08 G4); on a real account it holds ad hoc / analyst usage.
--   * active/overhead is a decomposition under the simulated overhead rate, not a measurement:
--     metering does not say which credits were "active". With a real bill you would only have
--     attributed_credits.
-- =============================================================================

CREATE OR REPLACE VIEW REPORT_ATTRIBUTION_DAILY AS
SELECT
    c.report_id,
    c.usage_date,
    COUNT(*)::INTEGER          AS query_count,
    SUM(c.attributed_credits)  AS attributed_credits,
    SUM(c.attributed_cost_usd) AS attributed_cost_usd
FROM QUERY_ATTRIBUTED_COST c
JOIN REPORTS r ON r.report_id = c.report_id
GROUP BY c.report_id, c.usage_date;

CREATE OR REPLACE VIEW REPORT_ATTRIBUTION AS
WITH per_report AS (
    SELECT report_id, SUM(query_count) AS query_count, SUM(attributed_credits) AS attributed_credits
    FROM REPORT_ATTRIBUTION_DAILY
    GROUP BY report_id
),
unattributed AS (
    SELECT COUNT(*) AS query_count, COALESCE(SUM(c.attributed_credits), 0) AS attributed_credits
    FROM QUERY_ATTRIBUTED_COST c
    WHERE c.report_id IS NULL OR c.report_id NOT IN (SELECT report_id FROM REPORTS)
),
credits AS (
    SELECT
        r.report_id,
        r.report_name,
        r.current_owner,
        COALESCE(a.query_count, 0)::INTEGER  AS query_count,
        COALESCE(a.attributed_credits, 0)    AS attributed_credits
    FROM REPORTS r
    LEFT JOIN per_report a ON a.report_id = r.report_id
    UNION ALL
    SELECT
        'UNATTRIBUTED',
        '(untagged or unknown-report queries)',
        NULL,
        u.query_count::INTEGER,
        u.attributed_credits
    FROM unattributed u
)
SELECT
    c.report_id,
    c.report_name,
    c.current_owner,
    c.query_count,
    c.attributed_credits,
    c.attributed_credits / (1 + p.simulated_overhead_rate)                        AS active_credits,
    c.attributed_credits - c.attributed_credits / (1 + p.simulated_overhead_rate) AS overhead_credits,
    c.attributed_credits * p.credit_price_usd                                     AS attributed_cost_usd,
    c.attributed_credits / NULLIF(SUM(c.attributed_credits) OVER (), 0)            AS share_of_total
FROM credits c
CROSS JOIN PARAMS p
ORDER BY c.attributed_credits DESC, c.report_id;
