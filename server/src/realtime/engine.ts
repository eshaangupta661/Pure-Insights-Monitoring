/*
 * AlertEngine: the alert state for the replay's current position, rebuildable from data.
 *
 * - Readings (the 2,000 snapshot rows) and the owner map load once, asynchronously (load()).
 *   After that, syncTo() is fully synchronous: no I/O, no await.
 * - syncTo(position) applies each tick since the last sync in order. On a new cycle (the replay
 *   wrapped to snapshot 0) or a backwards move it rebuilds by replaying ticks 0..tick.
 * - Acks and injected incidents are kept in memory with the (cycle, tick) they happened at and
 *   are re-applied at that point on every rebuild, so a rebuild reproduces them. Both are
 *   dropped when the cycle changes: alert ids include the cycle, so acks reset when the replay
 *   wraps to snapshot 0 (a documented limitation), and a restart forgets them.
 * - ownerEmail is resolved from the current owner map at read time, so scoping follows admin
 *   overrides without touching alerts (refreshOwners() after a PATCH).
 *
 * The engine needs every report's readings and owner regardless of who asks, so it loads them
 * unscoped; every read method takes the caller's Scope.
 */
import type {
  Alert,
  ActiveAlertCounts,
  AlertStatus,
  AuthUser,
  IncidentKind,
  Severity,
} from '@pic/shared';
import { scopeMatches, type Scope } from '../auth/scope.js';
import { config } from '../config.js';
import type { Queryable } from '../data/warehouse.js';
import { AlertStore, type TickEvents } from './alertStore.js';
import type { ReplayPosition } from './clock.js';
import { SEVERITY_RANK, type Reading } from './rules.js';

export interface AlertEvents extends TickEvents {
  /** True when the state was rebuilt (replayed from tick 0) rather than stepped forward. */
  rebuilt: boolean;
  /**
   * True when the rebuild started from nothing (first sync, or the replay wrapped to a new
   * cycle): `opened` then lists every alert, and clients should replace their list instead.
   */
  reset: boolean;
}

export interface Incident {
  reportId: string;
  kind: IncidentKind;
  cycle: number;
  tick: number;
}

export interface AckRecord {
  alertId: string;
  by: string;
  cycle: number;
  tick: number;
}

export type EngineAckResult =
  /** `record` is set when this call acknowledged the alert; pass it to withdrawAck() to undo. */
  | { ok: true; alert: Alert; changed: boolean; record: AckRecord | null }
  | { ok: false; reason: 'NOT_FOUND' | 'RESOLVED' };

/** Too many incidents in this replay cycle (config.INCIDENTS_MAX_PER_CYCLE). */
export class IncidentLimitError extends Error {
  override name = 'IncidentLimitError';
}

export interface IncidentResult {
  alert: Alert;
  events: AlertEvents;
  /** The incident recorded by this call; null if an identical one already existed (no-op). */
  incident: Incident | null;
}

const STATUS_ORDER: Record<AlertStatus, number> = { OPEN: 0, ACKNOWLEDGED: 1, RESOLVED: 2 };
const NO_EVENTS = (): AlertEvents => ({ opened: [], updated: [], rebuilt: false, reset: false });

/** Fields whose change is worth an `alert:updated` (not lastSeenTick/value, which move every tick). */
const signature = (a: Alert) => `${a.status}|${a.severity}|${a.ackedBy ?? ''}|${a.synthetic}`;

export class AlertEngine {
  private store: AlertStore | null = null;
  private at: ReplayPosition | null = null;
  private acks: AckRecord[] = [];
  private incidents: Incident[] = [];
  /** Set when an owner refresh failed; the next syncedAlerts() retries it. */
  private ownersStale = false;

  /** `readingsByTick[t]` has one reading per report for snapshot t. */
  constructor(
    private readonly readingsByTick: readonly (readonly Reading[])[],
    private owners: ReadonlyMap<string, string | null>,
    private readonly maxIncidents: number = config.INCIDENTS_MAX_PER_CYCLE,
  ) {
    if (readingsByTick.length !== config.SNAPSHOT_COUNT) {
      throw new Error(
        `expected ${config.SNAPSHOT_COUNT} snapshots of readings, got ${readingsByTick.length}`,
      );
    }
  }

