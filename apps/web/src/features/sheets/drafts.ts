import { useCallback, useRef } from "react";

export type DraftKey =
  | "new-agent"
  | "new-task"
  | "new-schedule"
  | "new-template"
  | `edit-agent:${string}`
  | `edit-schedule:${string}`;

const drafts = new Map<DraftKey, unknown>();
let generation = 0;

/** Plain values only (strings, numbers, arrays, plain objects), so JSON is a sound equality. */
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Start values come from the draft when one exists, else from `initial()` (called once). Writes go to the map through a
 * ref and never re-render the host. `restored` is true when the start came from a draft. Saving a value equal to
 * `initial()` removes the draft, so an untouched form counts as none.
 */
export function useSheetDraft<T>(
  key: DraftKey,
  initial: () => T,
): { start: T; restored: boolean; save(v: T): void; clear(): void } {
  const ref = useRef<{ start: T; restored: boolean; initial: T } | null>(null);
  if (ref.current === null) {
    const base = initial();
    const has = drafts.has(key);
    ref.current = { start: has ? (drafts.get(key) as T) : base, restored: has, initial: base };
  }
  const save = useCallback(
    (v: T) => {
      if (same(v, ref.current?.initial)) drafts.delete(key);
      else drafts.set(key, v);
    },
    [key],
  );
  const clear = useCallback(() => void drafts.delete(key), [key]);
  return { start: ref.current.start, restored: ref.current.restored, save, clear };
}

export const hasDraft = (key: DraftKey) => drafts.has(key);
export const clearDraft = (key: DraftKey) => void drafts.delete(key);

/** Sign-out: drop every draft. */
export function resetDrafts() {
  drafts.clear();
  generation++;
}

/** Bumped by `resetDrafts`; in-flight work checks it before writing back. */
export const draftGeneration = () => generation;
