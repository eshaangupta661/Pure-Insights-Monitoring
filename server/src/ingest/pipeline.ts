import {
  LIST,
  VARCHAR,
  dateValue,
  listValue,
  type DuckDBAppender,
  type DuckDBConnection,
} from '@duckdb/node-api';
import type { DqFlag, DqSummary } from '@pic/shared';
import { config } from '../config.js';
import { CSV_COLUMNS, parseCsv, type RawRow } from './csv.js';
import { toSnapshotRow, type SnapshotRow } from './normalize.js';
import {
  DQ_RULES,
  computeCostStats,
  flagRow,
  hasNegativeCredits,
  resolveCurrentOwner,
} from './rules.js';

const SAMPLES_PER_RULE = 3;

export interface FlaggedRow extends SnapshotRow {
  credits_clean: number | null;
  dq_flags: DqFlag[];
}

export interface ReportRecord {
  report_id: string;
  report_name: string;
  current_owner: string | null;
  is_orphaned: boolean;
  owner_history: (string | null)[];
  owner_change_count: number;
}

const DDL = `
CREATE OR REPLACE TABLE RAW_REPORT_SNAPSHOTS (
  row_idx INTEGER NOT NULL,
  ${CSV_COLUMNS.map((c) => `${c} VARCHAR`).join(',\n  ')}
);
CREATE OR REPLACE TABLE REPORT_SNAPSHOTS (
  row_idx INTEGER NOT NULL,
  snapshot_idx INTEGER NOT NULL,
  snapshot_date DATE NOT NULL,
  report_id VARCHAR NOT NULL,
  report_name VARCHAR NOT NULL,
  owner_email VARCHAR,
  last_refresh_status VARCHAR NOT NULL,
  monthly_active_views INTEGER NOT NULL,
  snowflake_credits_consumed DOUBLE NOT NULL,
  credits_clean DOUBLE,
  avg_load_time_sec DOUBLE NOT NULL,
  aws_hosting_cost_usd DOUBLE NOT NULL,
  query_count_last_30d INTEGER NOT NULL,
  concurrent_user_peak INTEGER NOT NULL,
  dq_flags VARCHAR[] NOT NULL
);
CREATE OR REPLACE TABLE QUARANTINE (
  row_idx INTEGER NOT NULL,
  report_id VARCHAR NOT NULL,
  snapshot_idx INTEGER NOT NULL,
  rule_id VARCHAR NOT NULL,
  column_name VARCHAR NOT NULL,
  raw_value VARCHAR NOT NULL,
  reason VARCHAR NOT NULL
);
CREATE OR REPLACE TABLE REPORTS (
  report_id VARCHAR PRIMARY KEY,
  report_name VARCHAR NOT NULL,
  current_owner VARCHAR,
  is_orphaned BOOLEAN NOT NULL,
  owner_history VARCHAR[] NOT NULL,
  owner_change_count INTEGER NOT NULL
);
CREATE OR REPLACE TABLE DQ_RESULTS (
  rule_id VARCHAR PRIMARY KEY,
  rule_name VARCHAR NOT NULL,
  severity VARCHAR NOT NULL,
  rows_affected INTEGER NOT NULL,
  treatment VARCHAR NOT NULL
);
`;

/**
 * Checks the CSV really is SNAPSHOT_COUNT stacked blocks with every report exactly once per block,
 * which is what makes snapshot_idx = floor(row / reportsPerSnapshot) valid. Returns the block size.
 */
export function reportsPerSnapshot(raw: readonly RawRow[]): number {
  if (raw.length === 0 || raw.length % config.SNAPSHOT_COUNT !== 0) {
    throw new Error(
      `${raw.length} rows is not a multiple of SNAPSHOT_COUNT=${config.SNAPSHOT_COUNT}`,
    );
  }
  const size = raw.length / config.SNAPSHOT_COUNT;
  const firstBlock = new Set(raw.slice(0, size).map((r) => r.report_id));
  if (firstBlock.size !== size) throw new Error('Duplicate report_id inside snapshot 0');
  for (let s = 1; s < config.SNAPSHOT_COUNT; s++) {
    const block = new Set(raw.slice(s * size, (s + 1) * size).map((r) => r.report_id));
    if (block.size !== size || [...block].some((id) => !firstBlock.has(id))) {
      throw new Error(
        `Snapshot ${s} does not contain the same ${size} distinct report_ids as snapshot 0`,
      );
    }
  }
  return size;
}

/** Types every row and attaches DQ flags and credits_clean. Pure; no I/O. */
export function flagRows(raw: readonly RawRow[]): FlaggedRow[] {
  const size = reportsPerSnapshot(raw);
  const rows = raw.map((r, i) => toSnapshotRow(r, i, size));
  const costStats = computeCostStats(rows);
  const lastOwner = new Map<string, string | null>();

  return rows.map((row) => {
    const dq_flags = flagRow(row, { costStats, prevOwner: lastOwner.get(row.report_id) });
    lastOwner.set(row.report_id, row.owner_email);
    return {
      ...row,
      credits_clean: hasNegativeCredits(row) ? null : row.snowflake_credits_consumed,
      dq_flags,
    };
  });
}

