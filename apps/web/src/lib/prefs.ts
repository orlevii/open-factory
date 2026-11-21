import { useCallback, useMemo, useRef, useSyncExternalStore } from "react";

/** Per-browser preferences over localStorage. One `storage` listener and one listener set serve every key. */
const listeners = new Set<() => void>();
/** Raw string per key (null = absent or unreadable). Invalidated by `storage` events, set by our own writes. */
const raw = new Map<string, string | null>();
let attached = false;

function notify() {
  for (const l of listeners) l();
}

function onStorage(e: StorageEvent) {
  if (e.key === null) raw.clear();
  else raw.delete(e.key);
  notify();
}

function readRaw(key: string): string | null {
  const hit = raw.get(key);
  if (hit !== undefined) return hit;
  let value: string | null = null;
  try {
    value = localStorage.getItem(key);
  } catch {
    // Blocked storage: behaves as absent.
  }
  raw.set(key, value);
  return value;
}

function subscribe(l: () => void) {
  if (!attached) {
    // Nothing listened while unsubscribed, so anything cached may be stale.
    raw.clear();
    window.addEventListener("storage", onStorage);
    attached = true;
  }
  listeners.add(l);
  return () => {
    listeners.delete(l);
    if (listeners.size === 0) {
      window.removeEventListener("storage", onStorage);
      attached = false;
      raw.clear();
    }
  };
}

/**
 * A localStorage-backed value. `parse` validates the shape: throwing or returning undefined yields `fallback`.
 * The returned setter is stable; the value keeps its identity until the stored string changes.
 */
export function usePref<T>(
  key: string,
  fallback: T,
  parse: (raw: string) => T | undefined,
  serialize: (v: T) => string = String,
): [T, (v: T) => void] {
  const latest = useRef({ fallback, parse, serialize });
  latest.current = { fallback, parse, serialize };

  const stored = useSyncExternalStore(
    subscribe,
    () => readRaw(key),
    () => null,
  );

  // Memoized on the raw string (and key) only; parse/fallback are read through the ref so inline functions don't bust it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` re-derives the value when only the key changes.
  const value = useMemo(() => {
    if (stored === null) return latest.current.fallback;
    try {
      return latest.current.parse(stored) ?? latest.current.fallback;
    } catch {
      return latest.current.fallback;
    }
  }, [stored, key]);

  const set = useCallback(
    (v: T) => {
      const s = latest.current.serialize(v);
      raw.set(key, s);
      try {
        localStorage.setItem(key, s);
      } catch {
        // Not persisted, but still applied for this page.
      }
      notify();
    },
    [key],
  );

  return [value, set];
}
