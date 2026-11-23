import { type FocusEvent, useCallback, useMemo, useRef, useState } from "react";

/** The handlers to spread on the list's element. */
export type HoldHandlers = {
  onPointerEnter(): void;
  onPointerLeave(): void;
  onFocus(): void;
  onBlur(e: FocusEvent): void;
};

/**
 * A live list that never moves under you (DESIGN Motion, I1 §6.7): while the pointer or focus is inside
 * it, rows are not removed, re-sorted or inserted. Their data stays live, by key. Once both have left,
 * the list is the live one again, applied at once.
 *
 * Only `held` is state. Where the pointer and focus are lives in refs, and the order to hold is the keys
 * as they stood when holding began. A held row the live list no longer has shows as `gone(lastSeen)`
 * (a read chat: read, with no count). Nothing is copied into state by an effect.
 */
export function useHeldList<T>(
  live: readonly T[],
  keyOf: (row: T) => string,
  gone: (last: T) => T,
): { rows: readonly T[]; held: boolean; handlers: HoldHandlers } {
  const [held, setHeld] = useState(false);
  const pointer = useRef(false);
  const focus = useRef(false);
  // What was read last, by key: the order to hold, and the rows a refetch dropped.
  const seen = useRef(new Map<string, T>());
  const order = useRef<readonly string[]>([]);
  const latest = useRef(live);
  latest.current = live;

  const enter = useCallback(() => {
    if (!pointer.current && !focus.current) {
      order.current = latest.current.map(keyOf);
      setHeld(true);
    }
  }, [keyOf]);
  const leave = useCallback(() => {
    if (!pointer.current && !focus.current) setHeld(false);
  }, []);
  const handlers = useMemo<HoldHandlers>(
    () => ({
      onPointerEnter() {
        enter();
        pointer.current = true;
      },
      onPointerLeave() {
        pointer.current = false;
        leave();
      },
      onFocus() {
        enter();
        focus.current = true;
      },
      onBlur(e) {
        // Focus moving between the list's own rows is not leaving it.
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        focus.current = false;
        leave();
      },
    }),
    [enter, leave],
  );

  const rows = useMemo(() => {
    const byKey = new Map(live.map((r) => [keyOf(r), r]));
    if (!held) {
      seen.current = byKey;
      return live;
    }
    for (const [k, r] of byKey) seen.current.set(k, r);
    const out: T[] = [];
    for (const k of order.current) {
      const row = byKey.get(k);
      if (row) out.push(row);
      else {
        const last = seen.current.get(k);
        if (last) out.push(gone(last));
      }
    }
    return out;
  }, [live, held, keyOf, gone]);
  return { rows, held, handlers };
}
