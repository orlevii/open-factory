import { useCallback, useRef, useState } from "react";
import { rebase } from "./rebase";

export type Loaded<T> = { value: T; version: string };
/** `null` means "no edits". `base` is what the edits started from; `conflicts` come from the last rebase. */
type Edits<T> = { edits: T; base: Loaded<T>; conflicts: readonly string[] };

const NONE: readonly string[] = [];

/**
 * The page's draft of a configuration (spec §12.4), shared by the form and Raw JSON. Everything the page reads is
 * derived in render from one state and the loaded value: there is no initialize step and no effect.
 */
export function useConfigDraft<T>(loaded: Loaded<T>) {
  const [s, setS] = useState<Edits<T> | null>(null);
  // Discarded edits, for Undo, until the next edit. A ref: nothing renders from it.
  const discarded = useRef<Edits<T> | null>(null);
  const { value, version } = loaded;

  // Stable while the loaded value is: the form's rows hand it down.
  const setDraft = useCallback(
    (update: (prev: T) => T) => {
      discarded.current = null;
      setS((prev) => {
        // The first edit snapshots the base it started from, inside the updater.
        const base = prev?.base ?? { value, version };
        return {
          edits: update(prev?.edits ?? base.value),
          base,
          conflicts: prev?.conflicts ?? NONE,
        };
      });
    },
    [value, version],
  );

  const discard = useCallback(() => {
    discarded.current = s;
    setS(null);
  }, [s]);

  const undoDiscard = useCallback(() => {
    const d = discarded.current;
    discarded.current = null;
    if (d) setS(d);
  }, []);

  /** After a save: the edits are now the loaded value, and there is nothing to undo. */
  const reset = useCallback(() => {
    discarded.current = null;
    setS(null);
  }, []);

  /** After a 409 or a refetch with drift: re-apply my edits (base → draft) over the loaded value. Still unsaved. */
  const rebaseDraft = useCallback(() => {
    if (!s || s.base.version === version) return;
    const r = rebase(s.base.value, s.edits, value);
    setS({
      edits: r.value,
      base: { value, version },
      conflicts: [...new Set([...s.conflicts, ...r.conflicts])],
    });
  }, [s, value, version]);

  return {
    draft: s ? s.edits : value,
    setDraft,
    dirty: s !== null,
    drift: s !== null && s.base.version !== version,
    conflicts: s ? s.conflicts : NONE,
    discard,
    undoDiscard,
    reset,
    rebase: rebaseDraft,
  };
}
