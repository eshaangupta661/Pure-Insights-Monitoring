import { ChevronDown } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';

interface PopoverProps {
  /** Text on the trigger button. Hidden below `sm` when `icon` is given. */
  label: ReactNode;
  icon?: ReactNode;
  /** Classes for the floating panel (width, padding). */
  panelClass?: string;
  /** Render-prop children get a `close` callback. */
  children: ReactNode | ((close: () => void) => ReactNode);
  triggerClass?: string;
  ariaLabel?: string;
}

/** Header dropdown: closes on outside click or Escape. */
export default function Popover({
  label,
  icon,
  panelClass = '',
  children,
  triggerClass = '',
  ariaLabel,
}: PopoverProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => setOpen((o) => !o)}
        className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm text-gray-700 hover:bg-gray-100 ${
          open ? 'bg-gray-100' : ''
        } ${triggerClass}`}
      >
        {icon}
        <span className={icon ? 'hidden sm:inline' : ''}>{label}</span>
        <ChevronDown className="size-3.5 text-gray-400" aria-hidden />
      </button>
      {open && (
        <div
          className={`absolute right-0 z-50 mt-2 rounded-xl border border-gray-200 bg-white shadow-lg ${panelClass}`}
        >
          {typeof children === 'function' ? children(() => setOpen(false)) : children}
        </div>
      )}
    </div>
  );
}
