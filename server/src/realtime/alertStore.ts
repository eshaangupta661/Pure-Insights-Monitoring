/*
 * Alert lifecycle for one replay cycle. Deterministic and synchronous: the same readings in the
 * same order always produce the same alerts, which is what makes the state rebuildable.
 *
 *   OPEN ──ack──▶ ACKNOWLEDGED
 *     │                │
 *     └── ALERT_AUTO_RESOLVE_TICKS consecutive healthy ticks ──▶ RESOLVED
 *
 * - Dedup key (reportId, ruleId): while an alert for the key is OPEN or ACKNOWLEDGED, a new
 *   violation updates it (lastSeenTick; value and message if it is a new peak) instead of
 *   opening another.
 * - Severity only escalates (WARNING → CRITICAL emits an update); a milder reading keeps it.
 *   An acknowledged alert stays ACKNOWLEDGED when it escalates.
 * - After RESOLVED, the key can't reopen for ALERT_COOLDOWN_TICKS ticks. Injected incidents
 *   (synthetic readings) bypass the cooldown so a demo always produces an alert.
 *
 * ownerEmail is left null here; the engine fills in the report's current owner when reading.
 */
import type { Alert } from '@pic/shared';
import { config } from '../config.js';
import { ReplayClock } from './clock.js';
import { ALERT_RULE_IDS, SEVERITY_RANK, evaluateReading, type Reading } from './rules.js';

export interface TickEvents {
  opened: Alert[];
  updated: Alert[];
}

export type AckResult =
  { ok: true; alert: Alert; changed: boolean } | { ok: false; reason: 'NOT_FOUND' | 'RESOLVED' };

const keyOf = (reportId: string, ruleId: string) => `${reportId}|${ruleId}`;

export class AlertStore {
  /** Every alert of this cycle by id, resolved ones included. */
  private readonly alerts = new Map<string, Alert>();
  /** key → id of its OPEN/ACKNOWLEDGED alert. */
  private readonly active = new Map<string, string>();
  /** key → consecutive healthy ticks while active. */
  private readonly healthyStreak = new Map<string, number>();
  /** key → tick its last alert resolved. */
  private readonly resolvedAt = new Map<string, number>();

  constructor(readonly cycle: number) {}

  /** Applies one tick's readings (one per report). Returns copies of what changed. */
  applyTick(tick: number, readings: readonly Reading[]): TickEvents {
    const events: TickEvents = { opened: [], updated: [] };
    for (const reading of readings) {
      const violations = new Map(evaluateReading(reading).map((v) => [v.ruleId, v]));
      for (const ruleId of ALERT_RULE_IDS) {
        const key = keyOf(reading.reportId, ruleId);
        const violation = violations.get(ruleId);
        const activeId = this.active.get(key);
        const current = activeId === undefined ? undefined : this.alerts.get(activeId);

        if (violation && current) {
          this.healthyStreak.set(key, 0);
          current.lastSeenTick = tick;
          const escalates = SEVERITY_RANK[violation.severity] > SEVERITY_RANK[current.severity];
          // value/message track the peak while active, so they always agree with each other
          // and with the severity's threshold. Only an escalation is worth an update event.
          if (escalates || violation.value > current.value) {
            current.value = violation.value;
            current.message = violation.message;
          }
          if (escalates) {
            current.severity = violation.severity;
            current.threshold = violation.threshold;
            events.updated.push({ ...current });
          }
        } else if (violation) {
          if (!reading.synthetic && this.inCooldown(key, tick)) continue;
          const alert: Alert = {
            id: `${this.cycle}-${reading.reportId}-${ruleId}-${tick}`,
            reportId: reading.reportId,
            reportName: reading.reportName,
            ownerEmail: null,
            ruleId,
            severity: violation.severity,
            status: 'OPEN',
            message: violation.message,
            value: violation.value,
            threshold: violation.threshold,
            openedTick: tick,
            openedAt: new Date(ReplayClock.startOf({ tick, cycle: this.cycle })).toISOString(),
            lastSeenTick: tick,
            synthetic: reading.synthetic,
          };
          this.alerts.set(alert.id, alert);
          this.active.set(key, alert.id);
          this.healthyStreak.set(key, 0);
          events.opened.push({ ...alert });
        } else if (current) {
          const streak = (this.healthyStreak.get(key) ?? 0) + 1;
          this.healthyStreak.set(key, streak);
          if (streak >= config.ALERT_AUTO_RESOLVE_TICKS) {
            current.status = 'RESOLVED';
            current.resolvedTick = tick;
            this.active.delete(key);
            this.resolvedAt.set(key, tick);
            events.updated.push({ ...current });
          }
        }
      }
    }
    return events;
  }

  /** OPEN → ACKNOWLEDGED. Acking an acknowledged alert is a no-op (changed: false). */
  ack(id: string, by: string): AckResult {
    const alert = this.alerts.get(id);
    if (!alert) return { ok: false, reason: 'NOT_FOUND' };
    if (alert.status === 'RESOLVED') return { ok: false, reason: 'RESOLVED' };
    if (alert.status === 'ACKNOWLEDGED') return { ok: true, alert: { ...alert }, changed: false };
    alert.status = 'ACKNOWLEDGED';
    alert.ackedBy = by;
    return { ok: true, alert: { ...alert }, changed: true };
  }

  get(id: string): Alert | undefined {
    const alert = this.alerts.get(id);
    return alert && { ...alert };
  }

  /** The OPEN/ACKNOWLEDGED alert for a key, if any. */
  activeFor(reportId: string, ruleId: string): Alert | undefined {
    const id = this.active.get(keyOf(reportId, ruleId));
    return id === undefined ? undefined : this.get(id);
  }

  all(): Alert[] {
    return [...this.alerts.values()].map((a) => ({ ...a }));
  }

  private inCooldown(key: string, tick: number): boolean {
    const resolved = this.resolvedAt.get(key);
    return resolved !== undefined && tick - resolved < config.ALERT_COOLDOWN_TICKS;
  }
}
