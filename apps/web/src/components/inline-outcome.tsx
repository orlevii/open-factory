import { CircleAlert, CircleCheck } from "lucide-react";
import { type ReactNode, useEffect, useRef } from "react";
import { ROW_GRID } from "@/components/row-grid";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

/**
 * The outcome of an action, next to the action. Both live regions are always mounted
 * (the ReconnectStrip pattern) so the text is announced when it appears: render it with no
 * `tone` before the action runs, then set one. `pending` is a muted line in the status region.
 */
export function InlineOutcome({
  tone,
  children,
  undo,
  focusOnMount,
  focusKey,
  inRows,
}: {
  tone?: "success" | "error" | "pending";
  children?: ReactNode;
  undo?: () => void;
  focusOnMount?: boolean;
  /** Each new non-undefined value moves focus to Undo, or to the line itself: for an outcome
   *  that replaced the control that had focus. */
  focusKey?: unknown;
  /** On the inbox rows' grid: the icon in the dot column, the text aligned with the rows' text. */
  inRows?: boolean;
}) {
  const lineRef = useRef<HTMLDivElement>(null);
  const undoRef = useRef<HTMLButtonElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: focus once, when the outcome appears
  useEffect(() => {
    if (focusOnMount) (undoRef.current ?? lineRef.current)?.focus();
  }, []);
  const lastKey = useRef(focusKey);
  useEffect(() => {
    if (focusKey === lastKey.current) return;
    lastKey.current = focusKey;
    if (focusKey !== undefined) (undoRef.current ?? lineRef.current)?.focus();
  }, [focusKey]);
  const mark = inRows ? "justify-self-center" : "";
  const text = (
    <span className={`min-w-0 ${tone === "error" ? "text-destructive" : "text-muted-foreground"}`}>
      {children}
    </span>
  );
  const undoButton = undo && (
    <Button ref={undoRef} type="button" variant="ghost" size="xs" onClick={undo}>
      Undo
    </Button>
  );
  const line = tone && (
    <div
      ref={lineRef}
      tabIndex={-1}
      className={`${inRows ? `grid ${ROW_GRID} items-center` : "flex items-center gap-x-1.5"} text-[0.8125rem] leading-[1.125rem] outline-none`} // ui-contract:allow programmatic focus target, not interactive
    >
      {tone === "success" && (
        <CircleCheck aria-hidden="true" className={`size-3.5 shrink-0 text-success ${mark}`} />
      )}
      {tone === "error" && (
        <CircleAlert aria-hidden="true" className={`size-3.5 shrink-0 text-destructive ${mark}`} />
      )}
      {tone === "pending" && (
        <Spinner size="text" className={`shrink-0 text-muted-foreground ${mark}`} />
      )}
      {inRows ? (
        <div className="flex min-w-0 items-center gap-x-1.5">
          {text}
          {undoButton}
        </div>
      ) : (
        <>
          {text}
          {undoButton}
        </>
      )}
    </div>
  );
  return (
    <>
      <div role="status" aria-live="polite">
        {tone !== "error" && line}
      </div>
      <div role="alert">{tone === "error" && line}</div>
    </>
  );
}
