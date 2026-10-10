/*
 * Socket.IO transport for the alerts namespace (docs/WEBSOCKET.md). What to emit and when lives
 * in hub.ts; this file is authentication, rooms and the client → server `alert:ack`.
 *
 * Authentication is the `pic_token` session cookie, which the browser sends with the same-origin
 * handshake. A token in `auth` or an Authorization header is not accepted: one credential path,
 * checked by the same function as REST (authenticateToken). In production the handshake must
 * also carry an Origin matching the Host, so a cross-site page can't open a socket that rides on
 * the cookie (cross-site WebSocket hijacking); see sameOriginHandshake(). A socket is disconnected when its JWT expires.
 */
import type http from 'node:http';
import { Server } from 'socket.io';
import { z } from 'zod';
import {
  ALERTS_NAMESPACE,
  type AlertAckResponse,
  type ClientToServerEvents,
  type ServerToClientEvents,
} from '@pic/shared';
import { alertSchema } from '../api/schemas.js';
import { authenticateToken, originMatchesHost } from '../auth/middleware.js';
import { config } from '../config.js';
import type { ErrorCode } from '../http/errors.js';
import type { AlertsSocket, HubAckResult, RealtimeHub, SocketData } from './hub.js';

export type AlertsServer = Server<
  ClientToServerEvents,
  ServerToClientEvents,
  Record<string, never>,
  SocketData
>;

export interface SocketOptions {
  /** Require Origin === Host on the handshake. Defaults to on in production. */
  enforceOrigin?: boolean;
}

/** setTimeout's maximum delay (~24.8 days); longer timers fire immediately. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

const ackRequestSchema = z.object({ alertId: z.string().min(1).max(120) });

/** A handshake rejection; the client sees `err.message` and `err.data` in `connect_error`. */
function handshakeError(code: ErrorCode, message: string): Error {
  return Object.assign(new Error(code), { data: { code, message } });
}

/**
 * The production Origin rule for a handshake. A WebSocket upgrade always carries Origin, but the
 * default polling transport opens with a same-origin XHR GET, on which browsers omit Origin. For
 * that case the browser-set `Sec-Fetch-Site: same-origin` (page scripts can't set Sec-* headers)
 * stands in for it. Anything else, including a request with neither header, is rejected.
 */
export function sameOriginHandshake(headers: http.IncomingHttpHeaders): boolean {
  if (headers.origin !== undefined) return originMatchesHost(headers.origin, headers.host);
  return headers['sec-fetch-site'] === 'same-origin';
}

/** One cookie's value from a Cookie header, or undefined. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of header?.split(';') ?? []) {
    const eq = part.indexOf('=');
    if (eq < 0 || part.slice(0, eq).trim() !== name) continue;
    const raw = part.slice(eq + 1).trim();
    try {
      return decodeURIComponent(raw) || undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function attachAlertsSocket(
  httpServer: http.Server,
  hub: RealtimeHub,
  options: SocketOptions = {},
): AlertsServer {
  const enforceOrigin = options.enforceOrigin ?? config.ENFORCE_ORIGIN;
  const io: AlertsServer = new Server(httpServer, {
    serveClient: false,
    // Clients only send `alert:ack { alertId }`.
    maxHttpBufferSize: 10_000,
  });

  // Nothing is served on the default namespace.
  io.of('/').use((_socket, next) => next(handshakeError('NOT_FOUND', 'Use the /alerts namespace')));

  const nsp = io.of(ALERTS_NAMESPACE);
  nsp.use((socket, next) => {
    const { headers } = socket.handshake;
    if (enforceOrigin && !sameOriginHandshake(headers)) {
      return next(handshakeError('BAD_ORIGIN', 'Cross-origin connection rejected'));
    }
    const token = readCookie(headers.cookie, config.AUTH_COOKIE);
    const session = token === undefined ? null : authenticateToken(token);
    if (!session || session.expiresAtMs <= Date.now()) {
      return next(handshakeError('UNAUTHENTICATED', 'Sign in first'));
    }
    socket.data.user = session.user;
    socket.data.expiresAtMs = session.expiresAtMs;
    next();
  });

  nsp.on('connection', (socket) => {
    const ttl = Math.min(Math.max(0, socket.data.expiresAtMs - Date.now()), MAX_TIMEOUT_MS);
    const expiry = setTimeout(() => socket.disconnect(true), ttl);
    socket.on('disconnect', () => clearTimeout(expiry));

    socket.on('alert:ack', (payload: unknown, callback: unknown) => {
      void handleAck(hub, socket, payload, callback);
    });

    hub.welcome(socket).catch((err: unknown) => {
      console.error('Could not send the initial alert state; disconnecting', err);
      socket.disconnect(true);
    });
  });

  hub.attach(nsp);
  return io;
}

const fail = (code: ErrorCode, message: string): AlertAckResponse => ({
  ok: false,
  error: { code, message },
});

function ackFailure(result: Extract<HubAckResult, { ok: false }>, alertId: string) {
  switch (result.reason) {
    case 'FORBIDDEN':
      return fail('FORBIDDEN', 'Requires role: admin or owner');
    case 'RESOLVED':
      return fail('CONFLICT', `Alert ${alertId} is already resolved`);
    case 'NOT_FOUND':
      return fail('NOT_FOUND', `Alert ${alertId} not found`);
  }
}

async function handleAck(
  hub: RealtimeHub,
  socket: AlertsSocket,
  payload: unknown,
  callback: unknown,
): Promise<void> {
  const reply = (response: AlertAckResponse) => {
    if (typeof callback === 'function') callback(response);
  };
  if (socket.data.expiresAtMs <= Date.now()) {
    reply(fail('UNAUTHENTICATED', 'Session expired'));
    socket.disconnect(true);
    return;
  }
  const request = ackRequestSchema.safeParse(payload);
  if (!request.success) return reply(fail('BAD_REQUEST', 'Expected { alertId: string }'));
  const { alertId } = request.data;
  try {
    const result = await hub.ack(socket.data.user, alertId);
    reply(
      result.ok
        ? { ok: true, alert: alertSchema.parse(result.alert) }
        : ackFailure(result, alertId),
    );
  } catch (err) {
    console.error('alert:ack failed', err);
    reply(fail('INTERNAL', 'Could not acknowledge the alert'));
  }
}
