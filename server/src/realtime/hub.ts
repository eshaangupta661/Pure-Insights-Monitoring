/*
 * RealtimeHub: the one place that moves the alert state and tells clients about it.
 *
 * - Every sync goes through sync(), which publishes what AlertEngine.syncTo() returns. A REST
 *   request that happens to cross a tick boundary therefore broadcasts the same events the timer
 *   would have; nothing is swallowed.
 * - Operations that change state and may roll it back (ack, incident, replay command, owner
 *   refresh) run one at a time with sync() on a single promise chain (exclusive()). A timer sync
 *   can never publish between a change and its rollback, and every change is published only after
 *   its audit row is written ("nothing changes unaudited").
 * - The timer (start/stop) wakes at each tick boundary of the replay clock and calls sync(). It
 *   reschedules only after that sync settles, and never after stop().
 *
 * Rooms: owners are in `owner:<email>`, admins and viewers share `all`. Payloads to `all` are
 * therefore viewer-safe by construction: Alert and OverviewKpis carry no per-report cost (their
 * REST routes use the same schema for viewers), and every emitted payload is parsed through that
 * schema, which strips unlisted keys, the same fail-closed rule as http/route.ts.
 *
 * Without attach() (REST tests) nothing is emitted; the state machine behaves the same.
 */
import type { Namespace, Socket } from 'socket.io';
import type {
  Alert,
  AuthUser,
  BulkAckResult,
  BulkAckSkipped,
  ClientToServerEvents,
  IncidentKind,
  OverviewKpis,
  ReplayCommand,
  ReplayState,
  ServerToClientEvents,
  TickEvent,
} from '@pic/shared';
import { alertSchema, overviewSchema } from '../api/schemas.js';
import { scopeFor, type Scope } from '../auth/scope.js';
import type { Queryable } from '../data/warehouse.js';
import { getOverview } from '../repos/overview.js';
import { recordAudit } from '../repos/audit.js';
import type { ReplayClock } from './clock.js';
import type {
  AckRecord,
  AlertEngine,
  AlertEvents,
  EngineAckResult,
  IncidentResult,
} from './engine.js';

export interface SocketData {
  user: AuthUser;
  /** When the session's JWT expires (epoch ms); the socket is disconnected then. */
  expiresAtMs: number;
}
type NoEvents = Record<string, never>;
export type AlertsNamespace = Namespace<
  ClientToServerEvents,
  ServerToClientEvents,
  NoEvents,
  SocketData
>;
export type AlertsSocket = Socket<ClientToServerEvents, ServerToClientEvents, NoEvents, SocketData>;

export const ALL_ROOM = 'all';
const OWNER_ROOM_PREFIX = 'owner:';
export const ownerRoom = (email: string) => `${OWNER_ROOM_PREFIX}${email}`;

/** The one room a user's sockets join. */
export function roomFor(user: AuthUser): string {
  return user.role === 'owner' ? ownerRoom(user.email) : ALL_ROOM;
}

/** The scope of a hub room; null for anything else (e.g. each socket's own id room). */
export function scopeOfRoom(room: string): Scope | null {
  if (room === ALL_ROOM) return { kind: 'all' };
  if (room.startsWith(OWNER_ROOM_PREFIX)) {
    return { kind: 'owner', email: room.slice(OWNER_ROOM_PREFIX.length) };
  }
  return null;
}

/** Rooms that must hear about an alert: everyone unscoped, plus its current owner. */
export function roomsForAlert(alert: Pick<Alert, 'ownerEmail'>): string[] {
  return alert.ownerEmail === null ? [ALL_ROOM] : [ALL_ROOM, ownerRoom(alert.ownerEmail)];
}

export type HubAckResult = EngineAckResult | { ok: false; reason: 'FORBIDDEN' };

/** Fires this long after the computed boundary, so floor() is safely on the new tick. */
const TIMER_SLACK_MS = 5;

