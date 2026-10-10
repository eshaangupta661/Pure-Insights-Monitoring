-- =============================================================================
-- 01_schema.sql
-- Purpose     : DDL for every table. Executed by `npm run ingest` (after translation, see
--               README) and the reference for what each column means.
-- Inputs      : none
-- Outputs     : Portal tables (current database/schema):
--                 RAW_REPORT_SNAPSHOTS  the CSV exactly as written (all VARCHAR) + row_idx
--                 REPORT_SNAPSHOTS      typed, normalized rows + credits_clean + dq_flags
--                 QUARANTINE            pointers to rejected values (row_idx, rule, column, raw value)
--                 REPORTS               one row per report: current_owner, owner_history
--                 DQ_RESULTS            rows affected per DQ rule (from the TypeScript rules)
--               Usage tables (SNOWFLAKE.ACCOUNT_USAGE, simulated):
--                 QUERY_HISTORY, WAREHOUSE_METERING_HISTORY
-- Assumptions :
--   * In Snowflake, ACCOUNT_USAGE objects are read-only system views in the shared SNOWFLAKE
--     database; the DDL below recreates the subset of their columns this suite reads so the
--     simulation has the same shape. Snowflake publishes EXECUTION_TIME as NUMBER(38,0) and
--     CREDITS_USED* as NUMBER(38,9); they are declared BIGINT / DOUBLE here (both valid in
--     Snowflake) so reconciliation is not affected by 9-decimal rounding.
--   * _SIM_TRUE_CREDITS is simulation ground truth for tests only; no SQL file reads it.
--   * PRIMARY KEY is informational in Snowflake (not enforced); DuckDB enforces it.
-- =============================================================================

CREATE OR REPLACE TABLE RAW_REPORT_SNAPSHOTS (
    row_idx                     INTEGER NOT NULL,   -- 0-based CSV data row
    report_id                   VARCHAR,
    report_name                 VARCHAR,
    owner_email                 VARCHAR,
    last_refresh_status         VARCHAR,
    monthly_active_views        VARCHAR,
    snowflake_credits_consumed  VARCHAR,
    avg_load_time_sec           VARCHAR,
    aws_hosting_cost_usd        VARCHAR,
    query_count_last_30d        VARCHAR,
    concurrent_user_peak        VARCHAR
);

CREATE OR REPLACE TABLE REPORT_SNAPSHOTS (
    row_idx                     INTEGER NOT NULL,
    snapshot_idx                INTEGER NOT NULL,   -- floor(row_idx / 100)
    snapshot_date               DATE    NOT NULL,   -- 2026-09-21 + snapshot_idx days (assumption)
    report_id                   VARCHAR NOT NULL,
    report_name                 VARCHAR NOT NULL,
    owner_email                 VARCHAR,            -- trimmed, lowercased; NULL = orphaned (DQ01)
    last_refresh_status         VARCHAR NOT NULL,   -- SUCCESS | FAILED | TIMED_OUT | UNKNOWN
    monthly_active_views        INTEGER NOT NULL,
    snowflake_credits_consumed  DOUBLE  NOT NULL,   -- as reported, may be negative
    credits_clean               DOUBLE,             -- NULL when negative (DQ02); the only credits cost SQL reads
    avg_load_time_sec           DOUBLE  NOT NULL,
    aws_hosting_cost_usd        DOUBLE  NOT NULL,
    query_count_last_30d        INTEGER NOT NULL,
    concurrent_user_peak        INTEGER NOT NULL,
    dq_flags                    ARRAY   NOT NULL    -- of strings, e.g. ['ORPHANED', 'SLOW_LOAD']
);

CREATE OR REPLACE TABLE QUARANTINE (
    row_idx      INTEGER NOT NULL,
    report_id    VARCHAR NOT NULL,
    snapshot_idx INTEGER NOT NULL,
    rule_id      VARCHAR NOT NULL,
    column_name  VARCHAR NOT NULL,
    raw_value    VARCHAR NOT NULL,
    reason       VARCHAR NOT NULL
);

CREATE OR REPLACE TABLE REPORTS (
    report_id          VARCHAR PRIMARY KEY,
    report_name        VARCHAR NOT NULL,
    current_owner      VARCHAR,                     -- owner in the latest snapshot; NULL = orphaned
    is_orphaned        BOOLEAN NOT NULL,
    owner_history      ARRAY   NOT NULL,            -- of strings (NULL elements = orphaned), snapshot order
    owner_change_count INTEGER NOT NULL
);

CREATE OR REPLACE TABLE DQ_RESULTS (
    rule_id       VARCHAR PRIMARY KEY,
    rule_name     VARCHAR NOT NULL,
    severity      VARCHAR NOT NULL,
    rows_affected INTEGER NOT NULL,
    treatment     VARCHAR NOT NULL
);

CREATE SCHEMA IF NOT EXISTS SNOWFLAKE.ACCOUNT_USAGE;

CREATE OR REPLACE TABLE SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY (
    QUERY_ID          VARCHAR       NOT NULL,
    QUERY_TAG         VARCHAR       NOT NULL,   -- '{"report_id":"RPT_xxx"}', set by the portal per session
    WAREHOUSE_NAME    VARCHAR       NOT NULL,
    USER_NAME         VARCHAR       NOT NULL,
    ROLE_NAME         VARCHAR       NOT NULL,
    START_TIME        TIMESTAMP_LTZ NOT NULL,
    END_TIME          TIMESTAMP_LTZ NOT NULL,
    EXECUTION_TIME    BIGINT        NOT NULL,   -- milliseconds
    EXECUTION_STATUS  VARCHAR       NOT NULL,   -- SUCCESS | FAIL
    _SIM_TRUE_CREDITS DOUBLE                    -- simulation ground truth, tests only
);

CREATE OR REPLACE TABLE SNOWFLAKE.ACCOUNT_USAGE.WAREHOUSE_METERING_HISTORY (
    START_TIME                  TIMESTAMP_LTZ NOT NULL,   -- start of the hour
    END_TIME                    TIMESTAMP_LTZ NOT NULL,   -- START_TIME + 1 hour
    WAREHOUSE_NAME              VARCHAR       NOT NULL,
    CREDITS_USED                DOUBLE        NOT NULL,   -- compute + cloud services
    CREDITS_USED_COMPUTE        DOUBLE        NOT NULL,
    CREDITS_USED_CLOUD_SERVICES DOUBLE        NOT NULL
);
