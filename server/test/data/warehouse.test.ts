import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Warehouse } from '../../src/data/warehouse.js';
import { closeDb, openDb, type Db } from '../../src/db.js';
import { paginate, paginateArray, pageQuerySchema } from '../../src/http/pagination.js';

describe('Warehouse', () => {
  let db: Db;
  let wh: Warehouse;
  const count = async () => (await wh.query<{ n: number }>('SELECT count(*)::INTEGER AS n FROM t'))[0]!.n;

  beforeAll(async () => {
    db = await openDb(':memory:');
    wh = new Warehouse(db.conn);
    await wh.run('CREATE TABLE t (id INTEGER PRIMARY KEY, v VARCHAR)');
  });
  afterAll(() => closeDb(db));
  beforeEach(() => wh.run('DELETE FROM t'));

  it('serializes concurrent queries on the one connection', async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => wh.query<{ x: number }>('SELECT $1::INTEGER AS x', [i])),
    );
    expect(results.map((r) => r[0]!.x)).toEqual(Array.from({ length: 20 }, (_, i) => i));
  });

  it('queries inside a transaction use the handle and do not deadlock; COMMIT keeps them', async () => {
    const seen = await wh.transaction(async (tx) => {
      await tx.run(`INSERT INTO t VALUES (1, 'a')`);
      return (await tx.query<{ n: number }>('SELECT count(*)::INTEGER AS n FROM t'))[0]!.n;
    });
    expect(seen).toBe(1);
    expect(await count()).toBe(1);
  });

  it('a throw rolls back every statement and rethrows', async () => {
    await expect(
      wh.transaction(async (tx) => {
        await tx.run(`INSERT INTO t VALUES (1, 'a')`);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await count()).toBe(0);

    // A failing statement (duplicate key) rolls back the earlier insert too.
    await expect(
      wh.transaction(async (tx) => {
        await tx.run(`INSERT INTO t VALUES (2, 'b')`);
        await tx.run(`INSERT INTO t VALUES (2, 'dup')`);
      }),
    ).rejects.toThrow();
    expect(await count()).toBe(0);
  });

  it('queries queued during a transaction run after it, in order', async () => {
    const order: string[] = [];
    const txDone = wh.transaction(async (tx) => {
      await tx.run(`INSERT INTO t VALUES (1, 'a')`);
      order.push('tx');
    });
    const after = wh.query<{ n: number }>('SELECT count(*)::INTEGER AS n FROM t').then((r) => {
      order.push('query');
      return r[0]!.n;
    });
    await txDone;
    expect(await after).toBe(1); // sees the committed row
    expect(order).toEqual(['tx', 'query']);
  });

  it('calling the warehouse itself inside a transaction fails fast instead of deadlocking', async () => {
    await expect(wh.transaction(() => wh.query('SELECT 1'))).rejects.toThrow(/transaction handle/);
    expect(await count()).toBe(0); // and the transaction rolled back
  });

  it('a transaction handle is dead after the transaction ends', async () => {
    let leaked: Parameters<Parameters<Warehouse['transaction']>[0]>[0] | undefined;
    await wh.transaction(async (tx) => {
      leaked = tx;
    });
    await expect(leaked!.query('SELECT 1')).rejects.toThrow(/after the transaction ended/);
  });

  describe('paginate (separate COUNT)', () => {
    const page = (p: number, size: number) => pageQuerySchema.parse({ page: p, pageSize: size });
    beforeEach(async () => {
      await wh.run(`INSERT INTO t SELECT i, 'v' || i FROM range(1, 8) r(i)`); // ids 1..7
    });

    it('returns full and last (partial) pages in a stable order', async () => {
      const p1 = await paginate<{ id: number }>(wh, 'SELECT id FROM t', [], 'id', page(1, 3));
      expect(p1).toEqual({ items: [{ id: 1 }, { id: 2 }, { id: 3 }], page: 1, pageSize: 3, total: 7 });
      const last = await paginate<{ id: number }>(wh, 'SELECT id FROM t', [], 'id', page(3, 3));
      expect(last).toEqual({ items: [{ id: 7 }], page: 3, pageSize: 3, total: 7 });
    });

    it('a page past the end has no items and the real total', async () => {
      const past = await paginate(wh, 'SELECT id FROM t', [], 'id', page(4, 3));
      expect(past).toEqual({ items: [], page: 4, pageSize: 3, total: 7 });
    });

    it('an empty result has total 0', async () => {
      const empty = await paginate(wh, 'SELECT id FROM t WHERE id > $1', [100], 'id', page(1, 3));
      expect(empty).toEqual({ items: [], page: 1, pageSize: 3, total: 0 });
    });

    it('binds filter params before LIMIT/OFFSET', async () => {
      const r = await paginate<{ id: number }>(
        wh,
        'SELECT id FROM t WHERE id >= $1',
        [5],
        'id DESC',
        page(1, 2),
      );
      expect(r).toEqual({ items: [{ id: 7 }, { id: 6 }], page: 1, pageSize: 2, total: 3 });
    });

    it('paginateArray follows the same contract', () => {
      const xs = [1, 2, 3, 4, 5, 6, 7];
      expect(paginateArray(xs, page(3, 3))).toEqual({ items: [7], page: 3, pageSize: 3, total: 7 });
      expect(paginateArray(xs, page(4, 3))).toEqual({ items: [], page: 4, pageSize: 3, total: 7 });
      expect(paginateArray([], page(1, 3))).toEqual({ items: [], page: 1, pageSize: 3, total: 0 });
    });

    it('validates page and pageSize', () => {
      expect(pageQuerySchema.parse({})).toEqual({ page: 1, pageSize: 25 });
      expect(pageQuerySchema.safeParse({ page: '0' }).success).toBe(false);
      expect(pageQuerySchema.safeParse({ pageSize: '101' }).success).toBe(false);
      expect(pageQuerySchema.safeParse({ page: '1.5' }).success).toBe(false);
    });
  });
});
