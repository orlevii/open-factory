import type { AgentSummary } from "@open-factory/shared";
import { useQueryClient } from "@tanstack/react-query";
import { FilePlus2, RefreshCcw } from "lucide-react";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { type AgentKey, restartAgentNow, useRestartPending } from "@/features/agents/lifecycle";
import { focusComposer } from "./composer";
import { NewSessionDialog } from "./new-session-dialog";

/**
 * Restart and Start a new session: the buttons show only while Errored, in place of Compact and
 * Interrupt. Mounted for every status, so an open dialog survives the status frame that a confirmed
 * reset publishes before its response, and can still move focus to the composer when it closes.
 */
export function RecoveryActions({ agent }: { agent: AgentSummary }) {
  const [dialog, setDialog] = useState<{ open: boolean; lastError?: string }>({ open: false });
  const trigger = useRef<HTMLButtonElement>(null);
  const kind = agent.errorKind;
  const errored = agent.status === "errored";
  // A Restart certain to fail isn't offered (Agent details' Runtime says the local runtime is off).
  const canRestart = errored && kind !== "resume_unrecoverable" && !agent.runtimeDisabled;
  const canReset = errored && (kind === "resume" || kind === "resume_unrecoverable");
  return (
    <>
      {canRestart && <RestartButton agent={agent} />}
      {canReset && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              ref={trigger}
              variant="ghost"
              // The error is kept as it was when opened: the reset clears it before the dialog closes.
              onClick={() => setDialog({ open: true, lastError: agent.lastError })}
            >
              <FilePlus2 aria-hidden="true" />
              <span className="max-md:sr-only">Start a new session</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent className="md:hidden">Start a new session</TooltipContent>
        </Tooltip>
      )}
      <NewSessionDialog
        agent={agent}
        lastError={dialog.lastError}
        open={dialog.open}
        onOpenChange={(open) => setDialog((d) => ({ ...d, open }))}
        onCancelFocus={() => trigger.current?.focus()}
      />
    </>
  );
}

/**
 * aria-disabled "Restarting…" while pending (the S3 Interrupt pattern). `useRestartPending` ends it once
 * the response and the next status frame are both in, or on the next `error` event, so a Restart that
 * fails comes back as "Restart"; the failure is a toast.
 */
function RestartButton({ agent }: { agent: AgentKey }) {
  const qc = useQueryClient();
  const pending = useRestartPending(agent.ref);
  const label = pending ? "Restarting…" : "Restart";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          aria-disabled={pending || undefined}
          onClick={() => {
            if (!pending)
              void restartAgentNow(agent, qc).then((ok) => {
                if (ok) focusComposer();
              });
          }}
        >
          <RefreshCcw aria-hidden="true" />
          <span className="max-md:sr-only">{label}</span>
        </Button>
      </TooltipTrigger>
      {/* The label is visible from md up, so the tooltip only serves icon-only widths. */}
      <TooltipContent className="md:hidden">{label}</TooltipContent>
    </Tooltip>
  );
}
