import { DuckDBInstance, type DuckDBConnection, type DuckDBValue } from '@duckdb/node-api';
import { config } from './config.js';

export interface Db {
  instance: DuckDBInstance;
  conn: DuckDBConnection;
}

/**
 * Opens a DuckDB database file (or ':memory:') with a single connection, capped at
 * DUCKDB_THREADS / DUCKDB_MEMORY_LIMIT so it fits a small Render instance.
 */
export async function openDb(path: string): Promise<Db> {
  const instance = await DuckDBInstance.create(path, {
    threads: String(config.DUCKDB_THREADS),
    memory_limit: config.DUCKDB_MEMORY_LIMIT,
  });
  const conn = await instance.connect();
  return { instance, conn };
}

/** Closes the connection then the instance, releasing the file lock. */
export function closeDb(db: Db): void {
  db.conn.closeSync();
  db.instance.closeSync();
}

/**
 * Runs a query and returns rows as JSON-safe objects. Positional params bind to $1, $2, ...
 * BIGINT columns (e.g. COUNT(*)) come back as strings, so cast counts with ::INTEGER.
 */
export async function all<T>(
  conn: DuckDBConnection,
  sql: string,
  params: DuckDBValue[] = [],
): Promise<T[]> {
  const reader = await conn.runAndReadAll(sql, params);
  return reader.getRowObjectsJson() as T[];
}
