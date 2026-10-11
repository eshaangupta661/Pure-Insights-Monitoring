import type { RefreshStatus } from '@pic/shared';
import { describe, expect, it } from 'vitest';
import { STATUS_ORDER, STATUS_STYLE } from '../../../client/src/lib/status.js';

/** WCAG 2.x relative luminance and contrast ratio for #rrggbb colours. */
function luminance(hex: string): number {
  const channel = (i: number) => {
    const c = parseInt(hex.slice(1 + 2 * i, 3 + 2 * i), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

const WHITE = '#ffffff';

describe('refresh status colours (client/src/lib/status.ts)', () => {
  it('covers every refresh status, in a fixed order', () => {
    const all: RefreshStatus[] = ['SUCCESS', 'FAILED', 'TIMED_OUT', 'UNKNOWN'];
    expect([...STATUS_ORDER]).toEqual(all);
    expect(Object.keys(STATUS_STYLE).sort()).toEqual([...all].sort());
  });

  it.each(STATUS_ORDER)('%s: badge text is readable on its tint (>= 4.5:1)', (status) => {
    const { text, soft } = STATUS_STYLE[status];
    expect(contrast(text, soft)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(text, WHITE)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(STATUS_ORDER)('%s: chart marks stand out from a white background (>= 3:1)', (status) => {
    expect(contrast(STATUS_STYLE[status].fill, WHITE)).toBeGreaterThanOrEqual(3);
  });

  it('Success is green, Failed red, Timed out orange and Unknown neutral grey', () => {
    const hue = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
      const max = Math.max(r!, g!, b!);
      const min = Math.min(r!, g!, b!);
      if (max === min) return { saturation: 0, degrees: 0 };
      const d = max - min;
      const h = max === r ? ((g! - b!) / d) % 6 : max === g ? (b! - r!) / d + 2 : (r! - g!) / d + 4;
      return { saturation: d / max, degrees: (h * 60 + 360) % 360 };
    };
    for (const key of ['fill', 'text'] as const) {
      const green = hue(STATUS_STYLE.SUCCESS[key]);
      const red = hue(STATUS_STYLE.FAILED[key]);
      const orange = hue(STATUS_STYLE.TIMED_OUT[key]);
      expect(green.degrees).toBeGreaterThan(90);
      expect(green.degrees).toBeLessThan(160);
      expect(red.degrees === 0 || red.degrees > 345 || red.degrees < 10).toBe(true);
      expect(orange.degrees).toBeGreaterThan(12);
      expect(orange.degrees).toBeLessThan(35);
      expect(hue(STATUS_STYLE.UNKNOWN[key]).saturation).toBeLessThan(0.2);
    }
  });

  it('the four marks are visually distinct from each other', () => {
    const fills = STATUS_ORDER.map((s) => STATUS_STYLE[s].fill);
    expect(new Set(fills).size).toBe(4);
    // Red and orange are the close pair: they must differ in lightness too, not hue alone.
    expect(
      Math.abs(luminance(STATUS_STYLE.FAILED.fill) - luminance(STATUS_STYLE.TIMED_OUT.fill)),
    ).toBeGreaterThan(0.05);
  });
});
