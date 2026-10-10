-- =============================================================================
-- 03_query_level_cost.sql
-- Purpose     : Allocate each warehouse-hour's metered credits to the queries that ran in that
--               hour, in proportion to their execution time. This is the core of attribution:
--               Snowflake bills warehouses by the hour, not queries, so per-query cost has to
--               be derived from metering.
-- Inputs      : SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY, SNOWFLAKE.ACCOUNT_USAGE.WAREHOUSE_METERING_HISTORY,
--               PARAMS
-- Outputs     : TABLE QUERY_HOUR_COST (one row per query × metered hour it overlaps)
--                 QUERY_ID, WAREHOUSE_NAME, hour_start, hour_metered_credits,
--                 exec_ms_in_hour     execution ms that fall inside this hour
--                 hour_exec_ms        Σ exec_ms_in_hour over all queries in the warehouse-hour
--                 attributed_credits  hour_metered_credits × exec_ms_in_hour / hour_exec_ms
--               TABLE QUERY_ATTRIBUTED_COST (one row per query)
--                 QUERY_ID, report_id (from QUERY_TAG; NULL if untagged), WAREHOUSE_NAME,
--                 START_TIME, usage_date (START_TIME::DATE), EXECUTION_TIME, EXECUTION_STATUS,
--                 attributed_credits, attributed_cost_usd
-- Assumptions :
--   * Materialized as tables (CREATE OR REPLACE TABLE ... AS, still idempotent), unlike the
--     views in 02 and 04–08. Every downstream file reads query-level cost, and as a view the range
--     join below would be re-derived inside each of them; 08 alone would inline it many times
--     and exceed the 256 MB DuckDB memory limit. On Snowflake this layer would be a scheduled
--     task or dynamic table refreshed from ACCOUNT_USAGE.
--   * QUERY_HOUR_COST and QUERY_ATTRIBUTED_COST are rebuilt from scratch on every
--     `npm run ingest` (the runner re-runs this file before 04–08), so they always reflect the
--     current ACCOUNT_USAGE tables. Server startup never rebuilds them.
--   * A query that spans an hour boundary is split by overlap:
--       exec_ms_in_hour = EXECUTION_TIME × overlap(query, hour) / (END_TIME − START_TIME).
--     Using EXECUTION_TIME (not elapsed time) keeps queueing and compilation out of the share.
--   * Every metered credit, including the overhead above query usage, is spread over that
--     hour's queries by the same share. A metered hour with no queries would be left
--     unallocated; 08 would catch that as Σ attributed < Σ metered.
--   * CREDITS_USED is allocated. The simulation has no cloud-services credits; on a real account
--     allocate CREDITS_USED_COMPUTE and reconcile to the bill separately (see README).
--   * Failed queries are billed too, so EXECUTION_STATUS is not filtered.
--   * Requires session TIMEZONE = 'UTC' (ALTER SESSION SET TIMEZONE = 'UTC'). START_TIME is
--     TIMESTAMP_LTZ and Snowflake's default zone is America/Los_Angeles, under which queries
--     between 00:00 and 07:59 UTC would get the previous day's usage_date and the wrong snapshot.
--   * Arithmetic is cast to DOUBLE so Snowflake's NUMBER division scale rules can't round shares.
-- =============================================================================

CREATE OR REPLACE TABLE QUERY_HOUR_COST AS
WITH query_hour_overlap AS (
    SELECT
        q.QUERY_ID,
        q.WAREHOUSE_NAME,
        m.START_TIME   AS hour_start,
        m.CREDITS_USED AS hour_metered_credits,
        q.EXECUTION_TIME::DOUBLE
            * DATEDIFF('millisecond', GREATEST(q.START_TIME, m.START_TIME), LEAST(q.END_TIME, m.END_TIME))
            / NULLIF(DATEDIFF('millisecond', q.START_TIME, q.END_TIME), 0) AS exec_ms_in_hour
    FROM SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY q
    JOIN SNOWFLAKE.ACCOUNT_USAGE.WAREHOUSE_METERING_HISTORY m
      ON m.WAREHOUSE_NAME = q.WAREHOUSE_NAME
     AND q.START_TIME < m.END_TIME
     AND q.END_TIME   > m.START_TIME
)
SELECT
    o.QUERY_ID,
    o.WAREHOUSE_NAME,
    o.hour_start,
    o.hour_metered_credits,
    o.exec_ms_in_hour,
    SUM(o.exec_ms_in_hour) OVER (PARTITION BY o.WAREHOUSE_NAME, o.hour_start) AS hour_exec_ms,
    o.hour_metered_credits * o.exec_ms_in_hour
        / NULLIF(SUM(o.exec_ms_in_hour) OVER (PARTITION BY o.WAREHOUSE_NAME, o.hour_start), 0)
                                                                              AS attributed_credits
FROM query_hour_overlap o;

CREATE OR REPLACE TABLE QUERY_ATTRIBUTED_COST AS
WITH per_query AS (
    SELECT QUERY_ID, SUM(attributed_credits) AS attributed_credits
    FROM QUERY_HOUR_COST
    GROUP BY QUERY_ID
)
SELECT
    q.QUERY_ID,
    TRY_PARSE_JSON(q.QUERY_TAG):report_id::STRING          AS report_id,
    q.WAREHOUSE_NAME,
    q.START_TIME,
    q.START_TIME::DATE                                     AS usage_date,
    q.EXECUTION_TIME,
    q.EXECUTION_STATUS,
    COALESCE(c.attributed_credits, 0)                      AS attributed_credits,
    COALESCE(c.attributed_credits, 0) * p.credit_price_usd AS attributed_cost_usd
FROM SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY q
LEFT JOIN per_query c ON c.QUERY_ID = q.QUERY_ID
CROSS JOIN PARAMS p;
