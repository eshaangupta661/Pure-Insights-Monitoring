import http from 'node:http';
import { createApp } from './app.js';

/** Express app wrapped in a plain http.Server so Socket.IO can attach to the same port later. */
export const app = createApp();
export const server = http.createServer(app);
