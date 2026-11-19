import { CircleAlert, CircleCheck } from "lucide-react";
import { type ReactNode, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";

/**
 * The outcome of an action, next to the action. Both live regions are always mounted
 * (the ReconnectStrip pattern) so the text is announced when it appears.
 */
export function InlineOutcome({
  tone,
  children,
  undo,
  focusOnMount,
}: {
  tone: "success" | "error";
  children: ReactNode;
  undo?: () => void;
  focusOnMount?: boolean;
}) {
  const lineRef = useRef<HTMLDivElement>(null);
  const undoRef = useRef<HTMLButtonElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: focus once, when the outcome appears
  useEffect(() => {
    if (focusOnMount) (undoRef.current ?? lineRef.current)?.focus();
  }, []);
  const line = (
    <div
      ref={lineRef}
      tabIndex={-1}
      className="flex items-center gap-1.5 text-[0.8125rem] leading-[1.125rem] outline-none"
    >
      {tone === "success" ? (
        <CircleCheck aria-hidden="true" className="size-3.5 shrink-0 text-success" />
      ) : (
        <CircleAlert aria-hidden="true" className="size-3.5 shrink-0 text-destructive" />
      )}
      <span className={tone === "error" ? "text-destructive" : "text-muted-foreground"}>
        {children}
      </span>
      {undo && (
        <Button ref={undoRef} type="button" variant="ghost" size="xs" onClick={undo}>
          Undo
        </Button>
      )}
    </div>
  );
  return (
    <>
      <div role="status" aria-live="polite">
        {tone === "success" && line}
      </div>
      <div role="alert">{tone === "error" && line}</div>
    </>
  );
}
