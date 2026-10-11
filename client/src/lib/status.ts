import type { RefreshStatus } from '@pic/shared';

/**
 * Refresh-status colours, used everywhere a status is shown (badges, the report drawer strip,
 * the Overview chart): Success green, Failed red, Timed out orange, Unknown neutral grey.
 *
 * Pure data with no React or DOM imports, so server/test/ui/status-colors.test.ts can check the
 * contrast: `text` on `soft` (badges) is at least 4.5:1, `fill` on white (chart marks, dots) at
 * least 3:1. Colour is never the only cue: every use also carries the status label.
 */
export interface StatusStyle {
  label: string;
  /** Badge text; dark enough for body text on `soft`. */
  text: string;
  /** Badge background tint. */
  soft: string;
  /** Marks: dots, chart bars, strips. */
  fill: string;
}

export const STATUS_STYLE: Record<RefreshStatus, StatusStyle> = {
  SUCCESS: { label: 'Success', text: '#166534', soft: '#f0fdf4', fill: '#16a34a' },
  FAILED: { label: 'Failed', text: '#991b1b', soft: '#fef2f2', fill: '#b91c1c' },
  TIMED_OUT: { label: 'Timed out', text: '#9a3412', soft: '#fff7ed', fill: '#ea580c' },
  UNKNOWN: { label: 'Unknown', text: '#404040', soft: '#f5f5f5', fill: '#737373' },
};

/** Chart/legend order. */
export const STATUS_ORDER: readonly RefreshStatus[] = ['SUCCESS', 'FAILED', 'TIMED_OUT', 'UNKNOWN'];
