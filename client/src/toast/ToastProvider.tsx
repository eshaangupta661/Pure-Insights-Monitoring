import { AlertOctagon, X } from 'lucide-react';
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Link } from 'react-router-dom';

export interface ToastInput {
  title: string;
  body?: string;
  /** Only CRITICAL alerts toast today, so the one visual variant is the critical one. */
  to?: string;
}
interface Toast extends ToastInput {
  id: number;
}

const TOAST_MS = 10_000;
const MAX_TOASTS = 4;

const ToastContext = createContext<((toast: ToastInput) => void) | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback(
    (id: number) => setToasts((all) => all.filter((t) => t.id !== id)),
    [],
  );
  const push = useCallback(
    (toast: ToastInput) => {
      const id = nextId.current++;
      setToasts((all) => [...all, { ...toast, id }].slice(-MAX_TOASTS));
      setTimeout(() => dismiss(id), TOAST_MS);
    },
    [dismiss],
  );
  const value = useMemo(() => push, [push]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        aria-live="assertive"
        className="pointer-events-none fixed right-4 bottom-4 z-50 flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            role="alert"
            className="pointer-events-auto flex gap-3 rounded-md border border-gray-200 border-l-4 border-l-critical bg-white p-3 shadow-lg"
          >
            <AlertOctagon className="mt-0.5 size-4 shrink-0 text-critical" aria-hidden />
            <div className="min-w-0 flex-1 text-sm">
              <p className="font-medium text-gray-900">{t.title}</p>
              {t.body && <p className="mt-0.5 text-gray-600">{t.body}</p>}
              {t.to && (
                <Link
                  to={t.to}
                  onClick={() => dismiss(t.id)}
                  className="mt-1 inline-block text-accent hover:underline"
                >
                  View
                </Link>
              )}
            </div>
            <button
              type="button"
              onClick={() => dismiss(t.id)}
              aria-label="Dismiss"
              className="h-fit rounded p-0.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700"
            >
              <X className="size-4" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): (toast: ToastInput) => void {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast outside ToastProvider');
  return ctx;
}
