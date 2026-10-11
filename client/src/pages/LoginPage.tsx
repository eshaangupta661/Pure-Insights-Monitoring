import { Loader2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import type { Role } from '@pic/shared';
import { ApiRequestError } from '../api/http';
import { useAuth } from '../auth/AuthProvider';

/** The seeded demo accounts. Their passwords are public (README, "Demo credentials"). */
const DEMOS: readonly {
  role: Role;
  label: string;
  email: string;
  password: string;
  note: string;
}[] = [
  {
    role: 'admin',
    label: 'Admin',
    email: 'admin@pureinsights.dev',
    password: 'Admin@123',
    note: 'Everything: assign owners, replay controls, audit log',
  },
  {
    role: 'owner',
    label: 'Owner',
    email: 'user_3@company.com',
    password: 'Owner@123',
    note: 'Only the reports they own',
  },
  {
    role: 'viewer',
    label: 'Viewer',
    email: 'viewer@pureinsights.dev',
    password: 'Viewer@123',
    note: 'Read-only; cost as aggregates',
  },
];

export default function LoginPage() {
  const { user, login } = useAuth();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (user) {
    const from = (location.state as { from?: string } | null)?.from;
    return <Navigate to={from ?? '/'} replace />;
  }

  const submit = async (key: string, e: string, p: string) => {
    setBusy(key);
    setError(null);
    try {
      await login(e, p);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Sign-in failed');
      setBusy(null);
    }
  };

  const onSubmit = (ev: FormEvent) => {
    ev.preventDefault();
    void submit('form', email, password);
  };

  return (
    <main className="flex min-h-full items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <h1 className="text-xl font-semibold text-gray-900">Pure Insights Command Center</h1>
        <p className="mt-1 text-sm text-gray-600">Sign in to monitor report health and cost.</p>

        <section aria-labelledby="demo-heading" className="mt-6">
          <h2
            id="demo-heading"
            className="text-xs font-medium tracking-wide text-gray-500 uppercase"
          >
            Try a demo account
          </h2>
          <div className="mt-2 grid gap-2">
            {DEMOS.map((d) => (
              <button
                key={d.role}
                type="button"
                disabled={busy !== null}
                onClick={() => void submit(d.role, d.email, d.password)}
                className="flex items-center justify-between rounded-md border border-gray-300 bg-white px-3 py-2 text-left hover:border-accent hover:bg-accent-soft disabled:opacity-60"
              >
                <span>
                  <span className="block text-sm font-medium text-gray-900">{d.label}</span>
                  <span className="block text-xs text-gray-500">{d.note}</span>
                </span>
                {busy === d.role && (
                  <Loader2 className="size-4 animate-spin text-accent" aria-label="Signing in" />
                )}
              </button>
            ))}
          </div>
        </section>

        <div className="my-6 flex items-center gap-3 text-xs text-gray-400" aria-hidden>
          <span className="h-px flex-1 bg-gray-200" />
          or
          <span className="h-px flex-1 bg-gray-200" />
        </div>

        <form onSubmit={onSubmit} className="grid gap-3">
          <label className="grid gap-1 text-sm text-gray-700">
            Email
            <input
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
            />
          </label>
          <label className="grid gap-1 text-sm text-gray-700">
            Password
            <input
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
            />
          </label>
          {error && (
            <p role="alert" className="text-sm text-critical">
              {error}
            </p>
          )}
          <button
            type="submit"
            disabled={busy !== null}
            className="flex items-center justify-center gap-2 rounded-md bg-accent px-3 py-2 text-sm font-medium text-white hover:bg-accent-strong disabled:opacity-60"
          >
            {busy === 'form' && <Loader2 className="size-4 animate-spin" aria-hidden />}
            Sign in
          </button>
        </form>
      </div>
    </main>
  );
}
