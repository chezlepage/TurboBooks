import { useEffect, useState } from 'react';

interface ToastItem {
  id: number;
  text: string;
}

const listeners = new Set<(t: ToastItem) => void>();
let nextId = 1;

/** Shows a short confirmation at the bottom of the screen. */
export function toast(text: string): void {
  const item = { id: nextId++, text };
  listeners.forEach((fn) => fn(item));
}

export function Toaster() {
  const [items, setItems] = useState<ToastItem[]>([]);
  useEffect(() => {
    const add = (t: ToastItem) => {
      setItems((list) => [...list.slice(-2), t]);
      window.setTimeout(() => setItems((list) => list.filter((x) => x.id !== t.id)), 2800);
    };
    listeners.add(add);
    return () => {
      listeners.delete(add);
    };
  }, []);
  return (
    <div className="toaster" role="status" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className="toast">
          {t.text}
        </div>
      ))}
    </div>
  );
}
