import { type AgentSummary, ApiError } from "@open-factory/shared";
import { Pin, PinOff } from "lucide-react";
import { type ReactNode, useState } from "react";
import { InlineOutcome } from "@/components/inline-outcome";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { setWorkspacePin } from "./api";
import { NETWORK_ERROR } from "./composer";
import { atPhrase } from "./format";
import { formatBy } from "./format-by";
import { Actor } from "./spawn-block";
import { UnpinDialog } from "./unpin-dialog";

const Dot = () => <span aria-hidden="true">·</span>;

export const WHATS_KEPT =
  "The session history stays here for good. The workspace (its files and Claude config) is deleted 3 days after it was terminated, unless you pin it. Worktrees and branches it made in projects are never deleted.";

/** "Terminated by @lead today at 14:32." or, for the inactivity TTL, "Terminated on … after 3 days
 *  without activity." */
export function endedSentence(agent: AgentSummary, now: Date): ReactNode {
  const when = atPhrase(new Date(agent.terminatedAt ?? 0), now);
  const by = agent.terminatedBy;
  if (!by) return `Terminated ${when}.`;
  if (formatBy(by).kind === "ttl") return `Terminated ${when} after 3 days without activity.`;
  return (
    <>
      Terminated by <Actor by={by} /> {when}.
    </>
  );
}

/** What became of the workspace; `undefined` when there is nothing to say. */
export function workspaceSentence(agent: AgentSummary, now: Date): string | undefined {
  if (agent.workspaceDeletedAt)
    return `Workspace deleted ${atPhrase(new Date(agent.workspaceDeletedAt), now)}.`;
  if (agent.workspacePinned) return "Workspace pinned.";
  const grace = agent.workspaceGraceEndsAt;
  if (!grace) return undefined;
  const ends = new Date(grace);
  // The sweep runs every 10 minutes and retries a failing deletion: past the grace it is "due".
  if (ends.getTime() <= now.getTime())
    return `Workspace due for deletion since ${atPhrase(ends, now).replace(/^on /, "")} unless you pin it.`;
  return `Workspace will be deleted ${atPhrase(ends, now)} unless you pin it.`;
}

/**
 * A terminated agent's strip segment (S7 UI design §5.3), in place of the waiting/paused ones and
 * outside the strip's status region (a page load announces no dates): who ended it and when, the
 * workspace, the Pin / Unpin toggle and "What's kept?".
 */
export function TerminatedSegment({
  agent,
  onAgent,
}: {
  agent: AgentSummary;
  onAgent?: (a: AgentSummary) => void;
}) {
  const now = new Date();
  const workspace = workspaceSentence(agent, now);
  const stuck = agent.stuck
    ? " Its container couldn't be removed; the factory keeps retrying."
    : "";
  const canPin =
    !agent.workspaceDeletedAt && (agent.workspacePinned || !!agent.workspaceGraceEndsAt);
  return (
    <>
      <Dot />
      <span data-terminated className="contents">
        <span data-terminated-text>
          {endedSentence(agent, now)}
          {`${workspace ? ` ${workspace}` : ""}${stuck}`}
        </span>
        {canPin && <PinToggle agent={agent} onAgent={onAgent} />}
        <WhatsKept />
      </span>
    </>
  );
}

type Outcome = { tone: "success" | "error"; text: string };

/** One button whose label swaps (focus stays on it); the outcome goes to S4's inline-outcome
 *  region. Pin, and Unpin within the grace, act at once; Unpin after the grace confirms. */
export function PinToggle({
  agent,
  onAgent,
}: {
  agent: AgentSummary;
  onAgent?: (a: AgentSummary) => void;
}) {
  const pinned = agent.workspacePinned === true;
  const [pending, setPending] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>();
  const graceOver =
    agent.workspaceGraceEndsAt !== undefined &&
    Date.now() >= Date.parse(agent.workspaceGraceEndsAt);

  const request = async (pin: boolean) => {
    const a = await setWorkspacePin(agent.slug, pin);
    onAgent?.(a);
    setOutcome({ tone: "success", text: pin ? "Workspace pinned." : "Workspace unpinned." });
  };
  async function act(pin: boolean) {
    setPending(true);
    setOutcome(undefined);
    try {
      await request(pin);
    } catch (e) {
      setOutcome({ tone: "error", text: e instanceof ApiError ? e.message : NETWORK_ERROR });
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <Button
        data-pin-toggle
        variant="ghost"
        size="xs"
        aria-disabled={pending || undefined}
        onClick={() => {
          if (pending) return;
          if (pinned && graceOver) {
            setOutcome(undefined);
            setConfirm(true);
          } else void act(!pinned);
        }}
      >
        {pinned ? <PinOff aria-hidden="true" /> : <Pin aria-hidden="true" />}
        {pinned ? "Unpin workspace" : "Pin workspace"}
      </Button>
      {/* Its own line: empty, a zero-height row that adds no gap. */}
      <div className="basis-full">
        <InlineOutcome tone={outcome?.tone}>{outcome?.text}</InlineOutcome>
      </div>
      <UnpinDialog
        slug={agent.slug}
        open={confirm}
        onOpenChange={setConfirm}
        onConfirm={() => request(false)}
      />
    </>
  );
}

export function WhatsKept() {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="xs">
          What's kept?
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 text-[0.8125rem] leading-[1.125rem]">
        <p>{WHATS_KEPT}</p>
      </PopoverContent>
    </Popover>
  );
}
