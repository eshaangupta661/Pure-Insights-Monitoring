import type { Alert, Role } from '@pic/shared';

/** The bell keeps this many notifications, newest first. */
export const BELL_LIMIT = 20;
/** A critical pop-up card closes itself after this long (paused while hovered). */
export const POPUP_MS = 8000;
/** Queued pop-ups beyond this are dropped (they are still in the bell). */
export const POPUP_QUEUE_LIMIT = 50;
export const MUTE_POPUPS_KEY = 'pic.mutePopups';

export interface Notification {
  /** `${alert.id}:${alert.severity}`: one notification per alert and severity (an escalation is news). */
  key: string;
  alert: Alert;
  read: boolean;
}

export type Delivery = 'bell' | 'bell+popup';

export const notificationKey = (a: Alert): string => `${a.id}:${a.severity}`;

/**
 * Where a live alert event goes. Every WARNING (latency > 15 s) and CRITICAL (latency > 30 s,
 * failed or timed-out refresh) alert that opens or escalates notifies once; CRITICAL also pops
 * up. INFO, resolutions, acks and anything already notified (`seen` keys) don't.
 */
export function deliveryFor(alert: Alert, seen: ReadonlySet<string>): Delivery | null {
  if (alert.status === 'RESOLVED' || alert.severity === 'INFO') return null;
  if (seen.has(notificationKey(alert))) return null;
  return alert.severity === 'CRITICAL' ? 'bell+popup' : 'bell';
}

/** Adds `alert` to the front of the bell list, replacing an older entry for the same key. */
export function pushNotification(list: readonly Notification[], alert: Alert): Notification[] {
  const key = notificationKey(alert);
  return [{ key, alert, read: false }, ...list.filter((n) => n.key !== key)].slice(0, BELL_LIMIT);
}

export const unreadCount = (list: readonly Notification[]): number =>
  list.filter((n) => !n.read).length;

export function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th'}`;
}

/** "3rd snapshot in a row", or "First snapshot" when the breach is new. */
export const streakLabel = (streak: number): string =>
  streak <= 1 ? 'First snapshot' : `${ordinal(streak)} snapshot in a row`;

/** "42.1 s vs 30 s limit" for latency; the refresh status for refresh rules (value is a flag). */
export function valueVsThreshold(a: Alert): string {
  if (a.ruleId === 'LATENCY') return `${a.value.toFixed(1)} s vs ${a.threshold} s limit`;
  return a.message;
}

/** Admins can acknowledge any alert; owners only those on their reports; viewers none. */
export function canAck(user: { role: Role; email: string }, a: Alert): boolean {
  if (a.status !== 'OPEN') return false;
  return user.role === 'admin' || (user.role === 'owner' && a.ownerEmail === user.email);
}

/** localStorage can be missing or throw (private mode, blocked storage): fall back to unmuted. */
export function readMuted(): boolean {
  try {
    return localStorage.getItem(MUTE_POPUPS_KEY) === '1';
  } catch {
    return false;
  }
}

export function writeMuted(muted: boolean): void {
  try {
    localStorage.setItem(MUTE_POPUPS_KEY, muted ? '1' : '0');
  } catch {
    // Not persisted; the toggle still works for this page load.
  }
}
