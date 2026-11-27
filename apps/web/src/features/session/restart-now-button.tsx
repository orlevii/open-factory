import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { type AgentKey, restartAgentNow, useRestartPending } from "@/features/agents/lifecycle";

/** "Restart now" beside a pending restart's status line. aria-disabled "Restarting…" while the restart is
 *  in flight (the Interrupt pattern: focus stays on it). It is a sibling of the status line, never inside it. */
export function RestartNowButton({ agent, className }: { agent: AgentKey; className?: string }) {
  const qc = useQueryClient();
  const pending = useRestartPending(agent.ref);
  return (
    <Button
      variant="ghost"
      size="sm"
      className={className}
      aria-disabled={pending || undefined}
      onClick={() => {
        if (!pending) void restartAgentNow(agent, qc);
      }}
    >
      {pending ? "Restarting…" : "Restart now"}
    </Button>
  );
}
