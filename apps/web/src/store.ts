import { useCallback, useState } from "react";

// Estado que sobrevive al cambiar de pestaña (memoria) y al recargar la página (localStorage).
const memory = new Map<string, unknown>();
const PREFIX = "testforge:";

function read<T>(key: string, fallback: T): T {
  if (memory.has(key)) return memory.get(key) as T;
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (raw !== null) {
      const value = JSON.parse(raw) as T;
      memory.set(key, value);
      return value;
    }
  } catch {
    /* almacenamiento no disponible: solo memoria */
  }
  return fallback;
}

function write(key: string, value: unknown) {
  memory.set(key, value);
  try {
    if (value === null || value === undefined) localStorage.removeItem(PREFIX + key);
    else localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    /* lleno o bloqueado: queda en memoria mientras la pestaña esté abierta */
  }
}

export function forget(...keys: string[]) {
  for (const k of keys) write(k, null);
}

/** Como useState, pero guardado bajo `key`. */
export function usePersistentState<T>(key: string, initial: T | (() => T)) {
  const [value, setValue] = useState<T>(() =>
    read(key, typeof initial === "function" ? (initial as () => T)() : initial),
  );
  const set = useCallback(
    (next: T | ((prev: T) => T)) => {
      setValue((prev) => {
        const v = typeof next === "function" ? (next as (p: T) => T)(prev) : next;
        write(key, v);
        return v;
      });
    },
    [key],
  );
  return [value, set] as const;
}
