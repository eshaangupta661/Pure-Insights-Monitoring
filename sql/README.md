# Snowflake cost attribution suite

Snowflake-dialect SQL that turns hourly warehouse metering into cost per query, per report and per
owner. It then proves the numbers add up. The files run unchanged against Snowflake ACCOUNT_USAGE,
and locally against DuckDB through four small, documented translations.

## Files and run order

| file                        | creates                                                                                                                                 | what it does                                                                                                                                                      |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `00_setup_parameters.sql`   | `PARAMS`, `PARAM_ORPHAN_MARKERS`                                                                                                        | every price, rate and threshold (mirrors `server/src/config.ts`)                                                                                                  |
| `01_schema.sql`             | all tables, `REPORT_CURRENT_OWNER`                                                                                                      | portal tables + `SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY` / `WAREHOUSE_METERING_HISTORY`; the effective owner                                                       |
| `02_data_quality.sql`       | `DQ_ROW_CHECKS`, `DQ_CHECKS`                                                                                                            | DQ01–DQ09 recomputed from the raw CSV text; compared with the TypeScript counts                                                                                   |
| `03_query_level_cost.sql`   | `QUERY_HOUR_COST`, `QUERY_ATTRIBUTED_COST`                                                                                              | each warehouse-hour's metered credits split across its queries by execution-time share                                                                            |
| `04_report_attribution.sql` | `REPORT_ATTRIBUTION_DAILY`, `REPORT_ATTRIBUTION`                                                                                        | roll-up via `QUERY_TAG`: credits, active/overhead split, $ cost, share; plus an `UNATTRIBUTED` line                                                               |
| `05_unit_economics.sql`     | `UNIT_ECONOMICS_SNAPSHOT`, `UNIT_ECONOMICS_REPORT`                                                                                      | cost per active view, Snowflake-only and fully loaded (+ AWS)                                                                                                     |
| `06_anomalies.sql`          | `ANOMALY_COST_PER_VIEW`, `ANOMALY_ORPHANED_REPORTS`, `ANOMALY_ZOMBIE_REPORTS`, `ANOMALY_AWS_VIEWS_MISMATCH`, `ANOMALY_NEGATIVE_CREDITS` | outliers, orphaned reports (reassign), zombie reports (retire, with savings), AWS-vs-views mismatch, negative-credit quarantine                                   |
| `07_owner_chargeback.sql`   | `OWNER_CHARGEBACK`, `OWNER_CHARGEBACK_CURRENT`                                                                                          | cost per owner: point-in-time (snapshot owner) and current owner, each with `UNOWNED` and `UNATTRIBUTED` lines                                                    |
| `08_reconciliation.sql`     | `RECONCILIATION`                                                                                                                        | PASS/FAIL checks; any FAIL stops the build and the server                                                                                                         |
| `09_period_to_date.sql`     | `PERIOD_SNAPSHOT_ROWS`, `PERIOD_TO_DATE`, `PERIOD_TO_DATE_CHECKS`                                                                       | KPIs over snapshots 0..N for every N, portfolio and per current owner; checks P1–P5 (verified like 08)                                                            |
| `10_cost_projection.sql`    | `COST_DAILY_SERIES`, `COST_PROJECTION_FIT`, `COST_PROJECTION`, `COST_PROJECTION_CHECKS`                                                 | Daily Snowflake cost per scope; linear trend (REGR_SLOPE/REGR_INTERCEPT) over 0..N, forecast N+1..last with ±1.96σ band, month-end projection, MAPE; checks F1–F4 |
| `11_system_health.sql`      | `SYSTEM_HEALTH`, `SYSTEM_HEALTH_CHECKS` | Refresh-success, within-15 s and ownership-coverage rates for Today (N) and Period (0..N) with the N-1 rate, portfolio and per current owner; checks H1-H4 |

Every file starts with a header covering purpose, inputs, output columns and assumptions.

