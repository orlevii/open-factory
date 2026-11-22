import { ApiError } from "@open-factory/shared";
import { CircleStop } from "lucide-react";
import { type Ref, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

/** Lets the composer's Esc go through the same path as a click (U3 §6.2). */
export type StopHandle = {
  /** Sends the interrupt when there is something to stop; false when it did nothing. */
  stop(): boolean;
};

/**
 * Stop, left of Send while a turn is open (U3 §6.1). One `onStop` (the session's `postInterrupt`), then a spinner and
 * "Stopping…" until `turnEpoch` changes (a turn edge, or the 10s fallback's `interrupt_unconfirmed`, after
 * which a turn that ran on can be stopped again); a 409 (the turn already ended) is ignored and any
 * other failure goes to `onError` for the composer's error line. While a compaction runs it reads
 * "Compacting…" and does nothing: the runtime never interrupts one (D5). aria-disabled, not disabled,
 * so it keeps focus and its name.
 */
export function StopButton({
  onStop,
  turnOpen,
  turnEpoch,
  compacting = false,
  onError,
  className,
  ref,
}: {
  /** Sends the interrupt; a rejection with a 409 means the turn already ended. */
  onStop(): Promise<unknown>;
  turnOpen: boolean;
  /** The session's `stopEpoch`: changes on every turn edge, even a close and reopen that landed in one
   *  commit, and on a live `interrupt_unconfirmed`. */
  turnEpoch: number;
  compacting?: boolean;
  /** Called with a failure, and with `undefined` when a new attempt starts. */
  onError(error: unknown): void;
  className?: string;
  ref?: Ref<StopHandle>;
}) {
  const [pending, setPending] = useState(false);
  // A turn edge resets Stop, adjusted during render (no effect, no extra commit).
  const [epoch, setEpoch] = useState(turnEpoch);
  if (epoch !== turnEpoch) {
    setEpoch(turnEpoch);
    setPending(false);
  }
  const enabled = turnOpen && !pending && !compacting;

  function stop() {
    if (!enabled) return false;
    setPending(true);
    onError(undefined);
    onStop().catch((e: unknown) => {
      if (e instanceof ApiError && e.status === 409) {
        // The turn already ended: its edge resets Stop. A compaction never ends that way, and the
        // status frame already says "Compacting…", so the spinner has nothing to wait for.
        if (e.code === "compacting") setPending(false);
        return;
      }
      setPending(false);
      onError(e);
    });
    return true;
  }
  useImperativeHandle(ref, () => ({ stop }));

  // When Stop unmounts under the focus (the turn closed), focus goes to the composer's box rather
  // than <body>. The cleanup runs before React removes the button, so it can still be checked.
  const button = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    const el = button.current;
    return () => {
      if (!el || el !== document.activeElement) return;
      const box = el.closest("form")?.querySelector("textarea");
      requestAnimationFrame(() => box?.focus());
    };
  }, []);

  return (
    <Button
      ref={button}
      type="button"
      variant="outline"
      aria-disabled={!enabled}
      className={className}
      aria-busy={pending || undefined}
      onClick={stop}
    >
      {pending ? <Spinner /> : <CircleStop aria-hidden="true" />}
      {/* Below 20rem of composer (200% text) only the icon shows; the label stays the name. A phone at
          100% text (a ~22rem composer) keeps "Stop". */}
      <span className="@max-[20rem]:sr-only">
        {pending ? "Stopping…" : compacting ? "Compacting…" : "Stop"}
      </span>
    </Button>
  );
}
