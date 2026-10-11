-- =============================================================================
-- 08_reconciliation.sql
-- Purpose     : Prove the attribution adds up. One PASS/FAIL row per check; ingest fails and
--               the server refuses to start if any row is FAIL.
-- Inputs      : SNOWFLAKE.ACCOUNT_USAGE.WAREHOUSE_METERING_HISTORY, QUERY_HOUR_COST and
--               QUERY_ATTRIBUTED_COST (03), REPORT_ATTRIBUTION_DAILY and REPORT_ATTRIBUTION (04),
--               OWNER_CHARGEBACK and OWNER_CHARGEBACK_CURRENT (07), ANOMALY_ORPHANED_REPORTS and
--               ANOMALY_ZOMBIE_REPORTS (06), DQ_ROW_CHECKS (02), RAW_REPORT_SNAPSHOTS,
--               REPORT_SNAPSHOTS, REPORTS, REPORT_CURRENT_OWNER (01), PARAMS
-- Outputs     : VIEW RECONCILIATION
--                 check_id, check_kind, description,
--                 expected, actual, abs_diff = |actual − expected|,
--                 tolerance (PARAMS.recon_tolerance, in credits),
--                 status ('PASS' when abs_diff <= tolerance, else 'FAIL'; NULL counts as FAIL)
-- check_kind  :
--   CONSERVATION  Holds for any correct allocation over real Snowflake logs, whatever the
--                 workload: no credit is created, lost or double counted between metering,
--                 queries, reports (UNATTRIBUTED line included) and owners.
--   GROUND_TRUTH  Only possible because the simulator knows the answer. G1/G2: allocated
--                 credits ÷ (1 + simulated_overhead_rate) give back the CSV's credits_clean,
--                 which holds by construction (the simulator makes execution-time share equal
--                 credit share), so it validates this SQL, not the accuracy of time-based
--                 attribution on real workloads. G3/G4 are properties of the generated data
--                 (no queries for quarantined snapshots, every query tagged). On a real
--                 account there is no ground truth: drop the G rows and keep the C rows;
--                 untagged spend then shows up as the UNATTRIBUTED line.
--   CONSISTENCY   The 06 orphaned / zombie split agrees with an independent recomputation from
--                 the raw CSV text and the query log: K1 orphaned rows = DQ01 rows (override
--                 aware), K2 zombie rows = raw rows with views < cost_low_views, K3 Σ zombie
--                 savings = days_per_month × query credits on those snapshots' days,
--                 K4 orphaned rows that aren't zombies carry no savings (savings come only from
--                 zombies). They hold on real logs too.
-- Assumptions :
--   * Totals are around 1.4M credits; float sums agree to far better than 1e-6 there.
-- =============================================================================

