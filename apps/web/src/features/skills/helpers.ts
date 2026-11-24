import { useEffect, useRef, useState } from "react";

/** The class of an in-page link on the Skills surfaces. */
export const LINK = "underline underline-offset-2 hover:text-foreground";

/** Inert primary after a Find lands (spec §10.4). */
export const INERT_MS = 300;

/** A results label moves focus here when it mounts (a new Find remounts it by key): the focus is the announcement, so
 *  there is no live region as well. Module-level, so it is stable and never runs on a re-render. */
export function focusAndReveal(el: HTMLElement | null) {
  if (!el) return;
  el.focus({ preventScroll: true });
  el.scrollIntoView({ block: "nearest" });
}

/**
 * The 300 ms window after a Find lands in which the primary is inert. `start` is called from Find's `onSuccess` (R-T1);
 * the timer lives in a ref and is cleared on unmount, this hook's only effect.
 */
export function useInertWindow() {
  const [inert, setInert] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const start = () => {
    setInert(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setInert(false), INERT_MS);
  };
  return { inert, start };
}

/**
 * The key of the row after `key` among the page's rows with this `data-peek-key` prefix (else the one before it): where
 * focus goes once `key` is gone. `null` when it was the only one.
 */
export function neighbourKey(prefix: string, key: string): string | null {
  const keys = [...document.querySelectorAll<HTMLElement>(`[data-peek-key^="${prefix}"]`)]
    .filter((el) => el.hasAttribute("data-row"))
    .map((el) => el.dataset.peekKey ?? "");
  const i = keys.indexOf(key);
  return keys[i + 1] ?? keys[i - 1] ?? null;
}

/**
 * A ref that always holds the latest `fn`, for an Undo toast that outlives the render it was made in: the toast calls
 * `ref.current` when pressed, so it restores through the mutation as it is then, not as it was.
 */
export function useLatest<T>(fn: T) {
  const ref = useRef(fn);
  useEffect(() => {
    ref.current = fn;
  });
  return ref;
}
