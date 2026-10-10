import fs from 'node:fs';
import { config } from './config.js';
import { closeDb, openDb } from './db.js';
import { WAREHOUSE_PATH } from './paths.js';
import { server } from './server.js';
import { loadSqlResults, reconciliationTable } from './sql/runner.js';

/**
 * Refuses to start unless the warehouse exists and its stored SQL results are current and all
 * PASS (see server/src/sql/runner.ts). The connection stays open for the API.
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

  server.listen(config.port, () => {
    console.log(`Server listening on http://localhost:${config.port}`);
  });
}

await main();
