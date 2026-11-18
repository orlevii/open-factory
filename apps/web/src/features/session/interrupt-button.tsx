import { Square } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { postInterrupt } from "./api";

/**
 * aria-disabled (not disabled) so the tooltip still shows and the button stays focusable.
 * No confirmation (UI §6). After a click it stays disabled until the status changes.
 */
export function InterruptButton({ slug, turnOpen }: { slug: string; turnOpen: boolean }) {
  const [sent, setSent] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset whenever turnOpen changes
  useEffect(() => {
    setSent(false);
  }, [turnOpen]);
  const enabled = turnOpen && !sent;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          aria-disabled={!enabled}
          className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
          onClick={() => {
            if (!enabled) return;
            setSent(true);
            void postInterrupt(slug).catch(() => {}); // 409: the turn already ended; nothing to show
          }}
        >
          <Square aria-hidden="true" />
          <span className="max-md:sr-only">Interrupt</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent className={enabled ? "md:hidden" : undefined}>
        {enabled ? "Interrupt" : "Nothing to interrupt."}
      </TooltipContent>
    </Tooltip>
  );
}
