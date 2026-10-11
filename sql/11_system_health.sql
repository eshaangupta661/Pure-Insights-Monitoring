-- =============================================================================
-- 11_system_health.sql
-- Purpose     : The three "system health" rates behind the Overview rings, for every replay
--               snapshot N and scope, on both Overview bases (Today = snapshot N, Period =
--               snapshots 0..N), each with the same rate at N - 1 so the API can show a change.
-- Inputs      : REPORT_SNAPSHOTS, REPORT_CURRENT_OWNER (01), PARAMS, PERIOD_TO_DATE (09)
-- Outputs     : VIEW SYSTEM_HEALTH (one row per snapshot N x scope)
--                 snapshot_idx, scope_kind ('ALL' | 'OWNER', NULL owner = no current owner),
--                 current_owner,
--                 today_total, today_success, today_fast, today_owned
--                                  report snapshots at N, and how many refreshed SUCCESS, loaded
--                                  within latency_warning_sec, and had an owner
--                 period_total, period_success, period_fast, period_owned    the same over 0..N
--                 {today|period}_{refresh|fast|owned}_rate     the matching count / total
--                 prev_{today|period}_{refresh|fast|owned}_rate    the rate at N - 1 (NULL at N = 0)
--               VIEW SYSTEM_HEALTH_CHECKS (same columns as RECONCILIATION in 08; any FAIL
--               stops ingest and startup)
-- Assumptions :
--   * "Within 15 s" means load time <= latency_warning_sec, the exact complement of the
--     "slow" count (DQ03: slow = load time > latency_warning_sec).
--   * Refresh success counts SUCCESS only; UNKNOWN is not a success (as in 09).
--   * Owned at a snapshot: the OWNER_OVERRIDES row when one exists (it wins, even when NULL),
--     else that snapshot's owner_email (the rule in 06 and 09).
--   * Rows are grouped by the report's current owner (REPORT_CURRENT_OWNER), the same owner the
--     API scopes on, so an owner's rows add up to the portfolio row.
--   * Period rates are pooled over report snapshots, not averages of daily rates.
-- =============================================================================

CREATE OR REPLACE VIEW SYSTEM_HEALTH AS
WITH daily AS (
    SELECT
        s.snapshot_idx,
        CASE WHEN GROUPING(o.current_owner) = 1 THEN 'ALL' ELSE 'OWNER' END AS scope_kind,
        o.current_owner,
        COUNT(*)::INTEGER                                                    AS total,
        COUNT_IF(s.last_refresh_status = 'SUCCESS')::INTEGER                 AS success,
        COUNT_IF(s.avg_load_time_sec <= p.latency_warning_sec)::INTEGER      AS fast,
        COUNT_IF(CASE WHEN o.is_overridden THEN o.current_owner ELSE s.owner_email END
                 IS NOT NULL)::INTEGER                                       AS owned
    FROM REPORT_SNAPSHOTS s
    JOIN REPORT_CURRENT_OWNER o ON o.report_id = s.report_id
    CROSS JOIN PARAMS p
    GROUP BY GROUPING SETS ((s.snapshot_idx), (s.snapshot_idx, o.current_owner))
),
cumulative AS (
    SELECT
        d.*,
        SUM(total)   OVER w AS period_total,
        SUM(success) OVER w AS period_success,
        SUM(fast)    OVER w AS period_fast,
        SUM(owned)   OVER w AS period_owned
    FROM daily d
    WINDOW w AS (PARTITION BY scope_kind, current_owner ORDER BY snapshot_idx)
),
rates AS (
    SELECT
        snapshot_idx, scope_kind, current_owner,
        total AS today_total, success AS today_success, fast AS today_fast, owned AS today_owned,
        period_total::INTEGER AS period_total, period_success::INTEGER AS period_success,
        period_fast::INTEGER AS period_fast, period_owned::INTEGER AS period_owned,
        success::DOUBLE / NULLIF(total, 0)                  AS today_refresh_rate,
        fast::DOUBLE / NULLIF(total, 0)                     AS today_fast_rate,
        owned::DOUBLE / NULLIF(total, 0)                    AS today_owned_rate,
        period_success::DOUBLE / NULLIF(period_total, 0)    AS period_refresh_rate,
        period_fast::DOUBLE / NULLIF(period_total, 0)       AS period_fast_rate,
        period_owned::DOUBLE / NULLIF(period_total, 0)      AS period_owned_rate
    FROM cumulative
)
SELECT
    r.*,
    LAG(today_refresh_rate)  OVER w AS prev_today_refresh_rate,
    LAG(today_fast_rate)     OVER w AS prev_today_fast_rate,
    LAG(today_owned_rate)    OVER w AS prev_today_owned_rate,
    LAG(period_refresh_rate) OVER w AS prev_period_refresh_rate,
    LAG(period_fast_rate)    OVER w AS prev_period_fast_rate,
    LAG(period_owned_rate)   OVER w AS prev_period_owned_rate
