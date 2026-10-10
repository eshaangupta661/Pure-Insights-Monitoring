-- =============================================================================
-- 02_data_quality.sql
-- Purpose     : The nine data quality rules (DQ01–DQ09) recomputed in SQL straight from the raw
--               CSV text, independently of the TypeScript rules in server/src/ingest/rules.ts,
--               and compared with the counts ingest recorded. A mismatch means the two
--               implementations disagree and fails startup.
-- Inputs      : RAW_REPORT_SNAPSHOTS (all VARCHAR), PARAMS, PARAM_ORPHAN_MARKERS, DQ_RESULTS
-- Outputs     : VIEW DQ_ROW_CHECKS (one row per CSV row)
--                 row_idx, report_id, owner_norm,
--                 dq01 … dq09     BOOLEAN, one per rule
--                 dq04_hard       views < cost_low_views AND aws > cost_high_aws_usd
--                 dq04_z          |aws_log_z| > cost_robust_z
--                 aws_log_z       modified z-score of ln(aws / views); NULL when log undefined
--               VIEW DQ_CHECKS (one row per rule)
--                 rule_id, sql_rows, ts_rows, status ('PASS' when equal, else 'FAIL')
-- Assumptions :
--   * Row order (row_idx) within a report is snapshot order, so DQ09 compares each row with the
--     report's previous row. The first snapshot of a report is never an ownership change.
--   * Owner normalization mirrors ingest: LOWER(TRIM(owner)), and marker values become NULL.
--     Two NULL owners in a row are not a change; NULL to an email (or back) is.
--   * DQ04 robust z: modified z = 0.6745 · (x − median) / MAD on x = ln(aws / views), with median
--     and MAD pooled over all snapshots, using rows where views > 0 and aws > 0. Zero-view rows
--     are DQ05's; they reach DQ04 only via the hard rule.
-- =============================================================================

CREATE OR REPLACE VIEW DQ_ROW_CHECKS AS
WITH typed AS (
    SELECT
        r.row_idx,
        r.report_id,
        LOWER(TRIM(r.owner_email))                              AS owner_lc,
        UPPER(TRIM(r.last_refresh_status))                      AS refresh_status,
        CAST(r.monthly_active_views AS INTEGER)                 AS views,
        CAST(r.snowflake_credits_consumed AS DOUBLE)            AS credits,
        CAST(r.avg_load_time_sec AS DOUBLE)                     AS load_sec,
        CAST(r.aws_hosting_cost_usd AS DOUBLE)                  AS aws_usd,
        CAST(r.concurrent_user_peak AS INTEGER)                 AS concurrent_peak
    FROM RAW_REPORT_SNAPSHOTS r
),
normalized AS (
    SELECT
        t.*,
        t.owner_lc IN (SELECT marker FROM PARAM_ORPHAN_MARKERS) AS is_orphan_marker,
        CASE WHEN t.owner_lc IN (SELECT marker FROM PARAM_ORPHAN_MARKERS) THEN NULL
             ELSE t.owner_lc END                                AS owner_norm
    FROM typed t
),
with_history AS (
    SELECT
        n.*,
        LAG(n.owner_norm) OVER (PARTITION BY n.report_id ORDER BY n.row_idx)   AS prev_owner,
        ROW_NUMBER() OVER (PARTITION BY n.report_id ORDER BY n.row_idx)        AS snapshot_seq
    FROM normalized n
),
cost_points AS (
    -- The CASE repeats the WHERE: Snowflake may evaluate the expression before filtering, and
    -- LN(0) or x / 0 would raise an error there.
    SELECT row_idx, LN(CASE WHEN views > 0 AND aws_usd > 0 THEN aws_usd / views END) AS x
    FROM typed
    WHERE views > 0 AND aws_usd > 0
),
cost_center AS (
    SELECT MEDIAN(x) AS median_x FROM cost_points
),
cost_spread AS (
    SELECT MEDIAN(ABS(p.x - c.median_x)) AS mad_x
    FROM cost_points p CROSS JOIN cost_center c
),
cost_scores AS (
    SELECT p.row_idx, 0.6745 * (p.x - c.median_x) / NULLIF(s.mad_x, 0) AS aws_log_z
    FROM cost_points p CROSS JOIN cost_center c CROSS JOIN cost_spread s
)
SELECT
    h.row_idx,
    h.report_id,
    h.owner_norm,
    h.is_orphan_marker                                                          AS dq01,
    h.credits < 0                                                               AS dq02,
    h.load_sec > p.latency_warning_sec                                          AS dq03,
    (h.views < p.cost_low_views AND h.aws_usd > p.cost_high_aws_usd)
        OR COALESCE(ABS(z.aws_log_z) > p.cost_robust_z, FALSE)                  AS dq04,
    h.views = 0                                                                 AS dq05,
    h.concurrent_peak > h.views                                                 AS dq06,
    h.refresh_status = 'UNKNOWN'                                                AS dq07,
    h.refresh_status = 'SUCCESS' AND h.load_sec > p.latency_warning_sec         AS dq08,
    h.snapshot_seq > 1 AND h.prev_owner IS DISTINCT FROM h.owner_norm           AS dq09,
    h.views < p.cost_low_views AND h.aws_usd > p.cost_high_aws_usd              AS dq04_hard,
    COALESCE(ABS(z.aws_log_z) > p.cost_robust_z, FALSE)                         AS dq04_z,
    z.aws_log_z
FROM with_history h
LEFT JOIN cost_scores z ON z.row_idx = h.row_idx
CROSS JOIN PARAMS p;

CREATE OR REPLACE VIEW DQ_CHECKS AS
WITH sql_counts AS (
    SELECT 'DQ01' AS rule_id, COUNT_IF(dq01) AS sql_rows FROM DQ_ROW_CHECKS
    UNION ALL SELECT 'DQ02', COUNT_IF(dq02) FROM DQ_ROW_CHECKS
    UNION ALL SELECT 'DQ03', COUNT_IF(dq03) FROM DQ_ROW_CHECKS
    UNION ALL SELECT 'DQ04', COUNT_IF(dq04) FROM DQ_ROW_CHECKS
    UNION ALL SELECT 'DQ05', COUNT_IF(dq05) FROM DQ_ROW_CHECKS
    UNION ALL SELECT 'DQ06', COUNT_IF(dq06) FROM DQ_ROW_CHECKS
    UNION ALL SELECT 'DQ07', COUNT_IF(dq07) FROM DQ_ROW_CHECKS
    UNION ALL SELECT 'DQ08', COUNT_IF(dq08) FROM DQ_ROW_CHECKS
    UNION ALL SELECT 'DQ09', COUNT_IF(dq09) FROM DQ_ROW_CHECKS
)
SELECT
    s.rule_id,
    s.sql_rows::INTEGER                                              AS sql_rows,
    d.rows_affected                                                  AS ts_rows,
    CASE WHEN s.sql_rows = d.rows_affected THEN 'PASS' ELSE 'FAIL' END AS status
FROM sql_counts s
LEFT JOIN DQ_RESULTS d ON d.rule_id = s.rule_id
ORDER BY s.rule_id;
