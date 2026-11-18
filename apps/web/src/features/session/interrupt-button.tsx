import { ApiError } from "@open-factory/shared";
import { CircleAlert, Square } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { postInterrupt } from "./api";
import { NETWORK_ERROR } from "./composer";

/**
 * aria-disabled (not disabled) so the tooltip still shows and the button stays focusable.
 * No confirmation (UI §6). After a click it stays disabled until the status changes; a 409
 * (the turn ended meanwhile) is ignored, any other failure re-enables it with an inline error.
 */
export function InterruptButton({ slug, turnOpen }: { slug: string; turnOpen: boolean }) {
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | undefined>();
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset whenever turnOpen changes
  useEffect(() => {
    setSent(false);
    setError(undefined);
  }, [turnOpen]);
  const enabled = turnOpen && !sent;

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
            variant="ghost"
            aria-disabled={!enabled}
            className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50 aria-disabled:hover:bg-transparent aria-disabled:hover:text-inherit aria-disabled:active:scale-100 dark:aria-disabled:hover:bg-transparent"
            onClick={() => {
              if (enabled) void interrupt();
            }}
          >
            <Square aria-hidden="true" />
            <span className="max-md:sr-only">Interrupt</span>
          </Button>
        </TooltipTrigger>
        {/* The enabled label is visible from md up, so that tooltip only serves icon-only widths. */}
        <TooltipContent className={enabled ? "md:hidden" : undefined}>{tip}</TooltipContent>
      </Tooltip>
    </>
  );
}