FROM rates r
WINDOW w AS (PARTITION BY scope_kind, current_owner ORDER BY snapshot_idx);

CREATE OR REPLACE VIEW SYSTEM_HEALTH_CHECKS AS
WITH
portfolio AS (
    SELECT * FROM SYSTEM_HEALTH WHERE scope_kind = 'ALL'
),
owners AS (
    SELECT
        snapshot_idx,
        SUM(today_total) AS t_total, SUM(today_success) AS t_success,
        SUM(today_fast) AS t_fast, SUM(today_owned) AS t_owned,
        SUM(period_total) AS p_total, SUM(period_success) AS p_success,
        SUM(period_fast) AS p_fast, SUM(period_owned) AS p_owned
    FROM SYSTEM_HEALTH
    WHERE scope_kind = 'OWNER'
    GROUP BY snapshot_idx
),
checks AS (
    SELECT 'H1_PERIOD_SUCCESS_EQ_PERIOD_TO_DATE' AS check_id, 'CONSISTENCY' AS check_kind,
           'Largest gap, over every N, between period_success and PERIOD_TO_DATE.success_count (09; expected 0)' AS description,
           0::DOUBLE AS expected,
           MAX(ABS(h.period_success - t.success_count))::DOUBLE AS actual
    FROM portfolio h
    JOIN PERIOD_TO_DATE t
      ON t.period_end_idx = h.snapshot_idx AND t.scope_kind = 'ALL'
    UNION ALL
    SELECT 'H2_OWNER_ROWS_SUM_TO_PORTFOLIO', 'CONSISTENCY',
           'Largest gap, over every N, between the sum of owner rows and the portfolio row (all eight counts; expected 0)',
           0,
           MAX(GREATEST(ABS(o.t_total - p.today_total), ABS(o.t_success - p.today_success),
                        ABS(o.t_fast - p.today_fast), ABS(o.t_owned - p.today_owned),
                        ABS(o.p_total - p.period_total), ABS(o.p_success - p.period_success),
                        ABS(o.p_fast - p.period_fast), ABS(o.p_owned - p.period_owned)))
    FROM portfolio p JOIN owners o ON o.snapshot_idx = p.snapshot_idx
    UNION ALL
    SELECT 'H3_RATES_WITHIN_ZERO_AND_ONE', 'CONSISTENCY',
           'Portfolio rates outside [0, 1] over every N and basis (expected 0)',
           0,
           COUNT_IF(LEAST(today_refresh_rate, today_fast_rate, today_owned_rate,
                          period_refresh_rate, period_fast_rate, period_owned_rate) < 0
                 OR GREATEST(today_refresh_rate, today_fast_rate, today_owned_rate,
                             period_refresh_rate, period_fast_rate, period_owned_rate) > 1)
    FROM portfolio
    UNION ALL
    SELECT 'H4_SLOW_PLUS_FAST_EQ_TOTAL', 'CONSISTENCY',
           'Report snapshots over latency_warning_sec plus today_fast = today_total at the last snapshot',
           l.today_total::DOUBLE,
           (l.today_fast + (SELECT COUNT_IF(s.avg_load_time_sec > p.latency_warning_sec)
                            FROM REPORT_SNAPSHOTS s CROSS JOIN PARAMS p
                            WHERE s.snapshot_idx = l.snapshot_idx))::DOUBLE
    FROM portfolio l
    WHERE l.snapshot_idx = (SELECT MAX(snapshot_idx) FROM portfolio)
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
