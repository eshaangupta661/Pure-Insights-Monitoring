-- =============================================================================
-- 07_owner_chargeback.sql
-- Purpose     : Who pays. Two views over the same costs, differing only in which owner a
--               snapshot's cost is charged to:
--                 OWNER_CHARGEBACK          point-in-time: each snapshot's cost goes to the
--                                           owner of that snapshot. Use for "who was
--                                           responsible when the money was spent" (invoicing
--                                           past periods).
--                 OWNER_CHARGEBACK_CURRENT  all of a report's history goes to its current owner.
--                                           Use for "who should act now" (cleanup, budgets).
--               With 7–13 owners per report over 20 snapshots, the two differ a lot.
-- Inputs      : UNIT_ECONOMICS_SNAPSHOT (05), REPORT_ATTRIBUTION (04), REPORT_CURRENT_OWNER (01)
-- Outputs     : Both views have one row per owner plus two lines that are always present:
--                 'UNOWNED'       reports whose owner is NULL (orphaned)
--                 'UNATTRIBUTED'  credits on untagged / unknown-report queries, from the
--                                 REPORT_ATTRIBUTION line of the same name (no reports, no AWS)
--               Columns:
--                 owner                 lowercase email, 'UNOWNED' or 'UNATTRIBUTED'
--                 report_count          distinct reports charged to the owner
--                 snapshot_count        report snapshots charged to the owner
--                 attributed_credits    metered credits; a quarantined snapshot (DQ02) has
--                                       unknown Snowflake cost and contributes no credits, but
--                                       it still counts in snapshot_count and its AWS cost is
--                                       included
--                 snowflake_cost_usd    attributed_credits × credit_price_usd
--                 aws_cost_usd          AWS hosting (known for every snapshot)
--                 total_cost_usd        snowflake_cost_usd + aws_cost_usd
--                 share_of_total_cost   total_cost_usd / Σ total_cost_usd
-- Assumptions :
--   * 'UNOWNED' and 'UNATTRIBUTED' cannot collide with a real owner: emails are stored lowercase.
--   * current_owner is REPORT_CURRENT_OWNER.current_owner: the latest snapshot's owner unless an
--     admin override exists. An override moves a report's whole history to the new owner here;
--     totals do not change, so C5 holds with or without overrides.
--   * Each view, UNATTRIBUTED included, sums to Σ query-attributed credits; 08 checks it.
-- =============================================================================

CREATE OR REPLACE VIEW OWNER_CHARGEBACK AS
WITH lines AS (
    SELECT
        COALESCE(u.owner_email, 'UNOWNED')          AS owner,
        u.report_id,
        COALESCE(u.attributed_credits, 0)           AS attributed_credits,
        COALESCE(u.snowflake_cost_usd, 0)           AS snowflake_cost_usd,
        u.aws_cost_usd
    FROM UNIT_ECONOMICS_SNAPSHOT u
    UNION ALL
    SELECT 'UNATTRIBUTED', NULL, a.attributed_credits, a.attributed_cost_usd, 0
    FROM REPORT_ATTRIBUTION a
    WHERE a.report_id = 'UNATTRIBUTED'
),
owners AS (
    SELECT owner FROM lines
    UNION
    SELECT 'UNOWNED'
),
per_owner AS (
    SELECT
        o.owner,
        COUNT(DISTINCT l.report_id)::INTEGER        AS report_count,
        COUNT(l.report_id)::INTEGER                 AS snapshot_count,
        COALESCE(SUM(l.attributed_credits), 0)      AS attributed_credits,
        COALESCE(SUM(l.snowflake_cost_usd), 0)      AS snowflake_cost_usd,
        COALESCE(SUM(l.aws_cost_usd), 0)            AS aws_cost_usd
    FROM owners o
    LEFT JOIN lines l ON l.owner = o.owner
    GROUP BY o.owner
)
SELECT
    owner,
    report_count,
    snapshot_count,
    attributed_credits,
    snowflake_cost_usd,
    aws_cost_usd,
    snowflake_cost_usd + aws_cost_usd                                          AS total_cost_usd,
    (snowflake_cost_usd + aws_cost_usd)
        / NULLIF(SUM(snowflake_cost_usd + aws_cost_usd) OVER (), 0)            AS share_of_total_cost
FROM per_owner
ORDER BY total_cost_usd DESC, owner;

CREATE OR REPLACE VIEW OWNER_CHARGEBACK_CURRENT AS
WITH lines AS (
    SELECT
        COALESCE(o.current_owner, 'UNOWNED')        AS owner,
        u.report_id,
        COALESCE(u.attributed_credits, 0)           AS attributed_credits,
        COALESCE(u.snowflake_cost_usd, 0)           AS snowflake_cost_usd,
        u.aws_cost_usd
    FROM UNIT_ECONOMICS_SNAPSHOT u
    JOIN REPORT_CURRENT_OWNER o ON o.report_id = u.report_id
    UNION ALL
    SELECT 'UNATTRIBUTED', NULL, a.attributed_credits, a.attributed_cost_usd, 0
    FROM REPORT_ATTRIBUTION a
    WHERE a.report_id = 'UNATTRIBUTED'
),
owners AS (
    SELECT owner FROM lines
    UNION
    SELECT 'UNOWNED'
),
per_owner AS (
    SELECT
        o.owner,
        COUNT(DISTINCT l.report_id)::INTEGER        AS report_count,
        COUNT(l.report_id)::INTEGER                 AS snapshot_count,
        COALESCE(SUM(l.attributed_credits), 0)      AS attributed_credits,
        COALESCE(SUM(l.snowflake_cost_usd), 0)      AS snowflake_cost_usd,
        COALESCE(SUM(l.aws_cost_usd), 0)            AS aws_cost_usd
    FROM owners o
    LEFT JOIN lines l ON l.owner = o.owner
    GROUP BY o.owner
)
SELECT
    owner,
    report_count,
    snapshot_count,
    attributed_credits,
    snowflake_cost_usd,
    aws_cost_usd,
    snowflake_cost_usd + aws_cost_usd                                          AS total_cost_usd,
    (snowflake_cost_usd + aws_cost_usd)
        / NULLIF(SUM(snowflake_cost_usd + aws_cost_usd) OVER (), 0)            AS share_of_total_cost
FROM per_owner
ORDER BY total_cost_usd DESC, owner;
