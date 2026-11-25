import { type RefObject, useCallback, useState } from "react";
import { flushSync } from "react-dom";
import { runInstantOn } from "@/lib/run-instant";

/**
 * Moving between peeks from inside a peek (a skill from its Source peek, a Source from its skill) keeps a Back to the
 * peek it came from. The trail is only valid for the key it was made for, so a retarget from the list (a different
 * key) has no Back, derived during render with no effect.
 */
export function usePeekNav(
  key: string | null,
  show: (key: string) => void,
  content: RefObject<HTMLElement | null>,
) {
  const [trail, setTrail] = useState<{ key: string; back: string }>();
  const back = key !== null && trail?.key === key ? trail.back : null;

  const open = useCallback(
    (target: string) => {
      if (key === null) return;
      setTrail({ key: target, back: key });
      const el = content.current;
      // A keyboard open is instant; a click retarget is instant too (the sheet stays, only its body changes).
      if (el) runInstantOn(el, () => show(target));
      else show(target);
    },
    [key, show, content],
  );

  /** Instant, and focus returns to the control the peek was opened from (inside the peek it returned to). */
  const goBack = useCallback(() => {
    const el = content.current;
    if (back === null || key === null || !el) return;
    runInstantOn(el, () => flushSync(() => show(back)));
    const from = [...el.querySelectorAll<HTMLElement>("[data-peek-key]")].find(
      (n) => n.dataset.peekKey === key,
    );
    (from ?? el).focus();
  }, [back, key, show, content]);

  return { back, open, goBack };
}
