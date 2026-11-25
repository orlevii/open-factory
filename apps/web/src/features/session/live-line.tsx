import { type AgentSummary, ApiError, summarizeChanges } from "@open-factory/shared";
import { Link } from "@tanstack/react-router";
import { Pin, PinOff } from "lucide-react";
import { useState } from "react";
import { InlineOutcome } from "@/components/inline-outcome";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { setWorkspacePin } from "./api";
import { NETWORK_ERROR } from "./composer";
import { formatInboxTime, formatResetTime, formatTime } from "./format";
import { formatBy } from "./format-by";
import { UnpinDialog } from "./unpin-dialog";

export type LiveFact = {
  kind: "terminated" | "errored" | "queued" | "restart" | "waiting" | "crons";
  text: string;
  /** The full text when `text` is shortened. */
  title?: string;
};

function firstLine(text: string): string {
  return (
    text
      .split("\n")
      .find((l) => l.trim() !== "")
      ?.trim() ?? text
  );
}

function terminatedText(agent: AgentSummary, now: Date): string {
  const by = agent.terminatedBy ? formatBy(agent.terminatedBy) : null;
  const who =
    by?.kind === "agent"
      ? ` by @${by.slug}`
      : by?.kind === "human"
        ? ` by ${by.handle}`
        : by?.kind === "ttl"
          ? " after 3 days without activity"
          : "";
  const parts = [`Terminated${who}`];
  if (agent.terminatedAt) parts.push(formatInboxTime(new Date(agent.terminatedAt), now));
  if (agent.workspaceDeletedAt) parts.push("workspace deleted");
  else if (agent.workspacePinned) parts.push("workspace pinned");
  else if (agent.workspaceGraceEndsAt) {
    const ends = new Date(agent.workspaceGraceEndsAt);
    parts.push(
      ends.getTime() <= now.getTime() ? "deletion due" : `deletes ${formatResetTime(ends, now)}`,
    );
  }
  return parts.join(" · ");
}

/** I2 §7.3: what the pending restart applies, as at most three kinds; the full list is the title. */
function restartFact(changes: string[]): LiveFact {
  if (changes.length === 0) return { kind: "restart", text: "Restarts when idle" };
  return {
    kind: "restart",
    text: `Restarts when idle to apply: ${summarizeChanges(changes)}`,
    title: changes.join("\n"),
  };
}

function queuedText(agent: AgentSummary, slotsMax?: number): string | null {
  if (agent.pulling) return "Pulling the image…";
  if (agent.status !== "queued" || !slotsMax) return null;
  return slotsMax === 1 ? "The only slot is in use." : `All ${slotsMax} slots are in use.`;
}

/**
 * The one fact the session header shows beside the status badge (U2 §8.2), the first that applies.
 * Rate-limited has none (the badge carries its reset time). Times are absolute, never ticking.
 */
export function liveFact(
  agent: AgentSummary,
  ctx: { slotsMax?: number; now: Date },
): LiveFact | null {
  if (agent.status === "terminated" || agent.terminatedAt)
    return { kind: "terminated", text: terminatedText(agent, ctx.now) };
  if (agent.status === "errored" && agent.lastError)
    return {
      kind: "errored",
      text: firstLine(agent.lastError),
      title: agent.lastError,
    };
  const queued = queuedText(agent, ctx.slotsMax);
  if (queued) return { kind: "queued", text: queued };
  if (agent.restartPending) return restartFact(agent.restartChanges);
  const [first, ...rest] = agent.waitingOn.tasks;
  if (first)
    return {
      kind: "waiting",
      text: `${first.description} · since ${formatTime(first.startedAt)}${rest.length ? ` +${rest.length}` : ""}`,
    };
  const crons = agent.waitingOn.crons;
  if (crons > 0)
    return { kind: "crons", text: `Kept awake by ${crons} ${crons === 1 ? "cron" : "crons"}` };
  return null;
}

/** The fact as a truncating line (hidden below 640px; Agent details' Now carries it there). With
 *  no fact it is an empty, hidden region that takes no room. */
export function LiveLine({ fact, sessionOf }: { fact: LiveFact | null; sessionOf?: string }) {
  if (!fact) return <span role="status" className="hidden" />;
  return (
    <>
      <span
        role="status"
        title={fact.title}
        className="hidden min-w-[8rem] grow basis-0 truncate text-[0.8125rem] text-muted-foreground sm:block"
      >
        {fact.text}
      </span>
      {sessionOf !== undefined && (
        // From the Chat: the fact's detail is in the session. Never shown in the Session itself.
        <Link
          to="/agents/$slug/session"
          params={{ slug: sessionOf }}
          className="hidden shrink-0 text-[0.8125rem] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline sm:block"
        >
          Open session
        </Link>
      )}
    </>
  );
}

export type PinOutcome = { tone: "success" | "error"; text: string };

/** Whether a terminated agent's workspace can still be pinned or unpinned. */
export const canPin = (agent: AgentSummary) =>
  !agent.workspaceDeletedAt && (agent.workspacePinned === true || !!agent.workspaceGraceEndsAt);

/**
 * Pin / Unpin workspace (S7 UI design §5.3): one button whose label swaps (focus stays on it). Pin,
 * and Unpin within the grace, act at once; Unpin after the grace confirms. In the header it is its
 * own `shrink-0` action, never inside the truncating live line, and hands its outcome to the
 * header's notice row (`onOutcome`); elsewhere the outcome shows on its own line below it.
 */
export function PinButton({
  agent,
  onAgent,
  onOutcome,
  header = false,
}: {
  agent: AgentSummary;
  /** A fresh summary from the pin/unpin response. */
  onAgent?: ((a: AgentSummary) => void) | undefined;
  /** Where the outcome goes instead of the line below the button. */
  onOutcome?: (o: PinOutcome | undefined) => void;
  /** The header's size: the label hides below md, a tooltip names it. */
  header?: boolean;
}) {
  const pinned = agent.workspacePinned === true;
  const [pending, setPending] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [own, setOwn] = useState<PinOutcome>();
  const setOutcome = onOutcome ?? setOwn;
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

  const label = pinned ? "Unpin workspace" : "Pin workspace";
  const button = (
    <Button
      data-pin-toggle
      variant="ghost"
      size={header ? "default" : "xs"}
      className={header ? "shrink-0" : undefined}
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
      <span className={header ? "max-md:sr-only" : undefined}>{label}</span>
    </Button>
  );
  return (
    <>
      {header ? (
        <Tooltip>
          <TooltipTrigger asChild>{button}</TooltipTrigger>
          <TooltipContent className="md:hidden">{label}</TooltipContent>
        </Tooltip>
      ) : (
        button
      )}
      {!onOutcome && (
        // Its own line: empty, a zero-height row that adds no gap.
        <div className="basis-full">
          <InlineOutcome tone={own?.tone}>{own?.text}</InlineOutcome>
        </div>
      )}
      <UnpinDialog
        slug={agent.slug}
        open={confirm}
        onOpenChange={setConfirm}
        onConfirm={() => request(false)}
      />
    </>
  );
}
