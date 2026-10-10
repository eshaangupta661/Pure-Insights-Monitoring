import http from 'node:http';
import { createApp } from './app.js';
import type { ApiDeps } from './deps.js';

/** Express app wrapped in a plain http.Server so Socket.IO can attach to the same port later. */
export function createServer(deps: ApiDeps): http.Server {
  return http.createServer(createApp(deps));
}
