import { Check, Copy } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

export type CopyState = "idle" | "copied" | "failed";

/** How long the check holds, and how long "Couldn't copy" stays. */
const HOLD_MS = { copied: 1500, failed: 3000 } as const;

/**
 * One clipboard write with inline feedback (U3 §7.5): "copied" for 1.5s, or "failed" (a refused
 * clipboard, or none over plain http) for 3s. `instant` records that the copy came from the keyboard,
 * so the check appears without its transition.
 */
export function useCopy(): {
  state: CopyState;
  instant: boolean;
  copy(text: string, viaKeyboard: boolean): void;
} {
  // `n` counts outcomes, so a copy within the hold restarts it (the state alone stays "copied").
  const [{ state, instant, n }, set] = useState<{
    state: CopyState;
    instant: boolean;
    n: number;
  }>({ state: "idle", instant: false, n: 0 });
  // biome-ignore lint/correctness/useExhaustiveDependencies: `n` restarts the hold on a repeat outcome
  useEffect(() => {
    if (state === "idle") return;
    const t = setTimeout(() => set((s) => ({ ...s, state: "idle" })), HOLD_MS[state]);
    return () => clearTimeout(t);
  }, [state, n]);
  const copy = useCallback((text: string, viaKeyboard: boolean) => {
    const done = (next: CopyState) =>
      set((s) => ({ state: next, instant: viaKeyboard, n: s.n + 1 }));
    const write = navigator.clipboard?.writeText(text);
    if (!write) {
      done("failed");
      return;
    }
    write.then(
      () => done("copied"),
      () => done("failed"),
    );
  }, []);
  return { state, instant, copy };
}

/** The icon slot of a copy control: `idle` crossfades to a check (150ms in with scale 0.8→1 and a
 *  1px blur, 100ms out; opacity only under reduced motion; no transition when `instant`). */
export function CopyIcon({
  state,
  instant,
  idle,
}: {
  state: CopyState;
  instant: boolean;
  idle: ReactNode;
}) {
  const copied = state === "copied";
  return (
    <span
      data-copy-feedback={copied ? "copied" : "idle"}
      {...(instant ? { "data-instant": "" } : {})}
      className="copy-feedback relative inline-grid size-3.5 place-items-center"
    >
      <span className="copy-feedback-idle col-start-1 row-start-1 inline-flex">{idle}</span>
      <Check aria-hidden="true" className="copy-feedback-check col-start-1 row-start-1 size-3.5" />
    </span>
  );
}

/** "Couldn't copy", inline beside the control (no toast). */
export function CopyFailed({ className = "" }: { className?: string }) {
  return (
    <span
      className={`rounded-sm bg-popover px-1.5 text-[0.8125rem] leading-[1.125rem] text-muted-foreground ${className}`}
    >
      Couldn't copy
    </span>
  );
}

/** A code block's Copy button (U3 §7.5): top-right, shown on hover or focus within the block
 *  (always on touch), with the row menu's feedback. */
export function CopyButton({ text }: { text: string }) {
  const { state, instant, copy } = useCopy();
  return (
    <span className="absolute top-1 right-1 flex items-center gap-1">
      {state === "failed" && <CopyFailed />}
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={state === "copied" ? "Copied" : "Copy"}
        // A keyboard-triggered click (Enter/Space) has detail 0: its feedback is instant.
        onClick={(e) => copy(text, e.detail === 0)}
        // Feedback stays visible after the pointer leaves.
        className={`${state === "idle" ? "hidden" : "inline-flex"} bg-card text-muted-foreground group-focus-within/code:inline-flex group-hover/code:inline-flex pointer-coarse:inline-flex`}
      >
        <CopyIcon
          state={state}
          instant={instant}
          idle={<Copy aria-hidden="true" className="size-3.5" />}
        />
      </Button>
    </span>
  );
}
