import http from 'node:http';
import { createApp, type AppOptions } from './app.js';
import type { ApiDeps } from './deps.js';
import { attachAlertsSocket, type AlertsServer } from './realtime/socket.js';

/** Express app and Socket.IO (namespace /alerts) on one plain http.Server, one port. */
export function createServer(
  deps: ApiDeps,
  options: AppOptions = {},
): { server: http.Server; io: AlertsServer } {
  const server = http.createServer(createApp(deps, options));
  const io = attachAlertsSocket(server, deps.realtime, { enforceOrigin: options.enforceOrigin });
  return { server, io };
}