/** One record per report, in first-seen order, with owner history in snapshot order. */
export function buildReports(rows: readonly FlaggedRow[]): ReportRecord[] {
  const byReport = new Map<string, FlaggedRow[]>();
  for (const row of rows) {
    const list = byReport.get(row.report_id) ?? [];
    list.push(row);
    byReport.set(row.report_id, list);
  }
  return [...byReport.values()].map((list) => {
    const sorted = [...list].sort((a, b) => a.snapshot_idx - b.snapshot_idx);
    const owner_history = sorted.map((r) => r.owner_email);
    const current_owner = resolveCurrentOwner(owner_history);
    return {
      report_id: sorted[0]!.report_id,
      report_name: sorted[0]!.report_name,
      current_owner,
      is_orphaned: current_owner === null,
      owner_history,
      owner_change_count: sorted.filter((r) => r.dq_flags.includes('OWNER_CHANGED')).length,
    };
  });
}

/** DQ results plus the first few distinct report_ids (row order) per rule. Deterministic. */
export function summarize(rows: readonly FlaggedRow[]): DqSummary {
  return {
    sourceRows: rows.length,
    rules: DQ_RULES.map((rule) => {
      const hits = rows.filter((r) => r.dq_flags.includes(rule.flag));
      return {
        ruleId: rule.id,
        ruleName: rule.name,
        severity: rule.severity,
        rowsAffected: hits.length,
        treatment: rule.treatment,
        flag: rule.flag,
        sampleReportIds: [...new Set(hits.map((r) => r.report_id))].slice(0, SAMPLES_PER_RULE),
      };
    }),
  };
}

function appendNullable(
  appender: DuckDBAppender,
  value: string | number | null,
  kind: 'varchar' | 'double',
): void {
  if (value === null) appender.appendNull();
  else if (kind === 'varchar') appender.appendVarchar(String(value));
  else appender.appendDouble(Number(value));
}

function toDateValue(iso: string) {
  const [year, month, day] = iso.split('-').map(Number) as [number, number, number];
  return dateValue({ year, month, day });
}

async function withAppender(
  conn: DuckDBConnection,
  table: string,
  fill: (a: DuckDBAppender) => void,
) {
  const appender = await conn.createAppender(table);
  try {
    fill(appender);
  } finally {
    appender.closeSync();
  }
}

/** Builds all Phase 1 tables in `conn` from the CSV text and returns the DQ summary. */
export async function runIngest(conn: DuckDBConnection, csvText: string): Promise<DqSummary> {
  const raw = parseCsv(csvText);
  const rows = flagRows(raw);
  const reports = buildReports(rows);
  const summary = summarize(rows);

  await conn.run(DDL);

  await withAppender(conn, 'RAW_REPORT_SNAPSHOTS', (a) => {
    raw.forEach((r, i) => {
      a.appendInteger(i);
      for (const col of CSV_COLUMNS) a.appendVarchar(r[col]);
      a.endRow();
    });
  });

  await withAppender(conn, 'REPORT_SNAPSHOTS', (a) => {
    for (const r of rows) {
      a.appendInteger(r.row_idx);
      a.appendInteger(r.snapshot_idx);
      a.appendDate(toDateValue(r.snapshot_date));
      a.appendVarchar(r.report_id);
      a.appendVarchar(r.report_name);
      appendNullable(a, r.owner_email, 'varchar');
      a.appendVarchar(r.last_refresh_status);
      a.appendInteger(r.monthly_active_views);
      a.appendDouble(r.snowflake_credits_consumed);
      appendNullable(a, r.credits_clean, 'double');
      a.appendDouble(r.avg_load_time_sec);
      a.appendDouble(r.aws_hosting_cost_usd);
      a.appendInteger(r.query_count_last_30d);
      a.appendInteger(r.concurrent_user_peak);
      a.appendList(listValue(r.dq_flags), LIST(VARCHAR));
      a.endRow();
    }
  });

  await withAppender(conn, 'QUARANTINE', (a) => {
    for (const r of rows.filter(hasNegativeCredits)) {
      a.appendInteger(r.row_idx);
      a.appendVarchar(r.report_id);
      a.appendInteger(r.snapshot_idx);
      a.appendVarchar('DQ02');
      a.appendVarchar('snowflake_credits_consumed');
      a.appendVarchar(raw[r.row_idx]!.snowflake_credits_consumed);
      a.appendVarchar('Negative credits are impossible; excluded from cost attribution');
      a.endRow();
    }
  });

  await withAppender(conn, 'REPORTS', (a) => {
    for (const r of reports) {
      a.appendVarchar(r.report_id);
      a.appendVarchar(r.report_name);
      appendNullable(a, r.current_owner, 'varchar');
      a.appendBoolean(r.is_orphaned);
      a.appendList(listValue(r.owner_history), LIST(VARCHAR));
      a.appendInteger(r.owner_change_count);
      a.endRow();
    }
  });

  await withAppender(conn, 'DQ_RESULTS', (a) => {
    for (const r of summary.rules) {
      a.appendVarchar(r.ruleId);
      a.appendVarchar(r.ruleName);
      a.appendVarchar(r.severity);
      a.appendInteger(r.rowsAffected);
      a.appendVarchar(r.treatment);
      a.endRow();
    }
  });

  return summary;
}
