import type { DuckDBConnection } from '@duckdb/node-api';
import { config } from '../config.js';
import { all } from '../db.js';

/**
 * config.ts keys mirrored by /sql/00_setup_parameters.sql. PARAMS columns are the lowercase key
 * names. config.ts is the source of truth; the SQL copy exists so the suite runs standalone.
 */
export const PARAM_KEYS = [
  'CREDIT_PRICE_USD',
  'SIMULATED_OVERHEAD_RATE',
  'LATENCY_WARNING_SEC',
  'LATENCY_CRITICAL_SEC',
  'COST_ROBUST_Z',
  'COST_LOW_VIEWS',
  'COST_HIGH_AWS_USD',
  'RECON_TOLERANCE',
] as const satisfies readonly (keyof typeof config)[];

/** Differences between the PARAMS / PARAM_ORPHAN_MARKERS tables and config.ts; empty when in sync. */
export async function paramDrift(conn: DuckDBConnection): Promise<string[]> {
  const drift: string[] = [];
  const rows = await all<Record<string, unknown>>(conn, 'SELECT * FROM PARAMS');
  const row = rows[0];
  if (rows.length !== 1 || row === undefined) return [`PARAMS has ${rows.length} rows, expected 1`];

  const expected = new Set<string>(PARAM_KEYS.map((k) => k.toLowerCase()));
  for (const key of PARAM_KEYS) {
    const col = key.toLowerCase();
    if (row[col] !== config[key])
      drift.push(`${col}: sql=${String(row[col])} config=${config[key]}`);
  }
  for (const col of Object.keys(row)) {
    if (!expected.has(col)) drift.push(`${col}: in PARAMS but not in config.ts`);
  }

  const markers = await all<{ marker: string }>(
    conn,
    'SELECT marker FROM PARAM_ORPHAN_MARKERS ORDER BY marker',
  );
  const sqlMarkers = markers.map((m) => m.marker);
  const configMarkers = [...config.ORPHAN_OWNER_MARKERS].sort();
  if (JSON.stringify(sqlMarkers) !== JSON.stringify(configMarkers)) {
    drift.push(
      `orphan markers: sql=${JSON.stringify(sqlMarkers)} config=${JSON.stringify(configMarkers)}`,
    );
  }
  return drift;
}
