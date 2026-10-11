import { X } from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';

/** A modal built on the native <dialog>: focus trap, Escape to close and backdrop come for free. */
export default function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => e.target === ref.current && onClose()}
      className="m-auto w-full max-w-md rounded-lg border border-gray-200 bg-white p-0 shadow-xl backdrop:bg-black/30"
    >
      <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3">
        <h2 className="text-sm font-medium text-gray-900">{title}</h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="rounded p-1 text-gray-500 hover:bg-gray-100"
        >
          <X className="size-4" />
        </button>
      </div>
      <div className="p-4">{children}</div>
    </dialog>
  );
}