export class RealtimeHub {
  private nsp: AlertsNamespace | null = null;
  private lock: Promise<unknown> = Promise.resolve();
  /** `${cycle}|${tick}|${paused}` of the last `tick` event, to emit only on change. */
  private lastTickKey: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private kpiRunning = false;
  private kpiDirty = false;

  constructor(
    private readonly warehouse: Queryable,
    private readonly clock: ReplayClock,
    private readonly alerts: AlertEngine,
  ) {}

  /** Starts broadcasting to `nsp` (socket.ts). */
  attach(nsp: AlertsNamespace): void {
    this.nsp = nsp;
  }

  // ---- state changes (all serialized) ---------------------------------------------------

  /** Brings the alert state to the clock's tick and publishes what changed. */
  sync(): Promise<AlertEngine> {
    return this.exclusive(() => this.syncLocked());
  }

  /** KPIs for the current snapshot in `scope` (GET /overview, kpi:update). */
  async overview(scope: Scope): Promise<OverviewKpis> {
    await this.sync();
    return this.overviewAt(scope);
  }

  /**
   * Acknowledges an alert as `user` (REST and socket). Applied, audited, then published; if the
   * audit row can't be written the ack is withdrawn before anyone hears of it.
   */
  ack(user: AuthUser, alertId: string): Promise<HubAckResult> {
    return this.exclusive(async () => {
      if (user.role === 'viewer') return { ok: false, reason: 'FORBIDDEN' } as const;
      const alerts = await this.syncLocked();
      const result = alerts.ack(alertId, user, scopeFor(user));
      if (!result.ok || !result.record) return result;
      const { reportId, ruleId, severity } = result.alert;
      try {
        await recordAudit(this.warehouse, user, 'ALERT_ACK', alertId, {
          reportId,
          ruleId,
          severity,
          ...alerts.position(),
        });
      } catch (err) {
        alerts.withdrawAcks([result.record]);
        throw err;
      }
      this.emitAlert('alert:updated', result.alert);
      this.refreshKpis();
      return result;
    });
  }

  /**
   * Acknowledges several alerts as `user` in one step (POST /alerts/ack). Each id is checked
   * like a single ack: unknown or out-of-scope ids are NOT_FOUND, resolved ones CONFLICT, and
   * neither stops the others. All changes share ONE ALERT_ACK_BULK audit row; if it can't be
   * written every ack is withdrawn before anyone hears of it.
   */
  ackMany(user: AuthUser, alertIds: readonly string[]): Promise<BulkAckResult> {
    return this.exclusive(async () => {
      const alerts = await this.syncLocked();
      const scope = scopeFor(user);
      const acknowledged: Alert[] = [];
      const skipped: BulkAckSkipped[] = [];
      const records: AckRecord[] = [];
      for (const alertId of new Set(alertIds)) {
        const result = alerts.ack(alertId, user, scope);
        if (!result.ok) {
          skipped.push(
            result.reason === 'RESOLVED'
              ? { alertId, code: 'CONFLICT', message: 'Alert is already resolved' }
              : { alertId, code: 'NOT_FOUND', message: 'No such alert' },
          );
          continue;
        }
        acknowledged.push(result.alert);
        if (result.record) records.push(result.record);
      }
      if (records.length === 0) {
        return { acknowledged, newlyAcknowledged: 0, skipped };
      }
      const changed = new Set(records.map((r) => r.alertId));
      try {
        await recordAudit(this.warehouse, user, 'ALERT_ACK_BULK', `${changed.size} alerts`, {
          alertIds: [...changed],
          requested: new Set(alertIds).size,
          skipped: skipped.map((s) => ({ alertId: s.alertId, code: s.code })),
          ...alerts.position(),
        });
      } catch (err) {
        alerts.withdrawAcks(records);
        throw err;
      }
      for (const alert of acknowledged)
        if (changed.has(alert.id)) this.emitAlert('alert:updated', alert);
      this.refreshKpis();
      return { acknowledged, newlyAcknowledged: changed.size, skipped };
    });
  }

