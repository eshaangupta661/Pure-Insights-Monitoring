/*
 * `npm run ingest`: CSV → data/warehouse.duckdb + data/dq_summary.json.
 *
 * After loading, it runs the /sql suite (02–08) and stores its results; any FAIL in
 * RECONCILIATION or DQ_CHECKS fails the ingest (and therefore the Render build).
 *
 * Builds into data/warehouse.tmp.duckdb and only renames it over warehouse.duckdb after
 * everything succeeded, so a failed run never leaves a half-built warehouse. It touches no other
 * files in data/ beyond those (and their .wal side files).
 */
import fs from 'node:fs';
import type { DqSummary } from '@pic/shared';
import { all, closeDb, openDb } from '../db.js';
import { DQ_SUMMARY_PATH, RAW_CSV, WAREHOUSE_PATH } from '../paths.js';
import { reconciliationTable, runSqlSuite, type SqlResults } from '../sql/runner.js';
import { runIngest } from './pipeline.js';

const TMP_PATH = WAREHOUSE_PATH.replace(/\.duckdb$/, '.tmp.duckdb');
const TABLES = [
  'PARAMS',
  'RAW_REPORT_SNAPSHOTS',
  'REPORT_SNAPSHOTS',
  'REPORTS',
  'QUARANTINE',
  'DQ_RESULTS',
  'OWNER_OVERRIDES',
  'AUDIT_LOG',
  'ACCOUNT_USAGE.QUERY_HISTORY',
  'ACCOUNT_USAGE.WAREHOUSE_METERING_HISTORY',
];

class LockedError extends Error {}

function removeIfExists(file: string): void {
  try {
    fs.rmSync(file, { force: true });
  } catch (err) {
    if (isLockError(err)) throw new LockedError(file);
    throw err;
  }
}

function isLockError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === 'EBUSY' || code === 'EPERM' || code === 'EACCES';
}

interface BuildResult {
  summary: DqSummary;
  counts: Record<string, number>;
  sql: SqlResults;
}

async function build(): Promise<BuildResult> {
  removeIfExists(TMP_PATH);
  removeIfExists(`${TMP_PATH}.wal`);

  const csv = fs.readFileSync(RAW_CSV, 'utf8');
  const db = await openDb(TMP_PATH);
  try {
    const summary = await runIngest(db.conn, csv);
    const sql = await runSqlSuite(db.conn);
    const counts: Record<string, number> = {};
    for (const table of TABLES) {
      const [row] = await all<{ n: number }>(
        db.conn,
        `SELECT count(*)::INTEGER AS n FROM ${table}`,
      );
      counts[table] = row?.n ?? 0;
    }
    return { summary, counts, sql };
  } finally {
    closeDb(db); // checkpoints and releases the file before the rename
  }
}

function promote(): void {
  try {
    // A stale WAL next to the new file would be replayed against it, so drop it first.
    removeIfExists(`${WAREHOUSE_PATH}.wal`);
    fs.renameSync(TMP_PATH, WAREHOUSE_PATH);
  } catch (err) {
    if (err instanceof LockedError || isLockError(err)) throw new LockedError(WAREHOUSE_PATH);
    throw err;
  }
}

function printSummary({ summary, counts, sql }: BuildResult): void {
  console.log(`\nIngested ${summary.sourceRows} rows → ${WAREHOUSE_PATH}\n`);
  console.table(
    summary.rules.map((r) => ({
      rule: r.ruleId,
      name: r.ruleName,
      severity: r.severity,
      rows: r.rowsAffected,
      flag: r.flag,
      samples: r.sampleReportIds.join(' '),
    })),
  );
  console.table(Object.entries(counts).map(([table, rows]) => ({ table, rows })));
  console.log(`DQ summary written to ${DQ_SUMMARY_PATH}`);
  console.log(`\nSQL suite 02–08 verified and stored in ${sql.durationMs} ms. Reconciliation:`);
  console.table(reconciliationTable(sql));
}

async function main(): Promise<void> {
  try {
    const result = await build();
    promote();
    fs.writeFileSync(DQ_SUMMARY_PATH, `${JSON.stringify(result.summary, null, 2)}\n`);
    printSummary(result);
  } catch (err) {
    try {
      removeIfExists(TMP_PATH);
      removeIfExists(`${TMP_PATH}.wal`);
    } catch {
      // best effort; the original error matters more
    }
    if (err instanceof LockedError) {
      console.error(
        `\n${WAREHOUSE_PATH} is in use (locked by another process).\n` +
          'Stop the dev server (npm run dev / npm start) and re-run `npm run ingest`.\n' +
          'The existing warehouse was left unchanged.',
      );
    } else {
      console.error('Ingest failed; the existing warehouse was left unchanged.');
      console.error(err);
    }
    process.exitCode = 1;
  }
}

await main();
