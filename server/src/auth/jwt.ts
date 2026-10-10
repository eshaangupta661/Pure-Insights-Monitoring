import jwt from 'jsonwebtoken';
import { z } from 'zod';
import type { AuthUser } from '@pic/shared';
import { config } from '../config.js';

const ALGORITHM = 'HS256';

const claimsSchema = z.object({
  sub: z.string().email(),
  role: z.enum(['admin', 'owner', 'viewer']),
  exp: z.number().int(),
});

export interface SignedToken {
  token: string;
  /** ISO timestamp of the `exp` claim. */
  expiresAt: string;
}

export function signToken(
  user: AuthUser,
  expiresInSec: number = config.JWT_EXPIRES_IN_SEC,
): SignedToken {
  const token = jwt.sign({ role: user.role }, config.jwtSecret, {
    algorithm: ALGORITHM,
    subject: user.email,
    expiresIn: expiresInSec,
  });
  const { exp } = claimsSchema.parse(jwt.decode(token));
  return { token, expiresAt: new Date(exp * 1000).toISOString() };
}

/** The user in a valid, unexpired token signed with our secret; null for anything else. */
export function verifyToken(token: string): AuthUser | null {
  return verifySession(token)?.user ?? null;
}

/** verifyToken plus the expiry (epoch ms), for long-lived sessions such as a WebSocket. */
export function verifySession(token: string): { user: AuthUser; expiresAtMs: number } | null {
  try {
    const payload = jwt.verify(token, config.jwtSecret, { algorithms: [ALGORITHM] });
    const claims = claimsSchema.safeParse(payload);
    if (!claims.success) return null;
    return {
      user: { email: claims.data.sub, role: claims.data.role },
      expiresAtMs: claims.data.exp * 1000,
    };
  } catch {
    return null;
  }
}