  /**
   * Injects a synthetic incident at the current tick (POST /admin/incidents), audits it, then
   * publishes the resulting alert. Throws IncidentLimitError from the engine.
   */
  injectIncident(user: AuthUser, reportId: string, kind: IncidentKind): Promise<IncidentResult> {
    return this.exclusive(async () => {
      const alerts = await this.syncLocked();
      const result = alerts.injectIncident(reportId, kind);
      try {
        await recordAudit(this.warehouse, user, 'INCIDENT_INJECT', reportId, {
          kind,
          alertId: result.alert.id,
          // A repeat of an incident already injected at this tick changes nothing.
          duplicate: result.incident === null,
          ...alerts.position(),
        });
      } catch (err) {
        if (result.incident) alerts.withdrawIncident(result.incident);
        throw err;
      }
      this.publish(result.events);
      return result;
    });
  }

  /**
   * Pause / resume / speed (POST /admin/replay). Moves only the clock's anchors; undone if the
   * audit row can't be written. Then reschedules the timer and broadcasts `tick` (the paused flag).
   */
  replay(user: AuthUser, command: ReplayCommand): Promise<ReplayState> {
    return this.exclusive(async () => {
      await this.syncLocked();
      const saved = this.clock.save();
      const before = this.clock.state();
      if (command.action === 'pause') this.clock.pause();
      else if (command.action === 'resume') this.clock.resume();
      else this.clock.setSpeed(command.value);
      const after = this.clock.state();
      try {
        await recordAudit(this.warehouse, user, 'REPLAY_CONTROL', 'replay', {
          command,
          before: { tick: before.tick, paused: before.paused, speed: before.speed },
          after: { tick: after.tick, paused: after.paused, speed: after.speed },
        });
      } catch (err) {
        // Nothing changes unaudited: put the clock back on its previous timeline.
        this.clock.restore(saved);
        throw err;
      }
      this.schedule();
      await this.syncLocked();
      return after;
    });
  }

  /**
   * After an owner override: re-read the owner map and re-send every room its scoped snapshot,
   * since alerts may have moved between owners. If the refresh fails the map is marked stale;
   * the next sync retries it, and syncs fail (publishing nothing) until it succeeds, so no event
   * is routed to a report's former owner.
   */
  ownersChanged(): Promise<void> {
    return this.exclusive(async () => {
      try {
        await this.alerts.refreshOwners(this.warehouse);
      } catch (err) {
        console.error('Owner map refresh failed after an override; will retry', err);
        this.alerts.markOwnersStale();
        return;
      }
      this.resnapshot();
      this.refreshKpis();
    });
  }

  /** A newly connected socket: join its room, then send tick, its snapshot and its KPIs. */
  async welcome(socket: AlertsSocket): Promise<void> {
    const { user } = socket.data;
    const scope = scopeFor(user);
    await this.exclusive(async () => {
      await this.syncLocked();
      // Joined and sent the snapshot atomically: every later event is a delta on top of it.
      await socket.join(roomFor(user));
      socket.emit('tick', this.tickEvent());
      socket.emit('alert:snapshot', this.activeAlerts(scope));
    });
    socket.emit('kpi:update', overviewSchema.parse(await this.overviewAt(scope)));
  }

  // ---- timer ---------------------------------------------------------------------------