CREATE OR REPLACE VIEW RECONCILIATION AS
WITH
metered AS (
    SELECT SUM(CREDITS_USED) AS credits
    FROM SNOWFLAKE.ACCOUNT_USAGE.WAREHOUSE_METERING_HISTORY
),
query_attributed AS (
    SELECT SUM(attributed_credits) AS credits FROM QUERY_ATTRIBUTED_COST
),
hourly_gap AS (
    SELECT MAX(ABS(m.CREDITS_USED - COALESCE(h.credits, 0))) AS max_gap
    FROM SNOWFLAKE.ACCOUNT_USAGE.WAREHOUSE_METERING_HISTORY m
    LEFT JOIN (
        SELECT WAREHOUSE_NAME, hour_start, SUM(attributed_credits) AS credits
        FROM QUERY_HOUR_COST
        GROUP BY WAREHOUSE_NAME, hour_start
    ) h ON h.WAREHOUSE_NAME = m.WAREHOUSE_NAME AND h.hour_start = m.START_TIME
),
-- Recomputed from 03, independently of 04's UNATTRIBUTED line (C3 is what covers that line).
unattributed AS (
    SELECT COALESCE(SUM(attributed_credits), 0) AS credits
    FROM QUERY_ATTRIBUTED_COST
    WHERE report_id IS NULL OR report_id NOT IN (SELECT report_id FROM REPORTS)
),
report_lines AS (
    SELECT SUM(attributed_credits) AS credits FROM REPORT_ATTRIBUTION
),
chargeback_point_in_time AS (
    SELECT SUM(attributed_credits) AS credits FROM OWNER_CHARGEBACK
),
chargeback_current AS (
    SELECT SUM(attributed_credits) AS credits FROM OWNER_CHARGEBACK_CURRENT
),
snapshot_recovery AS (
    SELECT MAX(ABS(COALESCE(d.attributed_credits, 0) / (1 + p.simulated_overhead_rate)
                   - s.credits_clean)) AS max_gap
    FROM REPORT_SNAPSHOTS s
    LEFT JOIN REPORT_ATTRIBUTION_DAILY d
      ON d.report_id = s.report_id AND d.usage_date = s.snapshot_date
    CROSS JOIN PARAMS p
    WHERE s.credits_clean IS NOT NULL
),
report_recovery AS (
    SELECT MAX(ABS(a.attributed_credits / (1 + p.simulated_overhead_rate) - c.credits)) AS max_gap
    FROM REPORT_ATTRIBUTION a
    JOIN (
        SELECT report_id, COALESCE(SUM(credits_clean), 0) AS credits
        FROM REPORT_SNAPSHOTS
        GROUP BY report_id
    ) c ON c.report_id = a.report_id
    CROSS JOIN PARAMS p
),
quarantined_queries AS (
    SELECT COALESCE(SUM(d.query_count), 0) AS n
    FROM REPORT_SNAPSHOTS s
    JOIN REPORT_ATTRIBUTION_DAILY d
      ON d.report_id = s.report_id AND d.usage_date = s.snapshot_date
    WHERE s.credits_clean IS NULL
),
-- K1–K4: the 06 split, recomputed without 05/06, over every snapshot.
orphaned_expected AS (
    SELECT COUNT_IF(CASE WHEN o.is_overridden THEN o.current_owner IS NULL ELSE d.dq01 END) AS n
    FROM DQ_ROW_CHECKS d
    JOIN REPORT_CURRENT_OWNER o ON o.report_id = d.report_id
),
orphaned_actual AS (
    SELECT COUNT(*) AS n FROM ANOMALY_ORPHANED_REPORTS
),
zombies_expected AS (
    SELECT COUNT(*) AS n
    FROM RAW_REPORT_SNAPSHOTS r CROSS JOIN PARAMS p
    WHERE CAST(r.monthly_active_views AS INTEGER) < p.cost_low_views
),
zombies_actual AS (
    SELECT COUNT(*) AS n,
           COALESCE(SUM(estimated_monthly_savings_credits), 0) AS savings_credits
    FROM ANOMALY_ZOMBIE_REPORTS
),
zombie_query_credits AS (
    SELECT COALESCE(SUM(q.attributed_credits), 0) * MAX(p.days_per_month) AS savings_credits
    FROM QUERY_ATTRIBUTED_COST q
    JOIN REPORT_SNAPSHOTS s ON s.report_id = q.report_id AND s.snapshot_date = q.usage_date
    CROSS JOIN PARAMS p
    WHERE s.monthly_active_views < p.cost_low_views
),
orphan_only_savings AS (
    SELECT COUNT(z.report_id) AS n
    FROM ANOMALY_ORPHANED_REPORTS r
    LEFT JOIN ANOMALY_ZOMBIE_REPORTS z
      ON z.report_id = r.report_id AND z.snapshot_idx = r.snapshot_idx
    WHERE NOT r.is_zombie
),
checks AS (
    SELECT 'C1_QUERIES_EQ_METERED' AS check_id, 'CONSERVATION' AS check_kind,
           'Σ credits attributed to queries = Σ metered warehouse credits' AS description,
           m.credits::DOUBLE AS expected, q.credits::DOUBLE AS actual
    FROM metered m CROSS JOIN query_attributed q
    UNION ALL
    SELECT 'C2_EACH_HOUR_EQ_METERED', 'CONSERVATION',
           'Largest |metered − attributed| over warehouse-hours (expected 0)',
           0, max_gap FROM hourly_gap
    UNION ALL
    SELECT 'C3_REPORTS_PLUS_UNATTRIBUTED_EQ_QUERIES', 'CONSERVATION',
           'Σ REPORT_ATTRIBUTION (reports + UNATTRIBUTED line) = Σ query-attributed credits',
           q.credits, r.credits
    FROM query_attributed q CROSS JOIN report_lines r
    UNION ALL
    SELECT 'C4_CHARGEBACK_POINT_IN_TIME_EQ_QUERIES', 'CONSERVATION',
           'Σ OWNER_CHARGEBACK (snapshot owners + UNOWNED + UNATTRIBUTED) = Σ query-attributed credits',
           q.credits, c.credits
    FROM query_attributed q CROSS JOIN chargeback_point_in_time c
    UNION ALL
    SELECT 'C5_CHARGEBACK_CURRENT_EQ_QUERIES', 'CONSERVATION',
           'Σ OWNER_CHARGEBACK_CURRENT (current owners + UNOWNED + UNATTRIBUTED) = Σ query-attributed credits',
           q.credits, c.credits
    FROM query_attributed q CROSS JOIN chargeback_current c
    UNION ALL
    SELECT 'G1_SNAPSHOT_RECOVERS_CREDITS_CLEAN', 'GROUND_TRUTH',
           'Largest |attributed ÷ (1 + overhead rate) − credits_clean| over report snapshots (expected 0)',
           0, max_gap FROM snapshot_recovery
    UNION ALL
    SELECT 'G2_REPORT_RECOVERS_CREDITS_CLEAN', 'GROUND_TRUTH',
           'Largest |attributed ÷ (1 + overhead rate) − Σ credits_clean| over reports (expected 0)',
           0, max_gap FROM report_recovery
    UNION ALL
    SELECT 'G3_QUARANTINED_HAVE_NO_QUERIES', 'GROUND_TRUTH',
           'Queries on snapshots whose credits were quarantined (DQ02) (expected 0)',
           0, n FROM quarantined_queries
    UNION ALL
    SELECT 'G4_ALL_QUERIES_TAGGED', 'GROUND_TRUTH',
           'Credits on untagged or unknown-report queries (expected 0: the simulator tags every query)',
           0, credits FROM unattributed
    UNION ALL
    SELECT 'K1_ORPHANED_EQ_DQ01', 'CONSISTENCY',
           'ANOMALY_ORPHANED_REPORTS rows = DQ01 rows from the raw CSV (an override wins)',
           e.n, a.n FROM orphaned_expected e CROSS JOIN orphaned_actual a
    UNION ALL
    SELECT 'K2_ZOMBIES_EQ_LOW_VIEWS', 'CONSISTENCY',
           'ANOMALY_ZOMBIE_REPORTS rows = raw rows with views < cost_low_views',
           e.n, a.n FROM zombies_expected e CROSS JOIN zombies_actual a
    UNION ALL
    SELECT 'K3_SAVINGS_EQ_ZOMBIE_QUERY_CREDITS', 'CONSISTENCY',
           'Σ zombie estimated savings (credits) = days_per_month × Σ query credits on zombie snapshots',
           e.savings_credits, a.savings_credits
    FROM zombie_query_credits e CROSS JOIN zombies_actual a
    UNION ALL
    SELECT 'K4_ORPHAN_ONLY_HAS_NO_SAVINGS', 'CONSISTENCY',
           'Orphaned, non-zombie snapshots that appear in the savings view (expected 0)',
           0, n FROM orphan_only_savings
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
