import { AsyncLocalStorage } from 'node:async_hooks';
import type { DuckDBConnection, DuckDBValue } from '@duckdb/node-api';
import { all } from '../db.js';

/** What repos need: read rows and run statements. Implemented by Warehouse and by a transaction. */
export interface Queryable {
  /** Rows as JSON-safe objects (see `all` in db.ts). Positional params bind to $1, $2, ... */
  query<T>(sql: string, params?: DuckDBValue[]): Promise<T[]>;
  run(sql: string, params?: DuckDBValue[]): Promise<void>;
}

/**
 * The API's single DuckDB connection. A connection runs one statement at a time, so every call
 * goes through a FIFO queue. `transaction(fn)` holds the queue for the whole transaction and gives
 * `fn` a handle that talks to the connection directly; calling the Warehouse itself from inside
 * `fn` would wait on its own transaction forever, so it throws instead.
 */
export class Warehouse implements Queryable {
  private tail: Promise<unknown> = Promise.resolve();
  private readonly inTransaction = new AsyncLocalStorage<true>();

  constructor(private readonly conn: DuckDBConnection) {}

  query<T>(sql: string, params: DuckDBValue[] = []): Promise<T[]> {
    return this.enqueue(() => all<T>(this.conn, sql, params));
  }

  run(sql: string, params: DuckDBValue[] = []): Promise<void> {
    return this.enqueue(async () => {
      await this.conn.run(sql, params);
    });
  }

  /** BEGIN, run `fn`, COMMIT; ROLLBACK and rethrow if `fn` throws. */
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    return this.enqueue(async () => {
      let open = true;
      const guard = () => {
        if (!open) throw new Error('Transaction handle used after the transaction ended');
      };
      const tx: Queryable = {
        query: async <R>(sql: string, params: DuckDBValue[] = []) => {
          guard();
          return all<R>(this.conn, sql, params);
        },
        run: async (sql: string, params: DuckDBValue[] = []) => {
          guard();
          await this.conn.run(sql, params);
        },
      };

      await this.conn.run('BEGIN TRANSACTION');
      try {
        const result = await this.inTransaction.run(true, () => fn(tx));
        await this.conn.run('COMMIT');
        return result;
      } catch (err) {
        try {
          await this.conn.run('ROLLBACK');
        } catch {
          // The original error explains what went wrong; a failed ROLLBACK adds nothing.
        }
        throw err;
      } finally {
        open = false;
      }
    });
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    if (this.inTransaction.getStore()) {
      return Promise.reject(
        new Error('Use the transaction handle inside warehouse.transaction(); this would deadlock'),
      );
    }
    const result = this.tail.then(task, task);
    this.tail = result.catch(() => undefined);
    return result;
  }
}