  static async load(db: Queryable): Promise<AlertEngine> {
    const rows = await db.query<{
      snapshotIdx: number;
      reportId: string;
      reportName: string;
      refreshStatus: Reading['refreshStatus'];
      loadTimeSec: number;
    }>(
      `SELECT snapshot_idx AS "snapshotIdx", report_id AS "reportId", report_name AS "reportName",
              last_refresh_status AS "refreshStatus", avg_load_time_sec AS "loadTimeSec"
       FROM REPORT_SNAPSHOTS ORDER BY snapshot_idx, report_id`,
    );
    const byTick: Reading[][] = Array.from({ length: config.SNAPSHOT_COUNT }, () => []);
    for (const { snapshotIdx, ...r } of rows) byTick[snapshotIdx]?.push({ ...r, synthetic: false });
    return new AlertEngine(byTick, await loadOwners(db));
  }

  /** Re-reads REPORT_CURRENT_OWNER (after an owner override). */
  async refreshOwners(db: Queryable): Promise<void> {
    this.owners = await loadOwners(db);
    this.ownersStale = false;
  }

  /** The owner map may be out of date (a refresh after an override failed). */
  markOwnersStale(): void {
    this.ownersStale = true;
  }

  get needsOwnerRefresh(): boolean {
    return this.ownersStale;
  }

  hasReport(reportId: string): boolean {
    return this.owners.has(reportId);
  }

  position(): ReplayPosition | null {
    return this.at && { ...this.at };
  }

  /** Brings the state to `pos`. Synchronous; a no-op when already there. */
  syncTo(pos: ReplayPosition): AlertEvents {
    const at = this.at;
    if (at && at.cycle === pos.cycle && at.tick === pos.tick) return NO_EVENTS();
    if (!at || !this.store || at.cycle !== pos.cycle || pos.tick < at.tick)
      return this.rebuild(pos);

    const events = NO_EVENTS();
    for (let t = at.tick + 1; t <= pos.tick; t++) {
      const step = this.applyStep(this.store, t);
      events.opened.push(...step.opened);
      events.updated.push(...step.updated);
    }
    this.at = { ...pos };
    return this.withOwners(events);
  }

  /**
   * Replays ticks 0..pos.tick of pos.cycle from scratch. Within the same cycle, returns what
   * changed against the previous state (so an incident can be broadcast as opened/updated).
   */
  rebuild(pos: ReplayPosition): AlertEvents {
    const previous = this.store?.cycle === pos.cycle ? this.store : null;
    this.acks = this.acks.filter((a) => a.cycle === pos.cycle);
    this.incidents = this.incidents.filter((i) => i.cycle === pos.cycle);

    const store = new AlertStore(pos.cycle);
    for (let t = 0; t <= pos.tick; t++) this.applyStep(store, t);
    this.store = store;
    this.at = { ...pos };

    const events: AlertEvents = {
      opened: [],
      updated: [],
      rebuilt: true,
      reset: previous === null,
    };
    const before = new Map((previous?.all() ?? []).map((a) => [a.id, signature(a)]));
    for (const alert of store.all()) {
      const was = before.get(alert.id);
      if (was === undefined) events.opened.push(alert);
      else if (was !== signature(alert)) events.updated.push(alert);
    }
    return this.withOwners(events);
  }

  /** Alerts of the current cycle visible to `scope`: active first, then most severe, newest. */
  list(scope: Scope, filter: { status?: AlertStatus; severity?: Severity } = {}): Alert[] {
    return this.requireStore()
      .all()
      .map((a) => this.view(a))
      .filter(
        (a) =>
          scopeMatches(scope, a.ownerEmail) &&
          (filter.status === undefined || a.status === filter.status) &&
          (filter.severity === undefined || a.severity === filter.severity),
      )
      .sort(
        (a, b) =>
          STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
          SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
          b.lastSeenTick - a.lastSeenTick ||
          a.id.localeCompare(b.id),
      );
  }

  counts(scope: Scope): ActiveAlertCounts {
    const counts: ActiveAlertCounts = {
      total: 0,
      open: 0,
      acknowledged: 0,
      INFO: 0,
      WARNING: 0,
      CRITICAL: 0,
    };
    for (const a of this.list(scope)) {
      if (a.status === 'RESOLVED') continue;
      counts.total++;
      counts[a.status === 'OPEN' ? 'open' : 'acknowledged']++;
      counts[a.severity]++;
    }
    return counts;
  }

