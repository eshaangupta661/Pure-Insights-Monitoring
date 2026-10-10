import fs from 'node:fs';
import { config } from './config.js';
import { Warehouse } from './data/warehouse.js';
import { closeDb, openDb } from './db.js';
import { WAREHOUSE_PATH } from './paths.js';
import { ReplayClock } from './realtime/clock.js';
import { AlertEngine } from './realtime/engine.js';
import { createServer } from './server.js';
import { loadSqlResults, reconciliationTable } from './sql/runner.js';

/**
 * Refuses to start unless the warehouse exists and its stored SQL results are current and all
 * PASS (see server/src/sql/runner.ts). The connection stays open for the API, which reaches it
 * only through the Warehouse queue.
 */
async function main(): Promise<void> {
  if (!fs.existsSync(WAREHOUSE_PATH)) {
    console.error(`${WAREHOUSE_PATH} not found; run \`npm run ingest\` first.`);
    process.exit(1);
  }
  const db = await openDb(WAREHOUSE_PATH);
  try {
    const results = await loadSqlResults(db.conn);
    console.log(
      `SQL results loaded from the warehouse in ${results.durationMs} ms; ` +
        `${results.views.RECONCILIATION.length} reconciliation checks PASS:`,
    );
    console.table(reconciliationTable(results));
  } catch (err) {
    console.error('Startup aborted: the cost attribution results cannot be trusted.');
    console.error(err instanceof Error ? err.message : err);
    closeDb(db);
    process.exit(1);
  }

  if (config.jwtSecretSource === 'random-per-process') {
    console.warn(
      'JWT_SECRET is not set: using a random signing key for this process. Sessions end on ' +
        'restart. Set JWT_SECRET (and NODE_ENV=production) for a real deployment.',
    );
  }

  const warehouse = new Warehouse(db.conn);
  const clock = new ReplayClock();
  // Readings load once; from here on the alert state is rebuilt synchronously from them.
  const alerts = await AlertEngine.load(warehouse);
  alerts.syncTo(clock.position());

  const server = createServer({ warehouse, clock, alerts });
  server.listen(config.port, () => {
    console.log(`Server listening on http://localhost:${config.port}`);
  });
}

await main();
