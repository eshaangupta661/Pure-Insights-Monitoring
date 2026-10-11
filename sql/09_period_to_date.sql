-- =============================================================================
-- 09_period_to_date.sql
-- Purpose     : Period-to-date KPIs: everything from snapshot 0 up to and including snapshot N
--               (the replay's current snapshot), for every N, over the whole portfolio and per
--               current owner. The API picks the row for the replay's N and the caller's scope.
-- Inputs      : REPORT_SNAPSHOTS, UNIT_ECONOMICS_SNAPSHOT (05), REPORT_ATTRIBUTION (04),
--               REPORT_CURRENT_OWNER (01), ANOMALY_ORPHANED_REPORTS (06), PARAMS
-- Outputs     : VIEW PERIOD_SNAPSHOT_ROWS (one row per period end N × report snapshot with
--               snapshot_idx <= N)
--                 period_end_idx, report_id, snapshot_idx, current_owner, refresh_status,
--                 load_time_sec, is_orphaned_at_snapshot, attributed_credits, snowflake_cost_usd
--               VIEW PERIOD_TO_DATE (one row per period end N × scope)
--                 period_end_idx, scope_kind ('ALL' = every report | 'OWNER' = one row per
--                 current owner, NULL = no current owner), current_owner,
--                 from_date, to_date            first and last snapshot date in the period
--                 snapshot_count                N + 1
--                 report_count, refresh_count   reports, and report snapshots (one refresh each)
--                 success_count, failed_count, timed_out_count, unknown_count
--                 refresh_success_rate          success_count / refresh_count (UNKNOWN counts as
--                                               not successful, as on the Today view)
--                 ever_orphaned_count           reports with no owner at one or more snapshots
--                 snowflake_credits_to_date, snowflake_cost_to_date_usd
--                                               attributed Snowflake spend over the period's days
--                 quarantined_snapshot_count    snapshots whose credits are unknown (DQ02)
--                 avg_load_time_sec, p95_load_time_sec   over every report snapshot in the period
--               VIEW PERIOD_TO_DATE_CHECKS (same columns as RECONCILIATION in 08; any FAIL
--               stops ingest and startup)
-- Assumptions :
--   * "Period" is snapshots 0..N of the replay. Every snapshot is one day, so the period is
--     N + 1 days and Snowflake cost to date is the sum of the daily attributed cost.
--   * AWS hosting is not in cost to date: it is a monthly bill (05), and summing it over daily
--     snapshots would count the same bill once per day.
--   * Quarantined snapshots (DQ02) have unknown Snowflake cost; they add nothing to cost to date
--     and are counted in quarantined_snapshot_count instead (never treated as 0 cost silently).
--   * Owner at a snapshot: the OWNER_OVERRIDES row when one exists (it wins at every snapshot,
--     even when NULL), else that snapshot's owner_email. The same rule as 06's orphaned view.
--   * Rows are grouped by the report's current owner (REPORT_CURRENT_OWNER), the same owner the
--     API scopes on, so an owner's rows always add up to the portfolio row.
--   * p95 is PERCENTILE_CONT(0.95), linear interpolation between ranks.
-- =============================================================================

CREATE OR REPLACE VIEW PERIOD_SNAPSHOT_ROWS AS
WITH period_ends AS (
    SELECT DISTINCT snapshot_idx AS period_end_idx FROM REPORT_SNAPSHOTS
)
SELECT
    e.period_end_idx,
    s.report_id,
    s.snapshot_idx,
    s.snapshot_date,
    o.current_owner,
    s.last_refresh_status                                                   AS refresh_status,
    s.avg_load_time_sec                                                     AS load_time_sec,
    CASE WHEN o.is_overridden THEN o.current_owner ELSE s.owner_email END IS NULL
                                                                            AS is_orphaned_at_snapshot,
    u.attributed_credits,
    u.snowflake_cost_usd
FROM period_ends e
JOIN REPORT_SNAPSHOTS s ON s.snapshot_idx <= e.period_end_idx
JOIN REPORT_CURRENT_OWNER o ON o.report_id = s.report_id
JOIN UNIT_ECONOMICS_SNAPSHOT u
  ON u.report_id = s.report_id AND u.snapshot_idx = s.snapshot_idx;

CREATE OR REPLACE VIEW PERIOD_TO_DATE AS
SELECT
    r.period_end_idx,
    CASE WHEN GROUPING(r.current_owner) = 1 THEN 'ALL' ELSE 'OWNER' END   AS scope_kind,
    r.current_owner,
    MIN(r.snapshot_date)                                                   AS from_date,
    MAX(r.snapshot_date)                                                   AS to_date,
    (r.period_end_idx + 1)::INTEGER                                        AS snapshot_count,
    COUNT(DISTINCT r.report_id)::INTEGER                                   AS report_count,
    COUNT(*)::INTEGER                                                      AS refresh_count,
    COUNT_IF(r.refresh_status = 'SUCCESS')::INTEGER                        AS success_count,
    COUNT_IF(r.refresh_status = 'FAILED')::INTEGER                         AS failed_count,
    COUNT_IF(r.refresh_status = 'TIMED_OUT')::INTEGER                      AS timed_out_count,
    COUNT_IF(r.refresh_status = 'UNKNOWN')::INTEGER                        AS unknown_count,
    COUNT_IF(r.refresh_status = 'SUCCESS')::DOUBLE / NULLIF(COUNT(*), 0)   AS refresh_success_rate,
    COUNT(DISTINCT CASE WHEN r.is_orphaned_at_snapshot THEN r.report_id END)::INTEGER
                                                                           AS ever_orphaned_count,
    COALESCE(SUM(r.attributed_credits), 0)                                 AS snowflake_credits_to_date,
    COALESCE(SUM(r.snowflake_cost_usd), 0)                                 AS snowflake_cost_to_date_usd,
    COUNT_IF(r.attributed_credits IS NULL)::INTEGER                        AS quarantined_snapshot_count,
    AVG(r.load_time_sec)                                                   AS avg_load_time_sec,
    PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY r.load_time_sec)          AS p95_load_time_sec