  /** Acknowledge as `user`. Alerts outside `scope` are NOT_FOUND (no existence leak). */
  ack(alertId: string, user: AuthUser, scope: Scope): EngineAckResult {
    const store = this.requireStore();
    const existing = store.get(alertId);
    if (!existing || !scopeMatches(scope, this.ownerOf(existing.reportId))) {
      return { ok: false, reason: 'NOT_FOUND' };
    }
    const result = store.ack(alertId, user.email);
    if (!result.ok) return result;
    let record: AckRecord | null = null;
    if (result.changed && this.at) {
      record = { alertId, by: user.email, cycle: this.at.cycle, tick: this.at.tick };
      this.acks.push(record);
    }
    return { ...result, alert: this.view(result.alert), record };
  }

  /** Undoes an ack (e.g. its audit row could not be written): drop it and rebuild. */
  withdrawAck(record: AckRecord): void {
    this.acks = this.acks.filter((a) => a !== record);
    if (this.at) this.rebuild(this.at);
  }

  /**
   * Adds a synthetic reading for `reportId` at the current tick and rebuilds, so the incident is
   * part of the replayable history. Returns the resulting active alert and the change events.
   */
  injectIncident(reportId: string, kind: IncidentKind): IncidentResult {
    const at = this.at;
    if (!at) throw new Error('syncTo() before injecting incidents');
    const ruleId = kind === 'LATENCY_SPIKE' ? 'LATENCY' : 'REFRESH_FAILED';
    // An identical incident (same report, kind and tick) changes nothing, so it isn't stored:
    // the list stays bounded even while the replay is paused on one tick.
    const duplicate = this.incidents.some(
      (i) =>
        i.cycle === at.cycle && i.tick === at.tick && i.reportId === reportId && i.kind === kind,
    );
    if (duplicate) {
      const alert = this.requireStore().activeFor(reportId, ruleId);
      if (alert) return { alert: this.view(alert), events: NO_EVENTS(), incident: null };
    }
    if (this.incidents.length >= this.maxIncidents) {
      throw new IncidentLimitError(
        `At most ${this.maxIncidents} incidents per replay cycle; they reset when it wraps`,
      );
    }
    const incident: Incident = { reportId, kind, cycle: at.cycle, tick: at.tick };
    this.incidents.push(incident);
    const events = this.rebuild(at);
    const alert = this.requireStore().activeFor(reportId, ruleId);
    if (!alert) throw new Error(`incident on ${reportId} produced no ${ruleId} alert`);
    return { alert: this.view(alert), events, incident };
  }

  /** Undoes an injected incident (e.g. its audit row could not be written). */
  withdrawIncident(incident: Incident): void {
    this.incidents = this.incidents.filter((i) => i !== incident);
    if (this.at) this.rebuild(this.at);
  }

  private applyStep(store: AlertStore, tick: number): TickEvents {
    const events = store.applyTick(tick, this.readingsAt(store.cycle, tick));
    for (const ack of this.acks) {
      if (ack.cycle === store.cycle && ack.tick === tick) store.ack(ack.alertId, ack.by);
    }
    return events;
  }

  /** The snapshot's readings with any incidents of (cycle, tick) applied on top. */
  private readingsAt(cycle: number, tick: number): readonly Reading[] {
    const base = this.readingsByTick[tick] ?? [];
    const here = this.incidents.filter((i) => i.cycle === cycle && i.tick === tick);
    if (here.length === 0) return base;
    return base.map((reading) => {
      const mine = here.filter((i) => i.reportId === reading.reportId);
      if (mine.length === 0) return reading;
      return mine.reduce<Reading>(
        (r, i) =>
          i.kind === 'LATENCY_SPIKE'
            ? { ...r, loadTimeSec: config.INCIDENT_LATENCY_SEC, synthetic: true }
            : { ...r, refreshStatus: 'FAILED', synthetic: true },
        reading,
      );
    });
  }

  private ownerOf(reportId: string): string | null {
    return this.owners.get(reportId) ?? null;
  }

  private view(alert: Alert): Alert {
    return { ...alert, ownerEmail: this.ownerOf(alert.reportId) };
  }

  private withOwners(events: AlertEvents): AlertEvents {
    return {
      ...events,
      opened: events.opened.map((a) => this.view(a)),
      updated: events.updated.map((a) => this.view(a)),
    };
  }

  private requireStore(): AlertStore {
    if (!this.store) throw new Error('AlertEngine used before syncTo()');
    return this.store;
  }
}

async function loadOwners(db: Queryable): Promise<Map<string, string | null>> {
  const rows = await db.query<{ reportId: string; owner: string | null }>(
    'SELECT report_id AS "reportId", current_owner AS owner FROM REPORT_CURRENT_OWNER',
  );
  return new Map(rows.map((r) => [r.reportId, r.owner]));
}
