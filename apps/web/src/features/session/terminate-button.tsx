import type { AgentSummary } from "@open-factory/shared";
import { CircleX } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { postTerminate } from "./api";
import { focusReadOnly } from "./composer";
import { TerminateDialog } from "./terminate-dialog";

/**
 * Terminate (S7 UI design §5.2): a ghost button with a crimson icon and an ink label, icon-only
 * below `md`. Mounted while terminated too (without its button), so a confirmed dialog can close
 * after the detail has turned terminated and send focus to Pin workspace (or the read-only line).
 * A termination by someone else while the dialog is open (not confirming) closes it.
 */
export function TerminateButton({
  agent,
  onStart,
  onTerminated,
}: {
  agent: AgentSummary;
  /** Called when the human confirms, before the request: the view then knows the end is its own. */
  onStart(): void;
  onTerminated(agent: AgentSummary, ok: boolean): void;
}) {
  const slug = agent.slug;
  const terminated = agent.status === "terminated";
  const [open, setOpen] = useState(false);
  const confirming = useRef(false);
  const done = useRef(false);
  useEffect(() => {
    if (terminated && !confirming.current && !done.current) setOpen(false);
  }, [terminated]);

  async function confirm() {
    confirming.current = true;
    onStart();
    try {
      // Idempotent on the server: an agent someone else terminated meanwhile is a success too.
      const a = await postTerminate(slug);
      done.current = true;
      onTerminated(a, true);
    } catch (e) {
      onTerminated(agent, false);
      throw e;
    } finally {
      confirming.current = false;
    }
  }

  return (
    <>
      {!terminated && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" aria-label={`Terminate @${slug}`} onClick={() => setOpen(true)}>
              <CircleX aria-hidden="true" className="text-destructive" />
              <span className="max-md:sr-only">Terminate</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent className="md:hidden">Terminate</TooltipContent>
        </Tooltip>
      )}
      <TerminateDialog
        slug={slug}
        open={open}
        onOpenChange={setOpen}
        onConfirm={confirm}
        onCloseAutoFocus={(e) => {
          // The trigger is gone once terminated: focus moves on instead (§5.2, §5.3).
          if (!done.current && !terminated) return;
          e.preventDefault();
          focusReadOnly(done.current);
        }}
      />
    </>
  );
}
