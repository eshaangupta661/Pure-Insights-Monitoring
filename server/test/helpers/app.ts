import fs from 'node:fs';
import type { Express } from 'express';
import { createApp } from '../../src/app.js';
import { config } from '../../src/config.js';
import { Warehouse } from '../../src/data/warehouse.js';
import { all, closeDb, openDb, type Db } from '../../src/db.js';
import { createDeps, type ApiDeps } from '../../src/deps.js';
import { runIngest } from '../../src/ingest/pipeline.js';
import { RAW_CSV } from '../../src/paths.js';
import { ReplayClock } from '../../src/realtime/clock.js';
import { AlertEngine } from '../../src/realtime/engine.js';
import { runSqlSuite } from '../../src/sql/runner.js';

export const LATEST_TICK = config.SNAPSHOT_COUNT - 1;
/** Virtual start: cycle 1000, the latest tick (1 ms in, so floor() is unambiguous). */
const START_MS = (1000 * config.SNAPSHOT_COUNT + LATEST_TICK) * config.TICK_MS + 1;

/** A ReplayClock on a fake wall clock the test moves by hand. */
export interface TestClock {
  clock: ReplayClock;
  /** Moves wall time forward (or back) by `ms`. */
  advance(ms: number): void;
  /** Moves wall time so the clock shows `tick` in the current cycle (clock must be running). */
  set(tick: number): void;
}

export function testClock(): TestClock {
  let now = START_MS;
  const clock = new ReplayClock(() => now);
  return {
    clock,
    advance: (ms) => void (now += ms),
    set: (tick) => {
      const { speed } = clock.state();
      now += ((tick - clock.tick()) * config.TICK_MS) / speed;
    },
  };
}

export interface TestApp {
  app: Express;
  db: Db;
  warehouse: Warehouse;
  deps: ApiDeps;
  clock: TestClock;
  /** Direct SQL against the same in-memory warehouse, for independent expectations. */
  sql<T>(query: string): Promise<T[]>;
  close(): void;
}

/**
 * The real CSV ingested into an in-memory warehouse, the SQL suite run and stored (like
 * `npm run ingest`), and the app wired to it at tick 19. Takes ~1.5 s; build once per file.
 */
export async function buildTestApp(): Promise<TestApp> {
  const db = await openDb(':memory:');
  await runIngest(db.conn, fs.readFileSync(RAW_CSV, 'utf8'));
  await runSqlSuite(db.conn);
  const warehouse = new Warehouse(db.conn);
  const clock = testClock();
  const alerts = await AlertEngine.load(warehouse);
  const deps = createDeps(warehouse, clock.clock, alerts);
  return {
    app: createApp(deps),
    db,
    warehouse,
    deps,
    clock,
    sql: (query) => all(db.conn, query),
    close: () => closeDb(db),
  };
}
