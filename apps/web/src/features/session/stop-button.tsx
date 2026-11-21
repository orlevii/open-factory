import { ApiError } from "@open-factory/shared";
import { CircleStop } from "lucide-react";
import { type Ref, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { postInterrupt } from "./api";

/** Lets the composer's Esc go through the same path as a click (U3 §6.2). */
export type StopHandle = {
  /** Sends the interrupt when there is something to stop; false when it did nothing. */
  stop(): boolean;
};

/**
 * Stop, left of Send while a turn is open (U3 §6.1). One `postInterrupt`, then a spinner and
 * "Stopping…" until the turn changes (`turnEpoch`); a 409 (the turn already ended) is ignored and any
 * other failure goes to `onError` for the composer's error line. While a compaction runs it reads
 * "Compacting…" and does nothing: the runtime never interrupts one (D5). aria-disabled, not disabled,
 * so it keeps focus and its name.
 */
export function StopButton({
  slug,
  turnOpen,
  turnEpoch,
  compacting = false,
  onError,
  ref,
}: {
  slug: string;
  turnOpen: boolean;
  /** Changes on every turn edge, even a close and reopen that landed in one commit. */
  turnEpoch: number;
  compacting?: boolean;
  /** Called with a failure, and with `undefined` when a new attempt starts. */
  onError(error: unknown): void;
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
    postInterrupt(slug).catch((e: unknown) => {
      if (e instanceof ApiError && e.status === 409) return;
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
      aria-busy={pending || undefined}
      onClick={stop}
    >
      {pending ? <Spinner /> : <CircleStop aria-hidden="true" />}
      {/* Below ~24rem of composer (200% text) only the icon shows; the label stays the name. */}
      <span className="@max-[24rem]:sr-only">
        {pending ? "Stopping…" : compacting ? "Compacting…" : "Stop"}
      </span>
    </Button>
  );
}
