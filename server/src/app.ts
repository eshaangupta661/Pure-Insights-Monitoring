import fs from 'node:fs';
import path from 'node:path';
import cookieParser from 'cookie-parser';
import express, { type Express } from 'express';
import swaggerUi from 'swagger-ui-express';
import type { HealthResponse } from '@pic/shared';
import { openApiDocument } from './api/openapi.js';
import { requireSameOrigin } from './auth/middleware.js';
import { config } from './config.js';
import type { ApiDeps } from './deps.js';
import { apiError, errorHandler } from './http/errors.js';
import { rateLimit, type RateLimit } from './http/rateLimit.js';
import { mountRoutes } from './http/route.js';
import { CLIENT_DIST } from './paths.js';
import { currentTick } from './realtime/clock.js';
import { ALL_ROUTES } from './routes/index.js';

export interface AppOptions {
  /** CSRF Origin check on mutations (auth/middleware.ts). Defaults to on in production. */
  enforceOrigin?: boolean;
  /** `Secure` on the session cookie (HTTPS only). Defaults to on in production. */
  secureCookies?: boolean;
  /** Per-IP limit on POST /auth/login; false turns it off. Defaults to config.LOGIN_RATE_LIMIT. */
  loginRateLimit?: RateLimit | false;
}

/**
 * Without `deps` the routes still mount (auth works, /health works), but any handler that needs
 * the warehouse answers 500. index.ts and the API tests always pass deps.
 */
export function createApp(deps?: ApiDeps, options: AppOptions = {}): Express {
  const app = express();
  // Render terminates TLS at one proxy hop and adds X-Forwarded-For / -Proto. Trusting exactly
  // that hop makes req.ip the client (for the login limiter) without letting a client spoof it
  // through extra X-Forwarded-For entries. The Origin check reads the Host header, which the
  // proxy passes through, and the Secure cookie flag comes from `secureCookies`, not
  // req.secure, so neither depends on this setting.
  app.set('trust proxy', 1);
  app.locals.secureCookies = options.secureCookies ?? config.nodeEnv === 'production';
  app.use(express.json());
  app.use(cookieParser());

  app.get('/health', (_req, res) => {
    const tick = deps ? deps.clock.tick() : currentTick();
    const body: HealthResponse = { status: 'ok', tick, uptime: process.uptime() };
    res.json(body);
  });

  // Generated from the route declarations; Swagger UI calls the API on this origin, so after
  // POST /auth/login the session cookie authenticates "Try it out".
  app.get('/api/openapi.json', (_req, res) => {
    res.json(openApiDocument());
  });
  app.use(
    '/api/docs',
    swaggerUi.serve,
    swaggerUi.setup(openApiDocument(), {
      customSiteTitle: 'Pure Insights Command Center API',
      swaggerOptions: { withCredentials: true, displayRequestDuration: true },
    }),
  );

  // Only /health, /api/openapi.json and /api/docs are mounted outside ALL_ROUTES, all public by
  // design. Anything that needs auth must go through defineRoute (and the access matrix).
  const api = express.Router();
  api.use(requireSameOrigin(options.enforceOrigin ?? config.ENFORCE_ORIGIN));
  const loginLimit = options.loginRateLimit ?? config.LOGIN_RATE_LIMIT;
  if (loginLimit) api.post('/auth/login', rateLimit(loginLimit));
  mountRoutes(api, ALL_ROUTES, deps);
  app.use('/api/v1', api);

  // Registered before the SPA fallback so unknown API routes always get JSON, never index.html.
  app.use('/api', (req, res) => {
    res.status(404).json(apiError('NOT_FOUND', `No route for ${req.method} ${req.originalUrl}`));
  });

  const indexHtml = path.join(CLIENT_DIST, 'index.html');
  if (fs.existsSync(indexHtml)) {
    app.use(express.static(CLIENT_DIST));
    app.use((req, res, next) => {
      // Missing files (e.g. /assets/x.js) must 404, not return index.html.
      if (req.method !== 'GET' || req.path.startsWith('/socket.io') || path.extname(req.path)) {
        return next();
      }
      res.sendFile(indexHtml);
    });
  }

  app.use(errorHandler);

  return app;
}
