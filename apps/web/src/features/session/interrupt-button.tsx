import { ApiError } from "@open-factory/shared";
import { CircleAlert, CircleStop } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { postInterrupt } from "./api";
import { focusComposer, NETWORK_ERROR } from "./composer";

/**
 * aria-disabled (not disabled) so the tooltip still shows and the button stays focusable.
 * No confirmation (UI §6). After a click it stays disabled until the status changes; a 409
 * (the turn ended meanwhile) is ignored, any other failure re-enables it with an inline error.
 */
export function InterruptButton({
  slug,
  turnOpen,
  turnEpoch,
}: {
  slug: string;
  turnOpen: boolean;
  /** Changes on every turn edge, even a close and reopen that landed in one commit. */
  turnEpoch: number;
}) {
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | undefined>();
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset whenever a turn opens or closes
  useEffect(() => {
    setSent(false);
    setError(undefined);
  }, [turnEpoch]);
  const enabled = turnOpen && !sent;
  // The header shows Stop only while a turn is open (U2 §8.2): when it unmounts under the focus (the
  // turn closed), focus goes to the composer rather than <body>. The cleanup runs before React
  // removes the button, so the button can still be checked for focus.
  const button = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    const el = button.current;
    return () => {
      if (el && el === document.activeElement) requestAnimationFrame(focusComposer);
    };
  }, []);

  async function interrupt() {
    setSent(true);
    setError(undefined);
    try {
      await postInterrupt(slug);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) return;
      setSent(false);
      setError(e instanceof ApiError ? e.message : NETWORK_ERROR);
    }
  }

  const tip = sent ? "Interrupt sent" : turnOpen ? "Interrupt" : "Nothing to interrupt.";
  return (
    <>
      {error && (
        <p
          role="alert"
          title={error}
          className="flex max-w-[16rem] min-w-0 items-center gap-1.5 text-[0.8125rem] leading-[1.125rem] text-destructive"
        >
          <CircleAlert aria-hidden="true" className="size-3.5 shrink-0" />
          <span className="truncate">Couldn't interrupt: {error}</span>
        </p>
      )}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            ref={button}
            variant="ghost"
            aria-disabled={!enabled}
            onClick={() => {
              if (enabled) void interrupt();
            }}
          >
            <CircleStop aria-hidden="true" />
            <span className="max-md:sr-only">Interrupt</span>
          </Button>
        </TooltipTrigger>
        {/* The enabled label is visible from md up, so that tooltip only serves icon-only widths. */}
        <TooltipContent className={enabled ? "md:hidden" : undefined}>{tip}</TooltipContent>
      </Tooltip>
    </>
  );
}
