const usd0 = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});
const usd2 = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 2,
});
const int = new Intl.NumberFormat('en-US');

/** Money is rounded here, at presentation, and nowhere else. */
export const formatUsd = (v: number): string => (Math.abs(v) >= 1000 ? usd0 : usd2).format(v);
export const formatInt = (v: number): string => int.format(v);
export const formatSeconds = (v: number | null): string => (v === null ? '—' : `${v.toFixed(1)} s`);
export const formatPercent = (ratio: number): string => `${Math.round(ratio * 100)}%`;
