/*
 * Runs the /sql suite against DuckDB and serves its results from memory.
 *
 * Two entry points, so startup only reads: a full run rebuilds the 03 tables and every view
 * (about 1.2 s locally at threads=1, slower on Render's shared CPU), while loading the stored
 * results takes well under 100 ms and keeps the cold start predictable:
 *
 *   runSqlSuite(conn)     `npm run ingest`. Checks PARAMS against config, runs 02–08 (so the 03
 *                         tables are rebuilt from the current ACCOUNT_USAGE data every time),
 *                         fails if any RECONCILIATION or DQ_CHECKS row is FAIL, then stores every
 *                         cached view as a table in schema SQL_RESULTS plus SUITE_FINGERPRINT.
 *   loadSqlResults(conn)  Server startup. Checks PARAMS, checks SUITE_FINGERPRINT still matches
 *                         the current /sql files and PARAMS (otherwise: re-run ingest), loads the
 *                         stored tables and asserts the stored checks are all PASS.
 *
 * Either way a failure throws, and the caller exits non-zero.
 */
import crypto from 'node:crypto';
import type { DuckDBConnection } from '@duckdb/node-api';
import { config } from '../config.js';
import { all } from '../db.js';
import { PARAM_KEYS, paramDrift } from './params.js';
import { loadSql } from './translate.js';
import type { CachedView, DqCheckRow, ReconciliationRow, SqlViewRows } from './types.js';

/** Files in run order and the views from each that are cached (stored at ingest, loaded at startup). */
export const SQL_SUITE: readonly { file: string; cache: readonly CachedView[] }[] = [
  { file: '02_data_quality.sql', cache: ['DQ_CHECKS'] }, // DQ_ROW_CHECKS: 2,000 rows, on demand
  { file: '03_query_level_cost.sql', cache: [] }, // TABLES QUERY_HOUR_COST / QUERY_ATTRIBUTED_COST: 83k+ rows, on demand
  { file: '04_report_attribution.sql', cache: ['REPORT_ATTRIBUTION_DAILY', 'REPORT_ATTRIBUTION'] },
  { file: '05_unit_economics.sql', cache: ['UNIT_ECONOMICS_SNAPSHOT', 'UNIT_ECONOMICS_REPORT'] },
  {
    file: '06_anomalies.sql',
    cache: [
      'ANOMALY_COST_PER_VIEW',
      'ANOMALY_ORPHANED_REPORTS',
      'ANOMALY_ZOMBIE_REPORTS',
      'ANOMALY_AWS_VIEWS_MISMATCH',
      'ANOMALY_NEGATIVE_CREDITS',
    ],
  },
  { file: '07_owner_chargeback.sql', cache: ['OWNER_CHARGEBACK', 'OWNER_CHARGEBACK_CURRENT'] },
  { file: '08_reconciliation.sql', cache: ['RECONCILIATION'] },
];

/** 00 and 01 run at ingest before the data loads; they are part of the fingerprint too. */
const SETUP_FILES = ['00_setup_parameters.sql', '01_schema.sql'];
export const RESULTS_SCHEMA = 'SQL_RESULTS';
export const FINGERPRINT_TABLE = 'SUITE_FINGERPRINT';
const CACHED_VIEWS: readonly CachedView[] = SQL_SUITE.flatMap((s) => s.cache);
/** Stored first and verified before anything else is stored. */
const VERIFIED_VIEWS: readonly CachedView[] = ['RECONCILIATION', 'DQ_CHECKS'];

/** The suite could not run or its stored results can't be trusted (drift, stale, missing). */
export class SqlSuiteError extends Error {
  override name = 'SqlSuiteError';
}

/** A RECONCILIATION or DQ_CHECKS row is FAIL. `failures` lists one line per failing row. */
export class ReconciliationError extends SqlSuiteError {
  override name = 'ReconciliationError';
  constructor(readonly failures: string[]) {
    super(`SQL suite verification failed:\n  ${failures.join('\n  ')}`);
  }
}

