# Data quality

What is wrong with the source CSV, how each problem is detected, and what the system does about
it. Rules **flag rows, they never silently drop them**: `RAW_REPORT_SNAPSHOTS` keeps all 2,000
source rows untouched, and `REPORT_SNAPSHOTS` has the same 2,000 rows with a `dq_flags` list.

The counts below are the committed [`data/dq_summary.json`](../data/dq_summary.json), written by
`npm run ingest`. The app shows the same numbers on the Data Quality page and at
`GET /api/v1/data-quality` (see [API.md](API.md)).

| rule                                      | severity | rows | flag                     | treatment                                        |
| ----------------------------------------- | -------- | ---: | ------------------------ | ------------------------------------------------ |
| [DQ01](#dq01-orphaned-owner)              | high     |  245 | `ORPHANED`               | owner normalized to NULL                         |
| [DQ02](#dq02-negative-snowflake-credits)  | high     |   24 | `NEGATIVE_CREDITS`       | quarantined; `credits_clean` NULL                |
| [DQ03](#dq03-slow-load)                   | medium   | 1490 | `SLOW_LOAD`              | kept; drives latency alerts                      |
| [DQ04](#dq04-aws-cost-per-view-outlier)   | medium   |   30 | `COST_MISMATCH`          | kept; flagged                                    |
| [DQ05](#dq05-zero-monthly-views)          | medium   |    4 | `ZERO_VIEWS`             | kept; unit cost NULL                             |
| [DQ06](#dq06-impossible-concurrency)      | low      |   93 | `IMPOSSIBLE_CONCURRENCY` | kept; flagged                                    |
| [DQ07](#dq07-unknown-refresh-status)      | low      |  100 | `UNKNOWN_REFRESH`        | own status bucket; INFO alert                    |
| [DQ08](#dq08-slow-but-healthy)            | info     | 1004 | `SLOW_BUT_HEALTHY`       | kept; flagged                                    |
| [DQ09](#dq09-ownership-change-event)      | info     | 1782 | `OWNER_CHANGED`          | kept; `owner_history`; `current_owner` resolved  |

A row can carry several flags (for example all four zero-view rows are also DQ06). The rules are
named pure functions in [`server/src/ingest/rules.ts`](../server/src/ingest/rules.ts), each with
a unit test in `server/test/ingest/rules.test.ts`. Thresholds live only in
[`server/src/config.ts`](../server/src/config.ts).

## What the dataset is

- 2,000 rows = **100 reports × 20 snapshots**. 100 unique `report_id` (RPT_200 to RPT_299), each
  appearing 20 times. The file stacks snapshots in blocks of 100 rows, so row `i` belongs to
  snapshot `floor(i / 100)`. Ingest checks that every block holds the same 100 reports and fails
  otherwise.
- The CSV has no dates. **Assumption:** `snapshot_date = 2026-09-21 + snapshot_idx days`, one
  snapshot per UTC day, so the 20 snapshots span 2026-09-21 to 2026-10-10.
- Refresh status: SUCCESS 1336, FAILED 382, TIMED_OUT 182, UNKNOWN 100.
- Load time runs from 0.6 s to 55.0 s.

## DQ01: orphaned owner

- **Rule:** `owner_email` is `nan`, `ORPHANED_REPORT` or empty, after trimming, compared
  case-insensitively.
- **Count:** 245 rows (128 `nan` + 117 `ORPHANED_REPORT`). Severity high.
- **Treatment:** the owner is normalized to NULL and the row flagged `ORPHANED`. Real owner emails
  are trimmed and lowercased. Nothing else (`None`, `null`, `N/A`) is treated as a marker.
- **Why:** a report nobody owns is a governance problem and an unassigned cost. Normalizing to
  NULL gives one representation to filter on (`WHERE owner IS NULL`), instead of three spellings.
  The exact-match owner scoping in SQL and socket rooms also needs lowercased emails.
- **Downstream:** at the last snapshot (19), 14 reports have no owner. The cost suite reports
  them as `ANOMALY_ORPHANED_REPORTS` (action: reassign) and charges them to an `UNOWNED` line in
  both chargeback views.

## DQ02: negative Snowflake credits

- **Rule:** `snowflake_credits_consumed < 0`.
- **Count:** 24 rows, from -13.6 to -0.8. Severity high.
- **Treatment:** a pointer row is copied to `QUARANTINE`, `credits_clean` is set to NULL, and the
  snapshot is excluded from cost attribution.
- **Why:** credits are metered consumption and cannot be negative. The honest value is unknown,
  not zero. A NULL keeps the snapshot out of every sum instead of silently lowering a report's
  cost, and the Cost page shows it as quarantined.
- **No queries are simulated** for a quarantined snapshot (reconciliation check G3).

### QUARANTINE stores pointers, not rows

`QUARANTINE` has `row_idx`, `report_id`, `snapshot_idx`, `rule_id`, `column_name`, `raw_value`
and `reason`. It does not duplicate the row, because `RAW_REPORT_SNAPSHOTS` already keeps every
row exactly as read from the CSV. Join on `row_idx` for the full record:

```sql
SELECT q.reason, q.raw_value, r.*
FROM QUARANTINE q
JOIN RAW_REPORT_SNAPSHOTS r USING (row_idx);
```

## DQ03: slow load

- **Rule:** `avg_load_time_sec > 15`.
- **Count:** 1490 rows (74.5% of 2,000), of which 910 are above 30 s. Severity medium.
- **Treatment:** kept. The same thresholds drive the alert rule: WARNING above 15 s, CRITICAL
  above 30 s (`LATENCY`).
- **Why:** slow loads are the signal the dashboard exists to show, not noise to remove. Because
  three quarters of the rows breach, alert **deduplication** is essential. See
  [ARCHITECTURE.md](ARCHITECTURE.md#decisions) and [WEBSOCKET.md](WEBSOCKET.md#alert-lifecycle).

## DQ04: AWS cost per view outlier

- **Rule:** a row is flagged if either test holds.
  1. **Statistical:** the robust z-score of the log cost per view exceeds 3.5 in absolute value.
  2. **Hard rule:** `monthly_active_views < 50` and `aws_hosting_cost_usd > 300`.
- **Count:** 30 rows. Severity medium. Of these, 27 pass the z-test, 18 meet the hard rule, and
  15 meet both. So 12 are caught only by z, and 3 only by the hard rule.
- **Treatment:** kept, flagged `COST_MISMATCH`. The Cost page lists them with the direction
  (HIGH or LOW) and, for admins and owners, the z-score.

**Formula.** With `x = ln(aws_hosting_cost_usd / monthly_active_views)`:

```
modified z = 0.6745 * (x - median(x)) / MAD(x)         MAD = median(|x - median(x)|)
```

This is the Iglewicz and Hoaglin modified z-score. `median` and `MAD` are **pooled across all 20
snapshots**, over rows with `views > 0` and `aws > 0`, so each report is compared with the
whole portfolio's history rather than with one day. The cutoff is 3.5 (`COST_ROBUST_Z`).

**Why robust, and why on the log.** Cost per view is heavy-tailed: a report with 2 views and a
$300 bill sits orders of magnitude from the rest. A mean and standard deviation would be dragged
by those very outliers and would hide them. The median and MAD are barely moved by them. The log
turns the ratio into a roughly symmetric quantity, so "10x too expensive" and "10x too cheap" are
the same distance from the centre.

**Why the hard rule too.** The brief's own example (few views, high AWS bill) should always be
caught, whatever the distribution looks like. 18 rows meet it. Three of them are not statistical
outliers, which is why both tests are kept.

**Observation behind this rule.** AWS cost and views are essentially uncorrelated (correlation
-0.027), so hosting spend does not track usage. That makes "cost per view" a poor estimate and an
outlier test on it worth having.

### Why zero-view rows are left to DQ05

For `views = 0` the ratio `aws / views` is undefined and its log does not exist. Such rows are
**not scored** by the z-test; DQ05 owns them. Only a zero-view row that also meets the hard rule
(AWS above $300) gets `COST_MISMATCH`. Of the four zero-view rows, one does: RPT_223 at snapshot
2, with $309.62.

## DQ05: zero monthly views

- **Rule:** `monthly_active_views = 0`.
- **Count:** 4 rows (RPT_223, RPT_278, RPT_299, RPT_230). Severity medium.
- **Treatment:** kept, flagged `ZERO_VIEWS`. Every division by views uses `NULLIF(views, 0)`, so
  unit cost is NULL (the API returns `null`), not an error and not infinity.
- **Why:** a 0-view report still costs money, so it must stay in the cost totals. It just has no
  meaningful cost per view. Without `NULLIF`, DuckDB returns Infinity and Snowflake raises a
  division error.

## DQ06: impossible concurrency

- **Rule:** `concurrent_user_peak > monthly_active_views`.
- **Count:** 93 rows. Severity low.
- **Treatment:** kept, flagged `IMPOSSIBLE_CONCURRENCY`.
- **Why:** you cannot have more simultaneous users than distinct monthly users. Either the two
  metrics come from different sources or windows, or one is wrong. We cannot tell which, so
  neither is corrected. The cost suite does not use concurrency, so the flag is informational. It
  is evidence that the usage columns should not be trusted blindly. All four zero-view rows are
  among these 93, because their peak is above 0.

## DQ07: unknown refresh status

- **Rule:** `last_refresh_status = 'UNKNOWN'` (after trimming and uppercasing).
- **Count:** 100 rows, across 66 reports. Severity low.
- **Treatment:** kept as its own bucket, never folded into SUCCESS or FAILED. It raises an INFO
  alert (`REFRESH_UNKNOWN`).
- **Why:** UNKNOWN is a monitoring gap: the refresh job did not report. Counting it as success
  would overstate health, and counting it as failure would invent incidents. The refresh success
  rate treats UNKNOWN as not successful and shows it separately.

## DQ08: slow but healthy

- **Rule:** `last_refresh_status = 'SUCCESS'` and `avg_load_time_sec > 15`.
- **Count:** 1004 rows, which is 1004 of the 1490 slow rows. Severity info.
- **Treatment:** kept, flagged `SLOW_BUT_HEALTHY`.
- **Why:** this is the finding a status-only view would miss. A successful refresh says the data
  arrived, not that the report is usable. Most slow rows are "green" on refresh status, so
  latency needs its own alert rule rather than being inferred from refresh health.

## DQ09: ownership change (event)

- **Rule:** the row's owner differs from the same report's owner in the previous snapshot (NULL
  counts as a value). A report's first snapshot is never a change.
- **Count:** 1782 rows. Severity info.
- **This is an event, not a defect.** Each report has **7 to 13 different owners** across its 20
  snapshots, and 15 to 19 changes. Of 1900 snapshot-to-snapshot transitions (100 reports × 19),
  1782 change owner. Ownership in this dataset is not stable, so there is no single "true" owner
  to clean toward.
- **Treatment:** all rows are kept, `owner_history` is stored per report, and the **current
  owner** is resolved by one rule:

  > `current_owner` = the normalized owner in the latest snapshot (index 19), unless an admin
  > override exists. An override wins even when it is NULL. A NULL result means the report is
  > currently orphaned.

  The view `REPORT_CURRENT_OWNER` ([`sql/01_schema.sql`](../sql/01_schema.sql)) is the single
  definition. The cost SQL (04 to 07) and the API read owners from it. They never read
  `REPORTS.current_owner` (computed at ingest) or the frozen `SQL_RESULTS` tables.
- **Consequence:** at snapshot 19, 14 reports are orphaned and `user_3@company.com` owns 11. The
  two chargeback views differ because of the churn: point-in-time charges each snapshot to its
  owner then, current charges all history to today's owner. See [ARCHITECTURE.md](ARCHITECTURE.md).

## Two implementations that must agree

Every rule is implemented twice, independently:

1. **TypeScript** (`server/src/ingest/rules.ts`) runs at ingest and writes the flags and
   `DQ_RESULTS`.
2. **SQL** ([`sql/02_data_quality.sql`](../sql/02_data_quality.sql)) recomputes DQ01 to DQ09 from
   the raw CSV text in `RAW_REPORT_SNAPSHOTS` (all VARCHAR), without reading the TypeScript
   flags. The view `DQ_CHECKS` compares both counts per rule and reports PASS or FAIL.

Ingest fails if any row of `DQ_CHECKS` is FAIL, and so does server startup (the checks are stored
in `SQL_RESULTS` and re-asserted). All nine rules currently PASS, with equal counts from both
sides. A bug in either implementation therefore shows up as a mismatch instead of a wrong number.

## The committed summary and the drift test

`data/dq_summary.json` is generated by `npm run ingest` and **committed**. The integration test
`server/test/ingest/ingest.integration.test.ts` builds the warehouse from the CSV in memory and
fails if the result differs from the committed file; `server/test/api/reports.test.ts` checks
that `GET /data-quality` matches it. The file is therefore a reviewable record of what the rules
produce. **After changing a rule or a threshold, re-run `npm run ingest` and commit the new
file.** Editing a rule's SQL or a parameter also changes the `SUITE_FINGERPRINT`, so the server
refuses to start until ingest is re-run.

## Ingest normalization

Applied before any rule runs (marker and status lists are in `config.ts`):

- Owner emails are trimmed and lowercased. Orphan markers (`nan`, `ORPHANED_REPORT`, empty) match
  case-insensitively after trimming. Login lowercases and trims the submitted email as well,
  because owner scoping compares emails by exact match.
- `last_refresh_status` is trimmed and uppercased, then must be one of SUCCESS, FAILED,
  TIMED_OUT or UNKNOWN. Anything else fails ingest with a message naming the row.
- A leading UTF-8 BOM is stripped before parsing. Quoted fields or a wrong field count fail
  ingest rather than misaligning columns.
- Non-numeric values in numeric columns fail ingest with the row and column named.

## Limitations of the treatment

- Thresholds (15 s, 30 s, 50 views, $300, z 3.5) are judgment calls, not derived from the
  business. They are single constants in `config.ts` so they are easy to change.
- Quarantined snapshots have unknown cost. Per-report and total costs are therefore a lower
  bound for the 24 affected snapshots.
- DQ06 and DQ04 show the data is inconsistent but cannot say which column is wrong, so nothing is
  corrected.
