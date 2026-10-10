import type { Express } from 'express';
import request from 'supertest';
import type { Role } from '@pic/shared';
import { signToken } from '../../src/auth/jwt.js';

/** The public demo credentials from CLAUDE.md "Roles". */
export const DEMO_USERS = {
  admin: { email: 'admin@pureinsights.dev', password: 'Admin@123' },
  owner: { email: 'user_3@company.com', password: 'Owner@123' },
  viewer: { email: 'viewer@pureinsights.dev', password: 'Viewer@123' },
} as const satisfies Record<Role, { email: string; password: string }>;

/** A supertest agent signed in through POST /auth/login; it carries the session cookie. */
export async function loginAs(app: Express, role: Role) {
  const agent = request.agent(app);
  const res = await agent.post('/api/v1/auth/login').send(DEMO_USERS[role]);
  if (res.status !== 200) throw new Error(`login as ${role} failed: ${res.status}`);
  return agent;
}

/** `Authorization` header value for `role`, signed directly (no login round trip). */
export function bearerFor(role: Role): string {
  return `Bearer ${signToken({ email: DEMO_USERS[role].email, role }).token}`;
}
