import type { AgentSummary } from "@open-factory/shared";
import { CircleX } from "lucide-react";
import { type RefObject, useEffect, useRef, useState } from "react";
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
  open: controlledOpen,
  onOpenChange,
  returnFocusTo,
}: {
  agent: AgentSummary;
  /** Called when the human confirms, before the request: the view then knows the end is its own. */
  onStart(): void;
  onTerminated(agent: AgentSummary, ok: boolean): void;
  /** Controlled dialog, with no button of its own: the agent menu's Terminate… item opens it. */
  open?: boolean;
  onOpenChange?(open: boolean): void;
  /** Where focus goes when the dialog closes without terminating (the menu's ⋯ button). */
  returnFocusTo?: RefObject<HTMLElement | null>;
}) {
  const controlled = controlledOpen !== undefined;
  const agentRef = agent.ref;
  const terminated = agent.status === "terminated";
  const [ownOpen, setOwnOpen] = useState(false);
  const open = controlledOpen ?? ownOpen;
  const onOpenChangeNow = useRef(onOpenChange);
  onOpenChangeNow.current = onOpenChange;
  const setOpen = (o: boolean) => {
    setOwnOpen(o);
    onOpenChange?.(o);
  };
  const confirming = useRef(false);
  const done = useRef(false);
  // The latest state, for a request that settles after a terminated frame re-rendered the view.
  const terminatedNow = useRef(terminated);
  terminatedNow.current = terminated;
  useEffect(() => {
    if (terminated && !confirming.current && !done.current) {
      setOwnOpen(false);
      onOpenChangeNow.current?.(false);
    }
  }, [terminated]);

  async function confirm() {
    confirming.current = true;
    onStart();
    try {
      // Idempotent on the server: an agent someone else terminated meanwhile is a success too.
      const a = await postTerminate(agentRef);
      done.current = true;
      onTerminated(a, true);
    } catch (e) {
      // It ended anyway (a frame said so while the request was out): the goal is met, so the dialog
      // closes as on success rather than showing an error about an agent that is already gone.
      if (terminatedNow.current) {
        done.current = true;
        return;
      }
      onTerminated(agent, false);
      throw e;
    } finally {
      confirming.current = false;
    }
  }

  return (
    <>
      {!terminated && !controlled && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              aria-label={`Terminate @${agent.handle}`}
              onClick={() => setOpen(true)}
            >
              <CircleX aria-hidden="true" className="text-destructive" />
              <span className="max-md:sr-only">Terminate</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent className="md:hidden">Terminate</TooltipContent>
        </Tooltip>
      )}
      <TerminateDialog
        handle={agent.handle}
        open={open}
        onOpenChange={setOpen}
        onConfirm={confirm}
        onCloseAutoFocus={(e) => {
          // The trigger is gone once terminated: focus moves on instead (§5.2, §5.3).
          if (!done.current && !terminated) {
            if (controlled) {
              e.preventDefault();
              returnFocusTo?.current?.focus();
            }
            return;
          }
          e.preventDefault();
          focusReadOnly(done.current);
        }}
      />
    </>
  );
}