export interface SqlResults {
  views: { [K in CachedView]: SqlViewRows[K][] };
  mode: 'full' | 'stored';
  durationMs: number;
}

let cached: SqlResults | null = null;

/** Results loaded by the last successful runSqlSuite / loadSqlResults. */
export function getSqlResults(): SqlResults {
  if (!cached) throw new SqlSuiteError('SQL results not loaded; call loadSqlResults() at startup');
  return cached;
}

export interface FingerprintInputs {
  /** file name → SQL as executed (after translation), for every /sql file 00–08. */
  sql: Readonly<Record<string, string>>;
  /** The PARAMS values (config.ts is their source of truth) plus the orphan markers. */
  params: Readonly<Record<string, unknown>>;
}

/** The current /sql files and PARAMS values, i.e. what a fresh ingest would build from. */
export function currentFingerprintInputs(): FingerprintInputs {
  const files = [...SETUP_FILES, ...SQL_SUITE.map((s) => s.file)];
  return {
    sql: Object.fromEntries(files.map((f) => [f, loadSql(f)])),
    params: {
      ...Object.fromEntries(PARAM_KEYS.map((k) => [k, config[k]])),
      ORPHAN_OWNER_MARKERS: [...config.ORPHAN_OWNER_MARKERS],
    },
  };
}

/**
 * SUITE_FINGERPRINT: sha256 over every /sql file and every PARAMS value. Ingest stores it next
 * to the results; startup recomputes it and refuses results built from different inputs.
 */
export function suiteFingerprint(inputs: FingerprintInputs = currentFingerprintInputs()): string {
  const hash = crypto.createHash('sha256');
  for (const file of Object.keys(inputs.sql).sort()) {
    hash.update(`file\0${file}\0${inputs.sql[file]}\0`);
  }
  for (const key of Object.keys(inputs.params).sort()) {
    hash.update(`param\0${key}\0${JSON.stringify(inputs.params[key])}\0`);
  }
  return hash.digest('hex');
}

async function runSqlFile(conn: DuckDBConnection, file: string): Promise<void> {
  try {
    await conn.run(loadSql(file));
  } catch (err) {
    throw new SqlSuiteError(`${file}: ${err instanceof Error ? err.message : String(err)}`, {
      cause: err,
    });
  }
}

async function assertNoParamDrift(conn: DuckDBConnection): Promise<void> {
  const drift = await paramDrift(conn);
  if (drift.length > 0) {
    throw new SqlSuiteError(
      `/sql/00_setup_parameters.sql (PARAMS) disagrees with server/src/config.ts; fix one side ` +
        `and re-run \`npm run ingest\`:\n  ${drift.join('\n  ')}`,
    );
  }
}

function verificationFailures(
  reconciliation: readonly ReconciliationRow[],
  dqChecks: readonly DqCheckRow[],
): string[] {
  const failures = [
    ...reconciliation
      .filter((r) => r.status !== 'PASS')
      .map(
        (r) =>
          `${r.check_id} [${r.check_kind}] ${r.description}: expected ${r.expected}, ` +
          `actual ${r.actual}, |diff| ${r.abs_diff} > ${r.tolerance}`,
      ),
    ...dqChecks
      .filter((r) => r.status !== 'PASS')
      .map((r) => `${r.rule_id}: SQL counts ${r.sql_rows} rows, TypeScript rules ${r.ts_rows}`),
  ];
  if (reconciliation.length === 0) failures.push('RECONCILIATION returned no rows');
  if (dqChecks.length === 0) failures.push('DQ_CHECKS returned no rows');
  return failures;
}

async function readStored<K extends CachedView>(
  conn: DuckDBConnection,
  view: K,
): Promise<SqlViewRows[K][]> {
  return all<SqlViewRows[K]>(conn, `SELECT * FROM ${RESULTS_SCHEMA}.${view}`);
}

