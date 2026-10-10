import type { Request, RequestHandler, Response } from 'express';
import type { AuthUser, Role } from '@pic/shared';
import { config } from '../config.js';
import { HttpError } from '../http/errors.js';
import { verifySession } from './jwt.js';
import { findUser } from './users.js';

/** Where the session token came from. Only cookie sessions are exposed to CSRF. */
export type CredentialSource = 'bearer' | 'cookie';

function bearerToken(req: Request): string | undefined {
  const header = req.get('authorization');
  const match = header?.match(/^Bearer\s+(\S+)$/i);
  return match?.[1];
}

function cookieToken(req: Request): string | undefined {
  const value: unknown = req.cookies?.[config.AUTH_COOKIE];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * The user behind the request, or null. An explicit `Authorization: Bearer` header wins over the
 * session cookie. The role is re-read from the seeded users, so a token can't outlive its account
 * or claim a role the account doesn't have.
 */
export function authenticate(req: Request): { user: AuthUser; via: CredentialSource } | null {
  const bearer = bearerToken(req);
  const token = bearer ?? cookieToken(req);
  if (!token) return null;
  const session = authenticateToken(token);
  return session && { user: session.user, via: bearer ? 'bearer' : 'cookie' };
}

/**
 * A session token's user, checked against the seeded users (same rules as authenticate()), plus
 * when it expires. The Socket.IO handshake uses it directly.
 */
export function authenticateToken(token: string): { user: AuthUser; expiresAtMs: number } | null {
  const session = verifySession(token);
  const user = session && findUser(session.user.email);
  if (!session || !user || user.role !== session.user.role) return null;
  return { user, expiresAtMs: session.expiresAtMs };
}

/** True when `origin` is a URL whose host is exactly `host` (the request's Host header). */
export function originMatchesHost(origin: string, host: string | undefined): boolean {
  try {
    return host !== undefined && new URL(origin).host === host;
  } catch {
    return false;
  }
}

/** 401 unless signed in; puts the user on `res.locals.user`. Routes use defineRoute instead. */
export const requireAuth: RequestHandler = (req, res, next) => {
  const auth = authenticate(req);
  if (!auth) throw new HttpError(401, 'UNAUTHENTICATED', 'Sign in first');
  res.locals.user = auth.user;
  next();
};

export function currentUser(res: Response): AuthUser {
  const user = res.locals.user as AuthUser | undefined;
  if (!user) throw new HttpError(401, 'UNAUTHENTICATED', 'Sign in first');
  return user;
}

/** 403 unless the signed-in user has one of `roles`. Use after requireAuth. */
export function requireRole(...roles: Role[]): RequestHandler {
  return (_req, res, next) => {
    assertRole(currentUser(res), roles);
    next();
  };
}

export function assertRole(user: AuthUser, roles: readonly Role[]): void {
  if (!roles.includes(user.role)) {
    throw new HttpError(403, 'FORBIDDEN', `Requires role: ${roles.join(' or ')}`);
  }
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF guard for state-changing requests (no GET route changes state). When `enforce` is on
 * (production), a POST/PATCH/PUT/DELETE is rejected with 403 BAD_ORIGIN if:
 *   - it sends an Origin whose host differs from the request's Host, or
 *   - it sends no Origin but carries the session cookie (browsers always send Origin on
 *     cross-site POSTs, so a cookie without one isn't a browser request we trust).
 * Bearer-only requests without Origin (curl, scripts) pass: a cross-site page can't set headers.
 */
export function requireSameOrigin(enforce: boolean): RequestHandler {
  return (req, _res, next) => {
    if (!enforce || SAFE_METHODS.has(req.method)) return next();
    const origin = req.get('origin');
    if (origin === undefined) {
      if (cookieToken(req) !== undefined) {
        throw new HttpError(403, 'BAD_ORIGIN', 'Missing Origin header on a cookie request');
      }
      return next();
    }
    if (!originMatchesHost(origin, req.get('host'))) {
      throw new HttpError(403, 'BAD_ORIGIN', 'Cross-origin request rejected');
    }
    next();
  };
}
