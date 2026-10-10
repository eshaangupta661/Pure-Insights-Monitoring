import bcrypt from 'bcryptjs';
import type { AuthUser } from '@pic/shared';

interface SeededUser extends AuthUser {
  passwordHash: string;
}

/**
 * The three demo accounts from CLAUDE.md ("Roles"). Their passwords are public demo credentials,
 * documented in the README; only bcrypt hashes (cost 10) live here. Emails are stored lowercase,
 * matching how ingest normalizes owner emails, so the owner's email scopes their reports exactly.
 */
const USERS: readonly SeededUser[] = [
  {
    email: 'admin@pureinsights.dev',
    role: 'admin',
    passwordHash: '$2b$10$aU8zTRgr/75bMsz6wtWys.hY5fq6pkE8Rf7dS/7BcWi3YFND3WJRG',
  },
  {
    email: 'user_3@company.com',
    role: 'owner',
    passwordHash: '$2b$10$e7iRQqMJn9sdp6gjBP8ZyOEvsCgc8n4ny/6qRMMuE8djsCKCIOanW',
  },
  {
    email: 'viewer@pureinsights.dev',
    role: 'viewer',
    passwordHash: '$2b$10$.Q0.2lmTndQAgHTl8Aa6MOGNWc0rhX7oukhBXuhn6lRefAkB5s1ey',
  },
];

/** Compared against when the email is unknown, so both paths cost one bcrypt comparison. */
const DUMMY_HASH = '$2b$10$e7iRQqMJn9sdp6gjBP8ZyOEvsCgc8n4ny/6qRMMuE8djsCKCIOanW';

export function findUser(email: string): AuthUser | undefined {
  const user = USERS.find((u) => u.email === email);
  return user && { email: user.email, role: user.role };
}

/** `email` must already be trimmed and lowercased (the login schema does it). */
export async function verifyCredentials(email: string, password: string): Promise<AuthUser | null> {
  const user = USERS.find((u) => u.email === email);
  const ok = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_HASH);
  return user && ok ? { email: user.email, role: user.role } : null;
}