FROM PERIOD_SNAPSHOT_ROWS r
GROUP BY GROUPING SETS ((r.period_end_idx), (r.period_end_idx, r.current_owner));

CREATE OR REPLACE VIEW PERIOD_TO_DATE_CHECKS AS
WITH
portfolio AS (
    SELECT * FROM PERIOD_TO_DATE WHERE scope_kind = 'ALL'
),
owners AS (
    SELECT
        period_end_idx,
        SUM(snowflake_credits_to_date) AS credits,
        SUM(refresh_count)             AS refreshes,
        SUM(failed_count + timed_out_count) AS failing,
        SUM(report_count)              AS reports
    FROM PERIOD_TO_DATE
    WHERE scope_kind = 'OWNER'
    GROUP BY period_end_idx
),
last_period AS (
    SELECT * FROM portfolio WHERE period_end_idx = (SELECT MAX(period_end_idx) FROM portfolio)
),
monotone AS (
    SELECT
        period_end_idx,
        snowflake_credits_to_date - LAG(snowflake_credits_to_date)
            OVER (ORDER BY period_end_idx)                       AS credits_step,
        refresh_count - LAG(refresh_count) OVER (ORDER BY period_end_idx)          AS refresh_step,
        ever_orphaned_count - LAG(ever_orphaned_count) OVER (ORDER BY period_end_idx) AS orphan_step
    FROM portfolio
),
checks AS (
    SELECT 'P1_LAST_PERIOD_CREDITS_EQ_ATTRIBUTED' AS check_id, 'CONSISTENCY' AS check_kind,
           'Credits to date at the last snapshot = Σ REPORT_ATTRIBUTION over reports (04)' AS description,
           (SELECT SUM(attributed_credits) FROM REPORT_ATTRIBUTION
             WHERE report_id IN (SELECT report_id FROM REPORTS))::DOUBLE AS expected,
           l.snowflake_credits_to_date::DOUBLE AS actual
    FROM last_period l
    UNION ALL
    SELECT 'P2_OWNER_ROWS_SUM_TO_PORTFOLIO', 'CONSISTENCY',
           'Largest gap, over every N, between Σ owner rows and the portfolio row (credits, refreshes, failures, reports; expected 0)',
           0,
           MAX(GREATEST(ABS(o.credits - p.snowflake_credits_to_date),
                        ABS(o.refreshes - p.refresh_count),
                        ABS(o.failing - (p.failed_count + p.timed_out_count)),
                        ABS(o.reports - p.report_count)))
    FROM portfolio p JOIN owners o ON o.period_end_idx = p.period_end_idx
    UNION ALL
    SELECT 'P3_REFRESHES_EQ_REPORTS_TIMES_SNAPSHOTS', 'CONSISTENCY',
           'Largest |refresh_count − report_count × (N + 1)| over every N (expected 0)',
           0, MAX(ABS(refresh_count - report_count * snapshot_count))
    FROM portfolio
    UNION ALL
    SELECT 'P4_EVER_ORPHANED_EQ_ORPHANED_VIEW', 'CONSISTENCY',
           'Reports ever orphaned at the last snapshot = distinct reports in ANOMALY_ORPHANED_REPORTS (06)',
           (SELECT COUNT(DISTINCT report_id) FROM ANOMALY_ORPHANED_REPORTS),
           l.ever_orphaned_count
    FROM last_period l
    UNION ALL
    SELECT 'P5_TO_DATE_NEVER_DECREASES', 'CONSISTENCY',
           'Periods where credits, refreshes or ever-orphaned reports to date go down (expected 0)',
           0, COUNT_IF(credits_step < 0 OR refresh_step < 0 OR orphan_step < 0)
    FROM monotone
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
