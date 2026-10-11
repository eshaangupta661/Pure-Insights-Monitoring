import type { Alert } from '@pic/shared';
import { describe, expect, it } from 'vitest';
import {
  BELL_LIMIT,
  canAck,
  deliveryFor,
  notificationKey,
  ordinal,
  pushNotification,
  streakLabel,
  unreadCount,
  valueVsThreshold,
} from '../../../client/src/lib/notifications.js';

const alert = (over: Partial<Alert> = {}): Alert => ({
  id: '0-RPT_1-LATENCY-3',
  reportId: 'RPT_1',
  reportName: 'Report 1',
  ownerEmail: 'user_3@company.com',
  ruleId: 'LATENCY',
  severity: 'WARNING',
  status: 'OPEN',
  message: 'Load time 20s > 15s',
  value: 20,
  threshold: 15,
  openedTick: 3,
  openedAt: '2026-09-24T00:00:00.000Z',
  lastSeenTick: 3,
  streak: 1,
  synthetic: false,
  ...over,
});

describe('notification routing (client/src/lib/notifications.ts)', () => {
  it('WARNING goes to the bell, CRITICAL to the bell and a pop-up; INFO and RESOLVED nowhere', () => {
    const none = new Set<string>();
    expect(deliveryFor(alert(), none)).toBe('bell');
    expect(deliveryFor(alert({ severity: 'CRITICAL' }), none)).toBe('bell+popup');
    expect(deliveryFor(alert({ ruleId: 'REFRESH_FAILED', severity: 'CRITICAL' }), none)).toBe(
      'bell+popup',
    );
    expect(deliveryFor(alert({ ruleId: 'REFRESH_UNKNOWN', severity: 'INFO' }), none)).toBeNull();
    expect(deliveryFor(alert({ status: 'RESOLVED' }), none)).toBeNull();
  });

  it('notifies once per alert and severity: an ack is not news, an escalation is', () => {
    const warning = alert();
    const seen = new Set([notificationKey(warning)]);
    expect(deliveryFor({ ...warning, status: 'ACKNOWLEDGED' }, seen)).toBeNull();
    expect(deliveryFor({ ...warning, status: 'ACKNOWLEDGED', severity: 'CRITICAL' }, seen)).toBe(
      'bell+popup',
    );
  });

  it(`keeps the ${BELL_LIMIT} most recent, newest first, all unread`, () => {
    let list = pushNotification([], alert({ id: 'a0' }));
    for (let i = 1; i < BELL_LIMIT + 5; i++) list = pushNotification(list, alert({ id: `a${i}` }));
    expect(list).toHaveLength(BELL_LIMIT);
    expect(list[0]!.alert.id).toBe(`a${BELL_LIMIT + 4}`);
    expect(unreadCount(list)).toBe(BELL_LIMIT);
    expect(unreadCount(list.map((n) => ({ ...n, read: true })))).toBe(0);
  });

  it('labels streaks and values', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23].map(ordinal)).toEqual([
      '1st',
      '2nd',
      '3rd',
      '4th',
      '11th',
      '12th',
      '13th',
      '21st',
      '22nd',
      '23rd',
    ]);
    expect(streakLabel(1)).toBe('First snapshot');
    expect(streakLabel(3)).toBe('3rd snapshot in a row');
    expect(valueVsThreshold(alert({ value: 42.14, threshold: 30 }))).toBe('42.1 s vs 30 s limit');
    expect(
      valueVsThreshold(alert({ ruleId: 'REFRESH_FAILED', message: 'Refresh TIMED_OUT' })),
    ).toBe('Refresh TIMED_OUT');
  });

  it('Acknowledge: admin any open alert, owner only their own, viewer never', () => {
    const admin = { role: 'admin' as const, email: 'admin@pureinsights.dev' };
    const owner = { role: 'owner' as const, email: 'user_3@company.com' };
    const viewer = { role: 'viewer' as const, email: 'viewer@pureinsights.dev' };
    expect(canAck(admin, alert({ ownerEmail: null }))).toBe(true);
    expect(canAck(owner, alert())).toBe(true);
    expect(canAck(owner, alert({ ownerEmail: 'user_1@company.com' }))).toBe(false);
    expect(canAck(viewer, alert())).toBe(false);
    expect(canAck(admin, alert({ status: 'ACKNOWLEDGED' }))).toBe(false);
  });
});
