import { DuckDBInstance, LIST, VARCHAR, dateValue, listValue } from '@duckdb/node-api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Pins the exact @duckdb/node-api behaviours the warehouse code relies on, so a library upgrade
 * that changes them fails here rather than deep inside ingest.
 */
describe('@duckdb/node-api contract', () => {
  let instance: DuckDBInstance;
  let conn: Awaited<ReturnType<DuckDBInstance['connect']>>;

  beforeAll(async () => {
    instance = await DuckDBInstance.create(':memory:');
    conn = await instance.connect();
    await conn.run(
      'CREATE TABLE t (id INTEGER, d DATE, x DOUBLE, s VARCHAR, flags VARCHAR[], hist VARCHAR[])',
    );
  });

  afterAll(() => {
    conn.closeSync();
    instance.closeSync();
  });

  it('appends scalars, NULLs, dates and lists (including NULL elements)', async () => {
    const appender = await conn.createAppender('t');
    appender.appendInteger(1);
    appender.appendDate(dateValue({ year: 2026, month: 9, day: 21 }));
    appender.appendDouble(-0.8);
    appender.appendVarchar('a');
    appender.appendList(listValue(['SLOW_LOAD', 'ORPHANED']), LIST(VARCHAR));
    appender.appendList(listValue(['u1', null, 'u2']), LIST(VARCHAR));
    appender.endRow();

    appender.appendInteger(2);
    appender.appendDate(dateValue({ year: 2026, month: 10, day: 10 }));
    appender.appendNull();
    appender.appendNull();
    appender.appendList(listValue([]), LIST(VARCHAR));
    appender.appendList(listValue([null]), LIST(VARCHAR));
    appender.endRow();
    appender.closeSync();

    const reader = await conn.runAndReadAll(
      "SELECT id, strftime(d, '%Y-%m-%d') AS d, x, s, flags, hist FROM t ORDER BY id",
    );
    expect(reader.getRowObjectsJson()).toEqual([
      {
        id: 1,
        d: '2026-09-21',
        x: -0.8,
        s: 'a',
        flags: ['SLOW_LOAD', 'ORPHANED'],
        hist: ['u1', null, 'u2'],
      },
      { id: 2, d: '2026-10-10', x: null, s: null, flags: [], hist: [null] },
    ]);
  });

  it('binds positional parameters', async () => {
    const reader = await conn.runAndReadAll(
      'SELECT count(*)::INTEGER AS n FROM t WHERE id = $1 AND list_contains(flags, $2)',
      [1, 'SLOW_LOAD'],
    );
    expect(reader.getRowObjectsJson()).toEqual([{ n: 1 }]);
  });

  it('returns COUNT(*) as BIGINT, serialised to a string by getRowObjectsJson', async () => {
    const reader = await conn.runAndReadAll('SELECT count(*) AS n FROM t');
    expect(reader.getRowObjectsJson()).toEqual([{ n: '2' }]);
  });
});
