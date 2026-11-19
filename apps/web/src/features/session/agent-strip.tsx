import type { AgentSummary, WaitingOn } from "@open-factory/shared";
import { RotateCw, ShieldOff } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { resetPhrase } from "./status-badge";

const Dot = () => <span aria-hidden="true">·</span>;

export const RESTART_WHY =
  "The agent finishes its current turn and background tasks, then restarts with the new settings. Its session is kept. Its crons from this session stop, and it's told which, so it can recreate them.";

const waitingText = (n: number) =>
  n > 0 ? ` (waiting on ${n} background ${n === 1 ? "task" : "tasks"})` : "";

/** A "Why?" ghost button with its explanation in a popover; `label` is its distinct accessible name.
 *  The explanation is one paragraph: PopoverContent is a flex column, so loose text and inline
 *  elements would otherwise each land on their own line. */
function Why({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="xs" aria-label={label}>
          Why?
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 text-[0.8125rem] leading-[1.125rem]">
        <p>{children}</p>
      </PopoverContent>
    </Popover>
  );
}

function Runtime({ agent }: { agent: AgentSummary }) {
  if (agent.runtime === "docker")
    return agent.image ? (
      <span>
        Docker (<span className="font-mono">{agent.image}</span>)
      </span>
    ) : (
      <span>Docker</span>
    );
  if (!agent.runtimeDisabled) return <span>Unsandboxed: runs directly on this machine</span>;
  return (
    <>
      <span className="inline-flex items-center gap-1.5">
        <ShieldOff aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
        Local runtime disabled on this factory
      </span>
      <Why label="Why is the local runtime disabled?">
        An operator has to allow unsandboxed agents by setting{" "}
        <code className="font-mono">FACTORY_ALLOW_LOCAL_RUNTIME=true</code>. Until then this agent
        can't start.
      </Why>
    </>
  );
}

const MAX_DESCRIPTION = 40;

/** Re-renders once a minute while `active`, so elapsed times stay current. */
function useMinuteTick(active: boolean) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setTick((t) => t + 1), 60_000);
    return () => clearInterval(id);
  }, [active]);
}

/** "3m" from `startedAt` (client-side, spec §8.2), "1h 5m" past an hour. */
function elapsed(startedAt: string): string {
  const m = Math.max(0, Math.floor((Date.now() - Date.parse(startedAt)) / 60_000) || 0);
  if (m < 60) return `${m}m`;
  return m % 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${Math.floor(m / 60)}h`;
}

/** Plain text, never markdown. A long description shows truncated (aria-hidden) with the full text
 *  visually hidden beside it, so screen readers get it whole without a `title` duplicate. */
function Description({ text }: { text: string }) {
  if (text.length <= MAX_DESCRIPTION) return <>{text}</>;
  return (
    <>
      <span aria-hidden="true">{`${text.slice(0, MAX_DESCRIPTION).trimEnd()}…`}</span>
      <span className="sr-only">{text}</span>
    </>
  );
}

type Task = WaitingOn["tasks"][number];
const TaskText = ({ task }: { task: Task }) => (
  <>
    <Description text={task.description || task.taskId} /> (background, {elapsed(task.startedAt)})
  </>
);

/** "Waiting on: pnpm test (background, 3m) · 2 crons" (UI design §3.2); only while non-empty. */
function WaitingOnSegment({ waitingOn }: { waitingOn: WaitingOn }) {
  const { tasks, crons } = waitingOn;
  useMinuteTick(tasks.length > 0);
  if (tasks.length === 0 && crons === 0) return null;
  const parts: { key: string; node: ReactNode }[] = [];
  const [first] = tasks;
  if (first && tasks.length > 2)
    parts.push({
      key: first.taskId,
      node: (
        <>
          <TaskText task={first} /> and {tasks.length - 1} more
        </>
      ),
    });
  else for (const t of tasks) parts.push({ key: t.taskId, node: <TaskText task={t} /> });
  if (crons > 0) parts.push({ key: "crons", node: crons === 1 ? "1 cron" : `${crons} crons` });
  return (
    <>
      <Dot />
      <span data-waiting-on>
        Waiting on:{" "}
        {parts.map((p, i) => (
          <span key={p.key}>
            {i > 0 && (
              <>
                {" "}
                <Dot />{" "}
              </>
            )}
            {p.node}
          </span>
        ))}
      </span>
    </>
  );
}

/** Why messages aren't going out right now: an image pull, the slot cap, or a paused credential. */
function DetailSegment({ agent, slotsMax }: { agent: AgentSummary; slotsMax?: number }) {
  let text: ReactNode = null;
  if (agent.pulling) text = "Pulling the image…";
  else if (agent.status === "queued")
    // Nothing until the cap is known. A cap of one has no "all": the singular form of the UI doc's line.
    text = !slotsMax
      ? null
      : slotsMax === 1
        ? "Queued: the only slot is in use."
        : `Queued: all ${slotsMax} slots are in use.`;
  else if (agent.status === "rate_limited")
    text = (
      <>
        Paused: credential <span className="font-mono">{agent.credential}</span> is rate-limited
        {resetPhrase(agent)?.joined ?? ""}. Messages wait until then.
      </>
    );
  if (!text) return null;
  return (
    <>
      <Dot />
      <span>{text}</span>
    </>
  );
}

/** Muted strip under the header (UI design §3.2). Waiting on, the paused/queued detail and the
 *  per-minute timer sit outside the `role="status"` region: the session announcer already reports
 *  status changes, so nothing here is re-announced every minute. */
export function AgentStrip({ agent, slotsMax }: { agent: AgentSummary; slotsMax?: number }) {
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
      <Runtime agent={agent} />
      {/* Mounted before it fills, so the change is announced when a status frame sets it.
          `display: contents` keeps it out of the flex layout: empty, it adds no item (and no
          second gap) before the next segment; filled, its children space like the rest. */}
      <span role="status" className="contents">
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
      {agent.restartPending && <Why label="Why does it restart?">{RESTART_WHY}</Why>}
      <WaitingOnSegment waitingOn={agent.waitingOn} />
      <DetailSegment agent={agent} slotsMax={slotsMax} />
    </div>
  );
}
