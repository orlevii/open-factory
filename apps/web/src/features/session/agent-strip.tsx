import type { AgentSummary } from "@open-factory/shared";
import { RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

const Dot = () => <span aria-hidden="true">·</span>;

export const RESTART_WHY =
  "The agent finishes its current work, then restarts with the new settings. Its session is kept. Reminders it scheduled in this session are lost.";

const waitingText = (n: number) =>
  n > 0 ? ` (waiting on ${n} background ${n === 1 ? "task" : "tasks"})` : "";

/** Muted strip under the header (UI design §4.4); later specs add crons, usage and tasks here. */
export function AgentStrip({ agent }: { agent: AgentSummary }) {
  return (
    <div
      data-agent-strip
      className="flex min-h-8 shrink-0 flex-wrap items-center gap-x-2 border-b border-border px-4 py-1 text-[0.8125rem] leading-[1.125rem] text-muted-foreground md:px-6"
    >
      <span className="font-mono">{agent.slug}</span>
      <Dot />
      <span className="font-mono">{agent.template}</span>
      <Dot />
      {agent.reportsTo ? (
        <span>
          reports to <span className="font-mono">@{agent.reportsTo}</span>
        </span>
      ) : (
        <span>No manager</span>
      )}
      <Dot />
      <span>
        credential <span className="font-mono">{agent.credential}</span>
      </span>
      <Dot />
      <span>
        {agent.runtime === "docker" ? "Docker" : "Unsandboxed: runs directly on this machine"}
      </span>
      {/* Mounted before it fills, so the change is announced when a status frame sets it. */}
      <span role="status" className="inline-flex items-center gap-x-2">
        {agent.restartPending && (
          <>
            <Dot />
            <span className="inline-flex items-center gap-1.5">
              <RotateCw aria-hidden="true" className="size-3.5 shrink-0" />
              Restarts when idle to apply changes{waitingText(agent.restartWaitingOn)}
            </span>
          </>
        )}
      </span>
      {agent.restartPending && (
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="xs">
              Why?
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-72 text-[0.8125rem] leading-[1.125rem]">
            {RESTART_WHY}
          </PopoverContent>
        </Popover>
      )}
    </div>
  );
}
