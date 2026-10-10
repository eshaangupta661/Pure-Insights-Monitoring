import type { Warehouse } from './data/warehouse.js';
import type { ReplayClock } from './realtime/clock.js';
import type { AlertEngine } from './realtime/engine.js';

/** Everything the API handlers need at request time. Built in index.ts and by the test helper. */
export interface ApiDeps {
  warehouse: Warehouse;
  /** The replay position (current snapshot); pause/resume/speed via /admin/replay. */
  clock: ReplayClock;
  alerts: AlertEngine;
}

/**
 * The alert engine brought up to the clock's current tick. Async only to retry an owner map
 * left stale by a failed refresh after an override; syncTo() itself is synchronous.
 */
export async function syncedAlerts(deps: ApiDeps): Promise<AlertEngine> {
  if (deps.alerts.needsOwnerRefresh) await deps.alerts.refreshOwners(deps.warehouse);
  deps.alerts.syncTo(deps.clock.position());
  return deps.alerts;
}
