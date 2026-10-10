-- =============================================================================
-- 06_anomalies.sql
-- Purpose     : Cost anomalies worth a human look.
-- Inputs      : UNIT_ECONOMICS_SNAPSHOT (05), REPORT_ATTRIBUTION (04), DQ_ROW_CHECKS (02),
--               REPORT_SNAPSHOTS, REPORTS, REPORT_CURRENT_OWNER (01), QUARANTINE, PARAMS
-- Outputs     : VIEW ANOMALY_COST_PER_VIEW (snapshots whose fully-loaded cost per view is an outlier)
--                 report_id, report_name, snapshot_idx, snapshot_date, views,
--                 fully_loaded_cost_per_view, robust_z, direction ('HIGH' | 'LOW')
--               VIEW ANOMALY_ZOMBIE_REPORTS (reports still spending with nobody owning or using them)
--                 report_id, report_name, current_owner, latest_snapshot_idx, latest_views,
--                 latest_attributed_credits, latest_snowflake_cost_usd,
--                 total_attributed_credits, total_attributed_cost_usd,
--                 reason ('ORPHANED' | 'LOW_USAGE' | 'BOTH')
--               VIEW ANOMALY_AWS_VIEWS_MISMATCH (DQ04 rows: AWS hosting out of line with views)
--                 row_idx, report_id, report_name, snapshot_idx, views, aws_cost_usd,
--                 aws_cost_per_view, aws_log_z, reason ('HARD_RULE' | 'ROBUST_Z' | 'BOTH')
--               VIEW ANOMALY_NEGATIVE_CREDITS (the DQ02 quarantine, readable)
--                 row_idx, report_id, report_name, snapshot_idx, current_owner, raw_credits, reason
-- Assumptions :
--   * Cost-per-view outliers: modified z = 0.6745 · (x − median) / MAD on
--     x = ln(fully_loaded_cost_per_view), median and MAD pooled over every snapshot with a known,
--     positive unit cost (zero-view and quarantined snapshots are NULL and skipped). Outlier when
--     |z| > cost_robust_z. The log makes the right-skewed costs roughly symmetric.
--   * Zombie report: in the latest snapshot the report still spends credits
--     (attributed_credits > 0) AND either nobody owns it (current_owner IS NULL) or almost nobody
--     uses it (views < cost_low_views). The definition looks only at the latest snapshot because
--     views in this dataset swing between snapshots, so no report stays low for long.
--   * AWS mismatch reuses DQ04 from 02 so the rule is defined once.
--   * Negative credits come from QUARANTINE.raw_value (the pointer kept by ingest), so this
--     file never reads the uncleaned credits column.
-- =============================================================================

CREATE OR REPLACE VIEW ANOMALY_COST_PER_VIEW AS
WITH points AS (
    SELECT
        report_id, report_name, snapshot_idx, snapshot_date, views, fully_loaded_cost_per_view,
        -- Guarded like the WHERE: Snowflake may evaluate LN before filtering, and LN(<= 0) errors.
        LN(CASE WHEN fully_loaded_cost_per_view > 0 THEN fully_loaded_cost_per_view END) AS x
    FROM UNIT_ECONOMICS_SNAPSHOT
    WHERE fully_loaded_cost_per_view > 0
),
center AS (
    SELECT MEDIAN(x) AS median_x FROM points
),
spread AS (
    SELECT MEDIAN(ABS(pt.x - c.median_x)) AS mad_x
    FROM points pt CROSS JOIN center c
),
scored AS (
    SELECT pt.*, 0.6745 * (pt.x - c.median_x) / NULLIF(s.mad_x, 0) AS robust_z
    FROM points pt CROSS JOIN center c CROSS JOIN spread s
)
SELECT
    s.report_id,
    s.report_name,
    s.snapshot_idx,
    s.snapshot_date,
    s.views,
    s.fully_loaded_cost_per_view,
    s.robust_z,
    CASE WHEN s.robust_z > 0 THEN 'HIGH' ELSE 'LOW' END AS direction
FROM scored s
CROSS JOIN PARAMS p
WHERE ABS(s.robust_z) > p.cost_robust_z
ORDER BY ABS(s.robust_z) DESC, s.report_id, s.snapshot_idx;

CREATE OR REPLACE VIEW ANOMALY_ZOMBIE_REPORTS AS
WITH latest AS (
    SELECT *
    FROM UNIT_ECONOMICS_SNAPSHOT
    WHERE snapshot_idx = (SELECT MAX(snapshot_idx) FROM REPORT_SNAPSHOTS)
),
flagged AS (
    SELECT
        l.*,
        o.current_owner,
        o.is_orphaned,
        l.views < p.cost_low_views   AS is_low_usage
    FROM latest l
    JOIN REPORT_CURRENT_OWNER o ON o.report_id = l.report_id
    CROSS JOIN PARAMS p
    WHERE l.attributed_credits > 0
)
SELECT
    f.report_id,
    f.report_name,
    f.current_owner,
    f.snapshot_idx                 AS latest_snapshot_idx,
    f.views                        AS latest_views,
    f.attributed_credits           AS latest_attributed_credits,
    f.snowflake_cost_usd           AS latest_snowflake_cost_usd,
    a.attributed_credits           AS total_attributed_credits,
    a.attributed_cost_usd          AS total_attributed_cost_usd,
    CASE WHEN f.is_orphaned AND f.is_low_usage THEN 'BOTH'
         WHEN f.is_orphaned THEN 'ORPHANED'
         ELSE 'LOW_USAGE' END      AS reason
FROM flagged f
JOIN REPORT_ATTRIBUTION a ON a.report_id = f.report_id
WHERE f.is_orphaned OR f.is_low_usage
ORDER BY a.attributed_credits DESC, f.report_id;

CREATE OR REPLACE VIEW ANOMALY_AWS_VIEWS_MISMATCH AS
SELECT
    d.row_idx,
    s.report_id,
    s.report_name,
    s.snapshot_idx,
    s.monthly_active_views                                       AS views,
    s.aws_hosting_cost_usd                                       AS aws_cost_usd,
    s.aws_hosting_cost_usd / NULLIF(s.monthly_active_views, 0)   AS aws_cost_per_view,
    d.aws_log_z,
    CASE WHEN d.dq04_hard AND d.dq04_z THEN 'BOTH'
         WHEN d.dq04_hard THEN 'HARD_RULE'
         ELSE 'ROBUST_Z' END                                     AS reason
FROM DQ_ROW_CHECKS d
JOIN REPORT_SNAPSHOTS s ON s.row_idx = d.row_idx
WHERE d.dq04
ORDER BY aws_cost_per_view DESC NULLS FIRST, d.row_idx;

CREATE OR REPLACE VIEW ANOMALY_NEGATIVE_CREDITS AS
SELECT
    q.row_idx,
    q.report_id,
    r.report_name,
    q.snapshot_idx,
    o.current_owner,
    CAST(q.raw_value AS DOUBLE) AS raw_credits,
    q.reason
FROM QUARANTINE q
JOIN REPORTS r ON r.report_id = q.report_id
JOIN REPORT_CURRENT_OWNER o ON o.report_id = q.report_id
WHERE q.rule_id = 'DQ02'
ORDER BY raw_credits, q.row_idx;
