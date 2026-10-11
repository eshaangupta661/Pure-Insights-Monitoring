import {
  Activity,
  ArrowRight,
  Eye,
  EyeOff,
  Eye as ViewerIcon,
  Loader2,
  ShieldCheck,
  UserRound,
  type LucideIcon,
} from 'lucide-react';
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

const ICONS: Record<Role, LucideIcon> = {
  admin: ShieldCheck,
  owner: UserRound,
  viewer: ViewerIcon,
};

export default function LoginPage() {
  const { user, login } = useAuth();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
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

  const field =
    'w-full rounded-lg border border-gray-300 bg-white px-3 py-2.5 text-sm placeholder:text-gray-400 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20';

  return (
    <main className="flex min-h-full items-center justify-center bg-white p-4">
      <div className="w-full max-w-md">
        <div className="flex flex-col items-center text-center">
          <span className="flex size-12 items-center justify-center rounded-xl bg-accent text-white shadow-sm">
            <Activity className="size-6" aria-hidden />
          </span>
          <h1 className="mt-4 text-2xl font-semibold tracking-tight text-gray-900">
            Pure Insights Command Center
          </h1>
          <p className="mt-1 text-sm text-gray-500">Sign in to monitor report health and cost.</p>
        </div>

        <form
          onSubmit={onSubmit}
          className="mt-8 grid gap-4 rounded-2xl border border-gray-200 bg-white p-6 shadow-sm"
        >
          <label className="grid gap-1.5 text-sm font-medium text-gray-700">
            Email
            <input
              type="email"
              autoComplete="username"
              required
              placeholder="you@company.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className={field}
            />
          </label>
          <label className="grid gap-1.5 text-sm font-medium text-gray-700">
            Password
            <span className="relative">
              <input
                type={show ? 'text' : 'password'}
                autoComplete="current-password"
                required
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className={`${field} pr-10`}
              />
              <button
                type="button"
                onClick={() => setShow((v) => !v)}
                aria-label={show ? 'Hide password' : 'Show password'}
                className="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-gray-400 hover:text-gray-700"
              >
                {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </button>
            </span>
          </label>
          {error && (
            <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-critical">
              {error}
            </p>
          )}
          <button
            type="submit"
            disabled={busy !== null}
            className="flex items-center justify-center gap-2 rounded-lg bg-accent px-3 py-2.5 text-sm font-medium text-white hover:bg-accent-strong disabled:opacity-60"
          >
            {busy === 'form' && <Loader2 className="size-4 animate-spin" aria-hidden />}
            Sign in
          </button>
        </form>

        <section aria-labelledby="demo-heading" className="mt-6">
          <div className="flex items-center gap-3 text-xs text-gray-400">
            <span className="h-px flex-1 bg-gray-200" />
            <h2 id="demo-heading" className="font-medium tracking-wide uppercase">
              Or try a demo account
            </h2>
            <span className="h-px flex-1 bg-gray-200" />
          </div>
          <div className="mt-4 grid gap-2">
            {DEMOS.map((d) => {
              const Icon = ICONS[d.role];
              return (
                <button
                  key={d.role}
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void submit(d.role, d.email, d.password)}
                  className="flex items-center gap-3 rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-left transition hover:border-accent hover:bg-accent-soft disabled:opacity-60"
                >
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-gray-100 text-gray-600">
                    <Icon className="size-4" aria-hidden />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium text-gray-900">{d.label}</span>
                    <span className="block truncate text-xs text-gray-500">{d.note}</span>
                  </span>
                  {busy === d.role ? (
                    <Loader2 className="size-4 animate-spin text-accent" aria-label="Signing in" />
                  ) : (
                    <ArrowRight className="size-4 text-gray-300" aria-hidden />
                  )}
                </button>
              );
            })}
          </div>
        </section>
      </div>
    </main>
  );
}
