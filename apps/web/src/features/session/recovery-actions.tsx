import { type AgentSummary, ApiError } from "@open-factory/shared";
import { CircleAlert, FilePlus2, RefreshCcw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useWs } from "@/lib/ws-context";
import { postRestart } from "./api";
import { focusComposer, NETWORK_ERROR } from "./composer";
import { NewSessionDialog } from "./new-session-dialog";

const DISABLED =
  "aria-disabled:cursor-not-allowed aria-disabled:opacity-50 aria-disabled:hover:bg-transparent aria-disabled:hover:text-inherit aria-disabled:active:scale-100 dark:aria-disabled:hover:bg-transparent";

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
  // A Restart certain to fail isn't offered (the strip's disabled segment explains the gate).
  const canRestart = errored && kind !== "resume_unrecoverable" && !agent.runtimeDisabled;
  const canReset = errored && (kind === "resume" || kind === "resume_unrecoverable");
  return (
    <>
      {canRestart && <RestartButton slug={agent.slug} />}
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
        slug={agent.slug}
        lastError={dialog.lastError}
        open={dialog.open}
        onOpenChange={(open) => setDialog((d) => ({ ...d, open }))}
        onCancelFocus={() => trigger.current?.focus()}
      />
    </>
  );
}

/**
 * aria-disabled "Restarting…" while pending (the S3 Interrupt pattern). Pending ends once the
 * response and the next status frame are both in, or on the next `error` event, whichever comes
 * first, so a Restart that fails comes back as "Restart". A 409 not_errored is ignored.
 */
function RestartButton({ slug }: { slug: string }) {
  const ws = useWs();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const progress = useRef({ responded: false, framed: false });

  useEffect(() => {
    if (!pending) return;
    return ws.listen((m) => {
      if (m.type === "agent_status" && m.agent === slug) {
        progress.current.framed = true;
        if (progress.current.responded) setPending(false);
      } else if (m.type === "session_event" && m.agent === slug && m.event.event.type === "error") {
        setPending(false);
      }
    });
  }, [ws, slug, pending]);

  async function restart() {
    progress.current = { responded: false, framed: false };
    setPending(true);
    setError(undefined);
    try {
      await postRestart(slug);
      progress.current.responded = true;
      if (progress.current.framed) setPending(false);
      focusComposer();
    } catch (e) {
      setPending(false);
      if (e instanceof ApiError && e.code === "not_errored") return;
      setError(e instanceof ApiError ? e.message : NETWORK_ERROR);
    }
  }

  const label = pending ? "Restarting…" : "Restart";
  return (
    <>
      {error && (
        <p
          role="alert"
          className="flex max-w-[16rem] min-w-0 items-center gap-1.5 text-[0.8125rem] leading-[1.125rem] text-destructive"
        >
          <CircleAlert aria-hidden="true" className="size-3.5 shrink-0" />
          <span>Couldn't restart: {error}</span>
        </p>
      )}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            aria-disabled={pending || undefined}
            className={DISABLED}
            onClick={() => {
              if (!pending) void restart();
            }}
          >
            <RefreshCcw aria-hidden="true" />
            <span className="max-md:sr-only">{label}</span>
          </Button>
        </TooltipTrigger>
        {/* The label is visible from md up, so the tooltip only serves icon-only widths. */}
        <TooltipContent className="md:hidden">{label}</TooltipContent>
      </Tooltip>
    </>
  );
}
