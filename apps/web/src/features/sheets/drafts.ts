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

/** Edit drafts hold `{ values, base }`: untouched means the values equal their own base, whatever the server holds now. */
function isUntouched(key: DraftKey, v: unknown, initial: unknown) {
  if (key.startsWith("edit-")) {
    const d = v as { values: unknown; base: unknown };
    return same(d.values, d.base);
  }
  return same(v, initial);
}

/**
 * Start values come from the draft when one exists, else from `initial()` (called once). Writes go to the map through a
 * ref and never re-render the host. `restored` is true when the start came from a draft. Saving a value equal to
 * `initial()` removes the draft, so an untouched form counts as none.
 */
export function useSheetDraft<T>(
  key: DraftKey,
  initial: () => T,
): { start: T; restored: boolean; save(v: T): void; clear(): void; rebase(v: T): void } {
  // Start values are read once per key: a new key (a different entity in the same host) starts over.
  const ref = useRef<{ key: DraftKey; start: T; restored: boolean; initial: T } | null>(null);
  if (ref.current === null || ref.current.key !== key) {
    const base = initial();
    const has = drafts.has(key);
    ref.current = {
      key,
      start: has ? structuredClone(drafts.get(key) as T) : base,
      restored: has,
      initial: base,
    };
  }
  const save = useCallback(
    (v: T) => {
      if (isUntouched(key, v, ref.current?.initial)) drafts.delete(key);
      else drafts.set(key, structuredClone(v));
    },
    [key],
  );
  const clear = useCallback(() => void drafts.delete(key), [key]);
  /** Replaces the untouched baseline: a prefill that turned out stale and was cleared is not an edit, so the
   *  cleared values must not count as a draft (else every later prefill would be ignored). */
  const rebase = useCallback(
    (v: T) => {
      if (ref.current?.key === key) ref.current.initial = v;
    },
    [key],
  );
  return { start: ref.current.start, restored: ref.current.restored, save, clear, rebase };
}

export const hasDraft = (key: DraftKey) => drafts.has(key);
export const clearDraft = (key: DraftKey) => void drafts.delete(key);
/** A copy of the draft as it is now (`undefined` when there is none): the snapshot a submit is judged against later. */
export const peekDraft = (key: DraftKey): unknown =>
  drafts.has(key) ? structuredClone(drafts.get(key)) : undefined;
/**
 * A late result clears the draft only if it still holds what was submitted: a reopened form left untouched holds the
 * same values (cleared), one edited since holds the edits (kept). True when it cleared one.
 */
export function clearDraftIf(key: DraftKey, snapshot: unknown): boolean {
  if (snapshot === undefined || !drafts.has(key) || !same(drafts.get(key), snapshot)) return false;
  drafts.delete(key);
  return true;
}

/** Sign-out: drop every draft. */
export function resetDrafts() {
  drafts.clear();
  generation++;
}

/** Bumped by `resetDrafts`; in-flight work checks it before writing back. */
export const draftGeneration = () => generation;
