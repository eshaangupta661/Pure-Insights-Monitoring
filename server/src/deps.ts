import type { Warehouse } from './data/warehouse.js';
import type { ReplayClock } from './realtime/clock.js';
import type { AlertEngine } from './realtime/engine.js';
import { RealtimeHub } from './realtime/hub.js';

/** Everything the API handlers need at request time. Built in index.ts and by the test helper. */
export interface ApiDeps {
  warehouse: Warehouse;
  /** The replay position (current snapshot); pause/resume/speed via /admin/replay. */
  clock: ReplayClock;
  alerts: AlertEngine;
  /** Syncs the alert state and broadcasts changes; all alert-state changes go through it. */
  realtime: RealtimeHub;
}

export function createDeps(warehouse: Warehouse, clock: ReplayClock, alerts: AlertEngine): ApiDeps {
  return { warehouse, clock, alerts, realtime: new RealtimeHub(warehouse, clock, alerts) };
}

/**
 * The alert engine brought up to the clock's current tick. Goes through the hub, so whatever
 * the sync changes is broadcast (a request can be the first to cross a tick boundary).
 */
export function syncedAlerts(deps: ApiDeps): Promise<AlertEngine> {
  return deps.realtime.sync();
}
