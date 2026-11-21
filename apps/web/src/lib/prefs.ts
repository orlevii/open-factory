import { useCallback, useMemo, useRef, useSyncExternalStore } from "react";

/** Per-browser preferences over localStorage. One `storage` listener and one listener set serve every key. */
const listeners = new Set<() => void>();
/** One immutable cell per key: a new object whenever the key's string changes, so a cell is a key-scoped
 *  snapshot (two keys never share one, even when they hold the same string). */
type Cell = { readonly value: string | null };
const cells = new Map<string, Cell>();
/** Keys whose cell is known to match localStorage. `storage` events and re-attaching drop keys from it. */
const fresh = new Set<string>();
let attached = false;

function notify() {
  for (const l of listeners) l();
}

function onStorage(e: StorageEvent) {
  if (e.key === null) fresh.clear();
  else fresh.delete(e.key);
  notify();
}

/** Replaces the key's cell only when its string changed, so an unchanged value keeps its identity. */
function put(key: string, value: string | null): Cell {
  fresh.add(key);
  const cell = cells.get(key);
  if (cell && cell.value === value) return cell;
  const next = { value };
  cells.set(key, next);
  return next;
}

function readCell(key: string): Cell {
  const hit = cells.get(key);
  if (hit && fresh.has(key)) return hit;
  let value: string | null = null; // (null = absent or unreadable)
  try {
    value = localStorage.getItem(key);
  } catch {
    // Blocked storage: behaves as absent.
  }
  return put(key, value);
}

const serverCell: Cell = { value: null };

function subscribe(l: () => void) {
  if (!attached) {
    // Nothing listened while unsubscribed, so any cell may be stale.
    fresh.clear();
    window.addEventListener("storage", onStorage);
    attached = true;
  }
  listeners.add(l);
  return () => {
    listeners.delete(l);
    if (listeners.size === 0) {
      window.removeEventListener("storage", onStorage);
      attached = false;
      fresh.clear();
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

  const cell = useSyncExternalStore(
    subscribe,
    () => readCell(key),
    () => serverCell,
  );

  // Memoized on the key-scoped cell only (a new key or a new string is a new cell); parse/fallback are read
  // through the ref so inline functions don't bust it.
  const value = useMemo(() => {
    const stored = cell.value;
    if (stored === null) return latest.current.fallback;
    try {
      return latest.current.parse(stored) ?? latest.current.fallback;
    } catch {
      return latest.current.fallback;
    }
  }, [cell]);

  const set = useCallback(
    (v: T) => {
      const s = latest.current.serialize(v);
      put(key, s);
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