  /** Wakes at every tick boundary (index.ts). Tests drive sync() by hand instead. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** (Re)arms the timer for the next boundary at the current speed; none while paused. */
  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.running) return;
    const ms = this.clock.msUntilNextTick();
    if (ms === null) return; // paused: replay() reschedules on resume
    this.timer = setTimeout(() => this.onTimer(), Math.max(0, ms) + TIMER_SLACK_MS);
    this.timer.unref();
  }

  private onTimer(): void {
    this.timer = null;
    this.sync()
      .catch((err: unknown) => console.error('Replay tick sync failed; retrying next tick', err))
      .finally(() => this.schedule());
  }

  // ---- internals (call only inside exclusive()) ---------------------------------------

  /** Runs `fn` after every earlier hub operation settles; a failure doesn't block later ones. */
  private exclusive<T>(fn: () => Promise<T> | T): Promise<T> {
    const run = this.lock.then(fn);
    this.lock = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async syncLocked(): Promise<AlertEngine> {
    let ownersMoved = false;
    if (this.alerts.needsOwnerRefresh) {
      await this.alerts.refreshOwners(this.warehouse); // throws: publish nothing with stale owners
      ownersMoved = true;
    }
    const events = this.alerts.syncTo(this.clock.position());
    if (ownersMoved && !events.reset) this.resnapshot();
    this.publish(events);
    this.emitTickIfChanged();
    return this.alerts;
  }

  /** Broadcasts engine events. A reset (new cycle) is a fresh snapshot, not N `alert:opened`s. */
  private publish(events: AlertEvents): void {
    if (events.reset) {
      this.resnapshot();
      this.refreshKpis();
      return;
    }
    if (events.opened.length === 0 && events.updated.length === 0) return;
    for (const alert of events.opened) this.emitAlert('alert:opened', alert);
    for (const alert of events.updated) this.emitAlert('alert:updated', alert);
    this.refreshKpis();
  }

  private emitAlert(event: 'alert:opened' | 'alert:updated', alert: Alert): void {
    this.nsp?.to(roomsForAlert(alert)).emit(event, alertSchema.parse(alert));
  }

  /** Every live room gets its scoped active alerts ("replace your list"). */
  private resnapshot(): void {
    if (!this.nsp) return;
    for (const [room, scope] of this.liveRooms()) {
      this.nsp.to(room).emit('alert:snapshot', this.activeAlerts(scope));
    }
  }

  private emitTickIfChanged(): void {
    const { tick, cycle, paused } = this.clock.state();
    const key = `${cycle}|${tick}|${paused}`;
    if (key === this.lastTickKey) return;
    this.lastTickKey = key;
    this.nsp?.emit('tick', this.tickEvent());
    this.refreshKpis();
  }

  private tickEvent(): TickEvent {
    const { tick, snapshotDate, paused } = this.clock.state();
    return { tick, snapshotDate, paused };
  }

  private activeAlerts(scope: Scope): Alert[] {
    return this.alerts
      .list(scope)
      .filter((a) => a.status !== 'RESOLVED')
      .map((a) => alertSchema.parse(a));
  }

  /** Hub rooms that currently have sockets, with their scopes. */
  private liveRooms(): [string, Scope][] {
    if (!this.nsp) return [];
    const rooms: [string, Scope][] = [];
    for (const room of this.nsp.adapter.rooms.keys()) {
      const scope = scopeOfRoom(room);
      if (scope) rooms.push([room, scope]);
    }
    return rooms;
  }

  /** KPIs at the engine's current snapshot, without syncing. */
  private async overviewAt(scope: Scope): Promise<OverviewKpis> {
    const tick = this.alerts.position()?.tick ?? this.clock.tick();
    const counts = this.alerts.counts(scope); // taken before the await, at the same tick
    const kpis = await getOverview(this.warehouse, scope, tick);
    return { ...kpis, alerts: counts };
  }

  /**
   * Recomputes `kpi:update` for every live room, outside the lock (it only reads). Coalesced:
   * while one pass runs, further requests just mark it dirty and one more pass follows.
   */
  private refreshKpis(): void {
    if (!this.nsp) return;
    this.kpiDirty = true;
    if (this.kpiRunning) return;
    this.kpiRunning = true;
    void (async () => {
      try {
        // Start after the current synchronous turn, so the triggers of one sync (events and
        // the tick) share a single pass.
        await Promise.resolve();
        while (this.kpiDirty) {
          this.kpiDirty = false;
          for (const [room, scope] of this.liveRooms()) {
            try {
              const kpis = overviewSchema.parse(await this.overviewAt(scope));
              this.nsp?.to(room).emit('kpi:update', kpis);
            } catch (err) {
              console.error(`kpi:update for ${room} failed`, err);
            }
          }
        }
      } finally {
        this.kpiRunning = false;
      }
    })();
  }
}