`npm run ingest` runs 00 and 01, loads the CSV, generates the ACCOUNT_USAGE data, and then runs
02–10. Every statement in 02–10 is `CREATE OR REPLACE`, so re-running is idempotent, and later
files build on earlier ones. 02 and 04–09 create views. 09 has its own check view,
`PERIOD_TO_DATE_CHECKS` (P1–P5, same columns as `RECONCILIATION`), which ingest and startup
verify like 08's: any FAIL stops both. 10 does the same with `COST_PROJECTION_CHECKS` (F1–F4); 11 does the same with `SYSTEM_HEALTH_CHECKS` (H1–H4).
03 materializes query-level cost as two
**tables**. Every downstream file reads that layer, and as a view its range join (83k queries
against hourly metering) would be re-derived inside each of them. Inlined like that, 08 alone
exceeded the 256 MB DuckDB memory limit. Materialized, the whole suite runs in about 1.2 s. On
Snowflake this layer would be a scheduled task or dynamic table over ACCOUNT_USAGE.
`QUERY_HOUR_COST` and `QUERY_ATTRIBUTED_COST` are **rebuilt from scratch on every ingest**,
because the runner re-runs 03 before 04–08. They therefore never lag the ACCOUNT_USAGE tables
they come from.

At the end of ingest, the runner stores the cached results in schema `SQL_RESULTS`, together with
a `SUITE_FINGERPRINT`. That is a sha256 over every /sql file (as executed) and every PARAMS value.
Server startup does not re-run the suite. It recomputes the fingerprint from the current files
and `config.ts`, and exits 1 if the fingerprint doesn't match ("re-run `npm run ingest`").
Otherwise it loads the stored results and asserts that every stored check is PASS.

