import { useRef } from "react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import type { AgentKey } from "@/features/agents/lifecycle";
import { postResetSession } from "./api";
import { focusComposer } from "./composer";

/** Start a new session (UI design §3.4): irreversible from the UI, so it is confirmed. Cancel returns
 *  focus to the button that opened it; a confirmed reset moves it to the composer. */
export function NewSessionDialog({
  agent,
  lastError,
  open,
  onOpenChange,
  onCancelFocus,
}: {
  agent: AgentKey;
  lastError?: string;
  open: boolean;
  onOpenChange(o: boolean): void;
  /** The dialog is opened without a Radix trigger, so the opener says where Cancel returns focus. */
  onCancelFocus(): void;
}) {
  const handle = `@${agent.handle}`;
  const confirmed = useRef(false);
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(o) => {
        if (o) confirmed.current = false;
        onOpenChange(o);
      }}
      title={`Start a new session for ${handle}?`}
      body={`${handle} won't remember anything from its current session. The history stays visible here, its files are kept, and waiting messages become its first turn.`}
      detail={
        lastError && (
          <p className="font-mono text-[0.8125rem] leading-[1.125rem] text-muted-foreground [overflow-wrap:anywhere]">
            {lastError}
          </p>
        )
      }
      confirmLabel={`Start new session for ${handle}`}
      pendingLabel="Starting…"
      onConfirm={async () => {
        await postResetSession(agent.ref);
        confirmed.current = true;
      }}
      onCloseAutoFocus={(e) => {
        e.preventDefault();
        if (confirmed.current) focusComposer();
        else onCancelFocus();
      }}
    />
  );
}
