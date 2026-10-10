import fs from 'node:fs';
import path from 'node:path';
import express, { type ErrorRequestHandler, type Express } from 'express';
import type { ApiError, HealthResponse } from '@pic/shared';
import { CLIENT_DIST } from './paths.js';
import { currentTick } from './realtime/clock.js';

function apiError(code: string, message: string): ApiError {
  return { error: { code, message } };
}

export function createApp(): Express {
  const app = express();
  app.use(express.json());

  app.get('/health', (_req, res) => {
    const body: HealthResponse = { status: 'ok', tick: currentTick(), uptime: process.uptime() };
    res.json(body);
  });

  const api = express.Router();
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

  // Express 5 forwards rejected async handlers here, so no express-async-errors.
  const onError: ErrorRequestHandler = (err: unknown, _req, res, _next) => {
    const status = (err as { status?: unknown } | null)?.status;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      // e.g. malformed JSON body from express.json()
      res.status(status).json(apiError('BAD_REQUEST', 'Bad request'));
      return;
    }
    console.error(err);
    res.status(500).json(apiError('INTERNAL', 'Internal server error'));
  };
  app.use(onError);

  return app;
}
