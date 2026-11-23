import { useCallback, useState } from "react";
import type { Outcome } from "@/components/forms/form-outcome";
import { Button } from "@/components/ui/button";
import { CONFIG_PAGE_COPY, CONFIG_PAGE_MSG } from "./messages";

/** The outcome line of a page with one save (DESIGN.md → Page forms), shared by the agent page and the template tab. */
export type PageOutcome =
  | { kind: "none" }
  | { kind: "saved" | "discarded"; text: string }
  | { kind: "conflict" }
  | { kind: "error"; text: string };

export const NO_PAGE_OUTCOME: PageOutcome = { kind: "none" };

/** The next edit ends a "Saved." or a "Discarded." (and its Undo); an error or a conflict stays until acted on. */
export const clearTransient = (o: PageOutcome): PageOutcome =>
  o.kind === "saved" || o.kind === "discarded" ? NO_PAGE_OUTCOME : o;

/** One state for the outcome and its key, so the key never lags its message. `setOutcome` is stable. */
export function usePageOutcome() {
  const [state, setState] = useState<{ o: PageOutcome; key: number }>({
    o: NO_PAGE_OUTCOME,
    key: 0,
  });
  const setOutcome = useCallback(
    (next: PageOutcome | ((o: PageOutcome) => PageOutcome)) =>
      setState((s) => {
        const o = typeof next === "function" ? next(s.o) : next;
        return o === s.o ? s : { o, key: s.key + 1 };
      }),
    [],
  );
  return { outcome: state.o, outcomeKey: state.key, setOutcome };
}

/**
 * The FormOutcome for a page outcome: "Discarded." carries Undo inside its success line, a conflict reads "Changed since
 * you opened it." with Reload, and `drift` (a refetch moved the loaded value under the edits) shows that conflict
 * line before any Save does.
 */
export function toFormOutcome(
  o: PageOutcome,
  outcomeKey: number,
  {
    drift,
    notice,
    onUndo,
    onReload,
  }: { drift: boolean; notice?: string; onUndo(): void; onReload(): void },
): { outcome: Outcome; shown: boolean } {
  const shownKind = drift && o.kind !== "error" ? "conflict" : o.kind;
  const outcome: Outcome = { outcomeKey, notice };
  if (o.kind === "saved" && shownKind === "saved") outcome.success = o.text;
  if (o.kind === "discarded" && shownKind === "discarded")
    outcome.success = (
      <span className="inline-flex flex-wrap items-center gap-x-1.5">
        {o.text}
        <Button type="button" variant="ghost" size="xs" onClick={onUndo}>
          {CONFIG_PAGE_COPY.undo}
        </Button>
      </span>
    );
  if (o.kind === "error") outcome.error = o.text;
  if (shownKind === "conflict") {
    outcome.error = CONFIG_PAGE_MSG.changedSince;
    outcome.action = (
      <Button type="button" variant="ghost" size="xs" onClick={onReload}>
        {CONFIG_PAGE_COPY.reload}
      </Button>
    );
  }
  return { outcome, shown: shownKind !== "none" };
}