async function storeView(conn: DuckDBConnection, view: CachedView): Promise<void> {
  await conn.run(`CREATE OR REPLACE TABLE ${RESULTS_SCHEMA}.${view} AS SELECT * FROM ${view}`);
}

/**
 * Full run (ingest): verify, then store. Failing results are never stored, so a warehouse that
 * passed ingest always has all-PASS results.
 */
export async function runSqlSuite(conn: DuckDBConnection): Promise<SqlResults> {
  const started = Date.now();
  await assertNoParamDrift(conn);
  for (const { file } of SQL_SUITE) await runSqlFile(conn, file);

  await conn.run(
    `DROP SCHEMA IF EXISTS ${RESULTS_SCHEMA} CASCADE; CREATE SCHEMA ${RESULTS_SCHEMA};`,
  );
  for (const view of VERIFIED_VIEWS) await storeView(conn, view);
  const failures = verificationFailures(
    await readStored(conn, 'RECONCILIATION'),
    await readStored(conn, 'DQ_CHECKS'),
  );
  if (failures.length > 0) {
    await conn.run(`DROP SCHEMA ${RESULTS_SCHEMA} CASCADE`);
    throw new ReconciliationError(failures);
  }

  for (const view of CACHED_VIEWS) {
    if (!VERIFIED_VIEWS.includes(view)) await storeView(conn, view);
  }
  await conn.run(
    `CREATE TABLE ${RESULTS_SCHEMA}.${FINGERPRINT_TABLE} AS
     SELECT $1 AS fingerprint, now()::TIMESTAMP AS built_at`,
    [suiteFingerprint()],
  );
  const results = await loadSqlResults(conn);
  cached = { ...results, mode: 'full', durationMs: Date.now() - started };
  return cached;
}

/** Startup: load what ingest stored, refusing stale, drifted or failing results. */
export async function loadSqlResults(conn: DuckDBConnection): Promise<SqlResults> {
  const started = Date.now();
  await assertNoParamDrift(conn);

  const [meta] = await all<{ n: number }>(
    conn,
    `SELECT count(*)::INTEGER AS n FROM information_schema.tables
     WHERE table_schema = '${RESULTS_SCHEMA}' AND table_name = '${FINGERPRINT_TABLE}'`,
  );
  if (!meta?.n) {
    throw new SqlSuiteError(
      `No stored SQL results in the warehouse (${RESULTS_SCHEMA}.${FINGERPRINT_TABLE} missing); run \`npm run ingest\``,
    );
  }
  const [stored] = await all<{ fingerprint: string }>(
    conn,
    `SELECT fingerprint FROM ${RESULTS_SCHEMA}.${FINGERPRINT_TABLE}`,
  );
  const current = suiteFingerprint();
  if (stored?.fingerprint !== current) {
    throw new SqlSuiteError(
      `${FINGERPRINT_TABLE} mismatch: the warehouse was built from different /sql files or PARAMS ` +
        `values (stored ${String(stored?.fingerprint).slice(0, 12)}…, current ${current.slice(0, 12)}…). ` +
        'Run `npm run ingest` to rebuild it.',
    );
  }

  const views = {} as SqlResults['views'];
  for (const view of CACHED_VIEWS) {
    // Each key gets the rows of its own view; TypeScript can't correlate K across the loop.
    (views as Record<CachedView, unknown[]>)[view] = await readStored(conn, view);
  }
  const failures = verificationFailures(views.RECONCILIATION, views.DQ_CHECKS);
  if (failures.length > 0) throw new ReconciliationError(failures);

  cached = { views, mode: 'stored', durationMs: Date.now() - started };
  return cached;
}

/** One-line-per-check console summary for ingest and startup logs. */
export function reconciliationTable(results: SqlResults) {
  return results.views.RECONCILIATION.map((r) => ({
    check: r.check_id,
    kind: r.check_kind,
    expected: r.expected,
    actual: r.actual,
    abs_diff: r.abs_diff,
    status: r.status,
  }));
}
