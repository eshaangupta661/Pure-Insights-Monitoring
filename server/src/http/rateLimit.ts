import type { RequestHandler } from 'express';
import { HttpError } from './errors.js';

export interface RateLimit {
  max: number;
  windowMs: number;
}

/**
 * A fixed-window, in-memory limiter keyed by client IP (req.ip; behind Render's proxy that needs
 * `trust proxy`, see app.ts). One instance per app. Good enough for one small instance; several
 * instances would need a shared store.
 */
export function rateLimit(
  { max, windowMs }: RateLimit,
  now: () => number = Date.now,
): RequestHandler {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return (req, res, next) => {
    const t = now();
    // Drop expired windows as we go, so the map holds only IPs seen in the last window.
    if (hits.size > 1000) for (const [ip, h] of hits) if (h.resetAt <= t) hits.delete(ip);
    const key = req.ip ?? 'unknown';
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= t) {
      entry = { count: 0, resetAt: t + windowMs };
      hits.set(key, entry);
    }
    entry.count++;
    if (entry.count > max) {
      res.set('Retry-After', String(Math.ceil((entry.resetAt - t) / 1000)));
      throw new HttpError(429, 'RATE_LIMITED', 'Too many sign-in attempts; try again shortly');
    }
    next();
  };
}
