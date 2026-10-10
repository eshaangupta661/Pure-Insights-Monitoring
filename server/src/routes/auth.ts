import type { CookieOptions, Request } from 'express';
import { authUserSchema, loginBodySchema, loginResponseSchema } from '../api/schemas.js';
import { signToken } from '../auth/jwt.js';
import { verifyCredentials } from '../auth/users.js';
import { config } from '../config.js';
import { HttpError } from '../http/errors.js';
import { defineRoute } from '../http/route.js';

/**
 * The session cookie. httpOnly (page scripts can't read it), SameSite=Lax (not sent on
 * cross-site POSTs), Secure in production (HTTPS only on Render). Socket.IO's handshake carries it
 * too, since the client is served from the same origin.
 */
export function sessionCookieOptions(req: Request): CookieOptions {
  return {
    httpOnly: true,
    sameSite: 'lax',
    // createApp's `secureCookies` option (default: production), not req.secure: the flag must
    // not depend on whether the proxy's X-Forwarded-Proto reached us.
    secure: req.app.locals.secureCookies === true,
    path: '/',
  };
}

export const authRoutes = [
  defineRoute({
    method: 'post',
    path: '/auth/login',
    tag: 'auth',
    summary: 'Sign in',
    description:
      `Limited to ${config.LOGIN_RATE_LIMIT.max} attempts per client IP per ` +
      `${config.LOGIN_RATE_LIMIT.windowMs / 1000} s (429 RATE_LIMITED). ` +
      'Checks the email (trimmed, case-insensitive) and password. On success, sets the ' +
      `\`${config.AUTH_COOKIE}\` httpOnly session cookie. The token is never returned in the body.`,
    access: 'public',
    body: loginBodySchema,
    response: loginResponseSchema,
    viewerResponse: loginResponseSchema,
    errors: { 429: 'RATE_LIMITED: too many sign-in attempts from this IP' },
    handler: async ({ body, req, res }) => {
      const user = await verifyCredentials(body.email, body.password);
      if (!user) throw new HttpError(401, 'INVALID_CREDENTIALS', 'Wrong email or password');
      const { token, expiresAt } = signToken(user);
      res.cookie(config.AUTH_COOKIE, token, {
        ...sessionCookieOptions(req),
        maxAge: config.JWT_EXPIRES_IN_SEC * 1000,
      });
      return { user, expiresAt };
    },
  }),

  defineRoute({
    method: 'post',
    path: '/auth/logout',
    tag: 'auth',
    summary: 'Sign out',
    description:
      'Clears the session cookie. Tokens are stateless JWTs, so a copied token stays valid ' +
      'until it expires.',
    access: 'public',
    status: 204,
    response: null,
    handler: ({ req, res }) => {
      res.clearCookie(config.AUTH_COOKIE, sessionCookieOptions(req));
    },
  }),

  defineRoute({
    method: 'get',
    path: '/auth/me',
    tag: 'auth',
    summary: 'The signed-in user',
    access: 'authenticated',
    response: authUserSchema,
    viewerResponse: authUserSchema,
    handler: ({ user }) => user,
  }),
];