Naming: Snowflake system columns are UPPER (as in Snowflake's docs). Tables and views are UPPER.
Columns we define are `lower_snake`. Money is never rounded in SQL; rounding happens only at
presentation.

## Ownership and admin overrides

"Who owns this report now" is defined once, in the view `REPORT_CURRENT_OWNER` (01):

```
current_owner = OWNER_OVERRIDES.owner_email   if an override row exists (even when NULL)
              = REPORTS.current_owner         otherwise (the latest snapshot's owner, from ingest)
```

04–07 read `current_owner` from that view, never from `REPORTS`. An admin reassigns a report with
`PATCH /api/v1/reports/:id/owner`, which writes `OWNER_OVERRIDES` and `AUDIT_LOG` in one
transaction. Overrides only move cost between owners. Totals do not change, so C3–C5 hold with
or without them; the integration test applies an override and re-checks C5 on the live views.

The results stored in `SQL_RESULTS` are frozen at ingest, when `OWNER_OVERRIDES` is empty. The
API therefore never reads `current_owner` from them. It joins `REPORT_CURRENT_OWNER`, and reads
the row sets that depend on ownership (`OWNER_CHARGEBACK_CURRENT`, `ANOMALY_ORPHANED_REPORTS`,
`ANOMALY_ZOMBIE_REPORTS`)
from the live views. Re-running ingest rebuilds the warehouse and clears overrides and the audit
log.

## The attribution math

Snowflake bills **warehouses by the hour**, not queries. Per-query cost is therefore derived:

```
exec_ms_in_hour(q, h) = EXECUTION_TIME(q) × overlap(q, h) / (END_TIME(q) − START_TIME(q))
attributed(q, h)      = CREDITS_USED(h) × exec_ms_in_hour(q, h) / Σ_q' exec_ms_in_hour(q', h)
attributed(q)         = Σ_h attributed(q, h)
attributed(report)    = Σ attributed(q) over queries whose QUERY_TAG names the report
attributed(UNATTRIBUTED) = Σ attributed(q) over queries with a missing, invalid or unknown tag
```

Untagged spend is shown, never dropped. `REPORT_ATTRIBUTION` and both chargeback views always
carry an `UNATTRIBUTED` line, so on any account they sum to the total. It is 0 here because the
simulator tags every query; on a real account it holds ad hoc and analyst usage.

A query that crosses an hour boundary is split by overlap. That happens with long queries; in
the simulation, 657 of 83,003 queries do it. Every metered credit is spread across the hour's
queries, including the part above what the queries themselves used, so the shares in each hour
sum to 1. Failed queries are billed, so `EXECUTION_STATUS` is not filtered.

### How the simulated data is built (`server/src/ingest/snowflake-sim.ts`)

- Each (report, snapshot) with non-null `credits_clean` becomes `max(1, round(query_count_last_30d / 300))`
  queries. All of them are tagged `{"report_id":"RPT_xxx"}` and run as one service user. That is
  why the tag, not `USER_NAME`, is the link to a report.
- A report always runs on `WAREHOUSES[fnv1a32(report_id) % 3]`.
- `MS_PER_CREDIT` is XS 3600, Small (`ADHOC_WH`) 1800, M 900. These are Snowflake's 1:2:4 size
  ratios at 1/1000 time scale: real XS bills 1 credit per hour, which is 3,600,000 ms per credit. The
  CSV's credit totals are far larger than three small warehouses could burn in a day, so treat
  the timing as a compression, not physics.
- `credits_clean` has at most 2 decimals and every `MS_PER_CREDIT` is a multiple of 100. So
  `credits_clean × MS_PER_CREDIT` is a whole number of milliseconds. It is split into integer
  per-query execution times with seeded lognormal weights. Σ EXECUTION_TIME equals
  `credits_clean × MS_PER_CREDIT` **exactly**.
- `END_TIME = START_TIME + EXECUTION_TIME`. Start times follow a business-day curve over the
  snapshot's UTC day.
- `CREDITS_USED(warehouse, hour) = Σ exec ms in the hour / MS_PER_CREDIT × (1 + SIMULATED_OVERHEAD_RATE)`.

`SIMULATED_OVERHEAD_RATE` (0.15) is a **synthetic proportional overhead, not measured idle time**.
It exists only so that metered credits exceed query usage, as they do on a real bill. The
`active_credits` / `overhead_credits` columns in `REPORT_ATTRIBUTION` decompose attributed
credits under that assumed rate. They are not a measurement.

### What the reconciliation proves, and what it doesn't

`RECONCILIATION.check_kind` separates three kinds of evidence:

| kind             | checks                                                                                                                                                                                                                                                            | meaning                                                                                                                                                                |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **CONSERVATION** | C1 queries = metered · C2 every warehouse-hour = metered · C3 reports + `UNATTRIBUTED` = queries · C4 point-in-time chargeback (owners + `UNOWNED` + `UNATTRIBUTED`) = queries · C5 current-owner chargeback (same) = queries                                     | Holds for any correct allocation over **real** Snowflake logs, whatever the workload: no credit is created, lost or double counted on the way from metering to owners. |
| **GROUND_TRUTH** | G1 per (report, snapshot) and G2 per report: attributed ÷ (1 + rate) = `credits_clean` · G3 quarantined snapshots have no queries · G4 every query is tagged (unattributed = 0)                                                                                   | Possible only because the simulator knows the answer, or properties of the data it generated.                                                                          |
| **CONSISTENCY**  | K1 orphaned rows = DQ01 rows from the raw CSV (override aware) · K2 zombie rows = raw rows with views < `cost_low_views` · K3 Σ zombie savings = `days_per_month` × Σ query credits on those snapshots' days · K4 orphaned, non-zombie snapshots carry no savings | The 06 orphaned/zombie split agrees with an independent recomputation from the raw CSV text and the query log. Holds on real logs too.                                 |

G4 is deliberately not a conservation check: "no untagged queries" is a property of the
simulator, not of correct accounting. On a real account, analyst queries on a shared warehouse
carry no tag. That is fine as long as C3–C5 hold, with the spend on the `UNATTRIBUTED` line.

The GROUND_TRUTH recovery is exact **by construction**: one warehouse has one `MS_PER_CREDIT`, so
the simulator makes execution-time share equal credit share within every hour. Passing it shows
this SQL implements the allocation correctly (overlap splitting, hour partitioning, tag roll-up,
no double counting). It does **not** show that time-based attribution is accurate on real
workloads. There, concurrency, queueing, warehouse resizes and idle gaps make time share and
true resource share diverge, and only the CONSERVATION checks still apply.

Tolerance is `PARAMS.recon_tolerance` = 1e-6 credits. Observed gaps are around 6e-9 on
1.39M credits for totals and around 1e-12 per report.

## Snowflake → DuckDB translations

The files are Snowflake SQL. `server/src/sql/translate.ts` rewrites exactly these constructs, in
code only (comments and string literals are left alone):

| id                     | Snowflake                             | DuckDB                                                    | why                                                                                                                    |
| ---------------------- | ------------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `ACCOUNT_USAGE_SCHEMA` | `SNOWFLAKE.ACCOUNT_USAGE.<view>`      | `ACCOUNT_USAGE.<table>`                                   | DuckDB reads a 3-part name as catalog.schema.table; the simulation lives in a local `ACCOUNT_USAGE` schema             |
| `JSON_PATH`            | `TRY_PARSE_JSON(<col>):<key>::STRING` | `json_extract_string(TRY_CAST(<col> AS JSON), '$.<key>')` | no VARIANT `:` path syntax in DuckDB; `TRY_CAST(... AS JSON)` is NULL for empty or invalid tags, like `TRY_PARSE_JSON` |
| `TIMESTAMP_LTZ`        | `TIMESTAMP_LTZ`                       | `TIMESTAMP`                                               | no LTZ type in DuckDB; all simulated times are UTC                                                                     |
| `ARRAY_TYPE`           | `ARRAY` (column type)                 | `VARCHAR[]`                                               | DuckDB lists are typed; both ARRAY columns hold strings                                                                |

After translating, the translator **throws, naming the file**, if `PARSE_JSON`, `:report_id`,
`TIMESTAMP_LTZ` or `SNOWFLAKE.` remains in code. A new Snowflake-only construct therefore fails
loudly instead of half-working. The same guard rejects `FLOAT`, `FLOAT4` and `REAL`. DuckDB accepts
these but makes them 4-byte (Snowflake's `FLOAT` is 8-byte), so they would lose precision
silently instead of erroring. Use `DOUBLE`.

Where a construct runs on both engines, the files use that portable form instead of adding a
translation:

| instead of                      | the files use                   | because                                                                          |
| ------------------------------- | ------------------------------- | -------------------------------------------------------------------------------- |
| `FLOAT`                         | `DOUBLE`                        | `FLOAT` is 4-byte in DuckDB, which would break 1e-6 reconciliation (guarded)     |
| `NUMBER(38,0)` / `NUMBER(38,9)` | `BIGINT` / `DOUBLE`             | DuckDB has no `NUMBER`; DOUBLE also avoids 9-decimal rounding of metered credits |
| `IFF(c, a, b)`                  | `CASE WHEN c THEN a ELSE b END` | DuckDB has no `IFF`                                                              |
| `RATIO_TO_REPORT(x) OVER ()`    | `x / NULLIF(SUM(x) OVER (), 0)` | DuckDB has no `RATIO_TO_REPORT`                                                  |
| `DATEDIFF(millisecond, a, b)`   | `DATEDIFF('millisecond', a, b)` | DuckDB needs the part quoted; Snowflake accepts both                             |
| `SELECT … FROM VALUES (…)`      | `FROM (VALUES (…)) AS t(col)`   | valid in both                                                                    |

`COUNT_IF`, `MEDIAN`, `QUALIFY`, `DATE_TRUNC`, `LN`, `GREATEST`/`LEAST`, `IS DISTINCT FROM` and
`::` casts run on both engines unchanged.

## Assumptions

- **Credit price** is $3.00 per credit (`PARAMS.credit_price_usd`).
- **Snapshot dates:** snapshot `i` is the UTC day `2026-09-21 + i`. The CSV carries no dates.
- **Credit timing:** a snapshot's credits are spent during its own day. Queries are attributed
  to the day they start, even if they finish after midnight.
- **Session timezone must be UTC**, so `START_TIME::DATE` is the UTC usage date. On Snowflake,
  run `ALTER SESSION SET TIMEZONE = 'UTC'` first; see "In production".
- **Quarantined credits:** a snapshot quarantined by DQ02 has _unknown_ Snowflake cost (NULL,
  not 0), and no queries are simulated for it. The cost SQL (03–08) reads only `credits_clean`;
  06 reads quarantined values from `QUARANTINE.raw_value`.
- **Unit-cost period:** cost per view is on a 30-day basis. Monthly views cover 30 days, but a
  snapshot's Snowflake cost covers one day, so it is multiplied by `days_per_month` (30) first.
  `aws_hosting_cost_usd` is assumed to be a monthly bill (the CSV doesn't say) and is added as
  is. The same parameter turns a zombie's daily cost into monthly savings in 06.
- **Unit cost:** every division by views uses `NULLIF(views, 0)`, so a zero-view snapshot gets a
  NULL unit cost. Without it, DuckDB returns Infinity and Snowflake raises a division error.
  The `LN(...)` calls in 02 and 06 are also guarded with `CASE` inside the call, not only by the
  CTE's `WHERE`, because Snowflake does not promise to filter before evaluating expressions.
- **Orphaned vs. zombie:** two views, one row per report × snapshot (the API reads the replay's
  snapshot). _Orphaned_: no owner at that snapshot, whatever its usage (recommended action:
  reassign); the owner is the `OWNER_OVERRIDES` row when one exists, else that snapshot's
  `owner_email`. _Zombie_: views < `cost_low_views`, owned or not (action: retire). Only zombies
  carry estimated savings = the snapshot's attributed credits × `days_per_month` (30),
  priced at `credit_price_usd`; NULL when the credits were quarantined.
- **Two chargeback views:** point-in-time charges each snapshot to that snapshot's owner;
  current charges all history to today's owner. Reports change owners 7–13 times, so the two
  differ: the UNOWNED line is about 162k credits point-in-time vs. about 199k under current owner.

## In production

On a real account, you would point this suite at the real `SNOWFLAKE.ACCOUNT_USAGE` views:

- Run `ALTER SESSION SET TIMEZONE = 'UTC';` first. Snowflake defaults to `America/Los_Angeles`.
  Under that, `START_TIME::DATE` would shift queries between 00:00 and 07:59 UTC onto the
  previous day's snapshot, and only the per-snapshot views would be wrong; the totals would
  still reconcile.
- Skip the simulator and the DDL for those two views.
- Have the portal set `QUERY_TAG` per session.
- Filter the time range, because ACCOUNT_USAGE keeps a year of history.
- Allocate `CREDITS_USED_COMPUTE` per warehouse-hour, not `CREDITS_USED`. Cloud-services credits
  are billed only above 10% of daily compute, so treat them separately. Reconcile the total to
  `METERING_DAILY_HISTORY.CREDITS_BILLED`, which applies `CREDITS_ADJUSTMENT_CLOUD_SERVICES`.
  The simulation has no cloud-services credits, so the two columns are equal here.
- Join queries to metering on `WAREHOUSE_ID`, which both views carry. A warehouse that is
  renamed, or dropped and recreated, breaks a join on `WAREHOUSE_NAME`.
- Keep the CONSERVATION checks (C1–C5) and drop the GROUND_TRUTH ones (G1–G4), because there
  is no ground truth. Untagged usage then shows up on the `UNATTRIBUTED` line rather than
  failing a check.

Snowflake also ships a native per-query attribution view,
`SNOWFLAKE.ACCOUNT_USAGE.QUERY_ATTRIBUTION_HISTORY`. This suite is the transparent, manual
equivalent built on `WAREHOUSE_METERING_HISTORY`, where every step can be inspected and
reconciled. On real logs, a metered hour with no queries (a warehouse kept awake by
auto-suspend) would need an explicit unallocated line. Here, C1 would surface it as
Σ attributed < Σ metered.
