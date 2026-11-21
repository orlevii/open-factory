import type { AgentSummary, QueueItem } from "@open-factory/shared";
import { Clock } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { InlineOutcome } from "@/components/inline-outcome";
import { Button } from "@/components/ui/button";
import { TaskBadge } from "@/features/tasks/task-badge";
import { formatResetTime } from "./format";
import { MessageBlock } from "./message-block";
import { QuietLine } from "./quiet-line";
import { type CancelledEntry, NO_CANCELLED, queueView, type SendingBlock } from "./session-state";
import { resetPhrase } from "./status-badge";

/** Why queued messages aren't out yet (S5 UI design §3.6), or the error that holds them. */
function heldReason(agent: AgentSummary): string | undefined {
  if (agent.status === "rate_limited") return `rate-limited${resetPhrase(agent)?.joined ?? ""}`;
  if (agent.status === "queued") return "waiting for a free slot";
  return agent.lastError;
}

/** A held message's own reason wins over the agent's status (U3 §6.3). */
const messageReason = (q: QueueItem, fallback: string | undefined) =>
  q.waitReason === "stopping" ? "stopping the turn" : fallback;

/** Cancel is for a plain message you sent: never another sender's, a task comment or a scheduled
 *  row (U3 §6.4, Q26, D2). */
const cancellable = (q: QueueItem, self: string | undefined) =>
  q.kind === "message" &&
  self !== undefined &&
  q.from === `@${self}` &&
  q.taskKey === undefined &&
  q.scheduleKey === undefined;

const NO_SENDING: readonly SendingBlock[] = [];
/** U3 §13.2: "Sending…" only when the POST is slow (no flash under this). */
const SLOW_SEND_MS = 400;
/** A queue item younger than this (since its send) doesn't say "Not delivered yet". */
const YOUNG_ITEM_MS = 300;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** One quiet line per held group (S6 UI design §2.6): fixed text, nothing ticks, outside any live
 *  region. `rate_limited` reuses S5's reset phrase; a window shows its fixed `dueAt`. */
function HeldLine({ item, agent }: { item: QueueItem; agent: AgentSummary }) {
  // A group's `from` is its first row's sender, which can be "@factory" for a fact about the report:
  // the report named by `about` is who the updates are from.
  const who = (item.about ?? item.from).replace(/^@/, "");
  const count = plural(item.count ?? 1, "update", "updates");
  const tail = (() => {
    switch (item.waitReason) {
      case "turn":
        return " waiting for this turn to end";
      case "window": {
        const due = item.dueAt ? new Date(item.dueAt) : undefined;
        return due && !Number.isNaN(due.getTime())
          ? `, delivered by ${formatResetTime(due, new Date())}`
          : "";
      }
      case "starting":
        return " waiting for this agent to start";
      case "errored":
        return " held until a human restarts this agent";
      case "rate_limited": {
        const phrase = resetPhrase(agent)?.bare;
        return phrase ? ` held ${phrase}` : " held";
      }
      default:
        return "";
    }
  })();
  // Window without a due time, or a reason this client doesn't know: still say they are waiting.
  const text = tail.startsWith(" held") || tail.startsWith(" waiting") ? tail : ` waiting${tail}`;
  return (
    <QuietLine icon={<Clock aria-hidden="true" />}>
      {count} from <span className="font-mono">@{who}</span>
      {text}
    </QuietLine>
  );
}

/** Pending items, drawn only from `queue` frames (never inferred), at full opacity, with the lines of
 *  the ones you cancelled in their place (U3 §6.4). */
export function QueueItems({
  items,
  agent,
  cancelled = NO_CANCELLED,
  self,
  onCancel,
  onUndo,
  sending = NO_SENDING,
}: {
  items: QueueItem[];
  /** Optimistic sends in flight (U3 §13.2), after the queue. */
  sending?: readonly SendingBlock[];
  agent: AgentSummary;
  cancelled?: ReadonlyMap<string, CancelledEntry>;
  /** The viewer's handle: their own held messages offer Cancel. */
  self?: string;
  onCancel?: (item: QueueItem) => void;
  onUndo?: (id: string, entry: CancelledEntry) => void;
}) {
  const reason = heldReason(agent);
  const view = queueView(items, cancelled);
  let peerChanges = 0;
  let firstPeer: QueueItem | undefined;
  for (const v of view) {
    if (v.kind !== "item" || v.item.kind !== "held" || v.item.waitReason !== "ride_along") continue;
    peerChanges += v.item.count ?? 1;
    firstPeer ??= v.item;
  }
  // One array: a send and the queue item that replaces it share a key, so the node stays (§8.3).
  const out: ReactNode[] = view.map((v) => {
    if (v.kind === "cancelled") return <CancelledLine key={v.id} {...v} onUndo={onUndo} />;
    const q = v.item;
    if (q.kind === "held")
      return q.waitReason === "ride_along" ? (
        q === firstPeer && (
          <QuietLine key={q.id} icon={<Clock aria-hidden="true" />}>
            {plural(peerChanges, "peer change", "peer changes")} waiting
          </QuietLine>
        )
      ) : (
        <HeldLine key={q.id} item={q} agent={agent} />
      );
    if (q.kind === "message" || q.kind === "notice")
      return (
        <OutgoingMessage key={q.clientMessageId ?? q.id}>
          {(young) => (
            <>
              <MessageBlock
                from={q.from}
                system={q.kind === "notice" || (q.taskKey !== undefined && q.from === "@factory")}
                body={q.body ?? ""}
                urgent={q.urgent}
                {...(young ? {} : { queued: { reason: messageReason(q, reason) } })}
                {...(q.scheduleKey
                  ? {
                      scheduled: {
                        key: q.scheduleKey,
                        late: q.late ?? false,
                        firings: q.firings,
                      },
                    }
                  : {})}
                badge={
                  q.taskKey ? (
                    <TaskBadge
                      taskKey={q.taskKey}
                      title={q.taskTitle}
                      link={{ comment: q.commentId }}
                    />
                  ) : undefined
                }
                action={
                  onCancel && cancellable(q, self) ? (
                    <Button type="button" variant="ghost" size="xs" onClick={() => onCancel(q)}>
                      Cancel
                    </Button>
                  ) : undefined
                }
              />
              {v.error && (
                <div className="pt-1">
                  <InlineOutcome tone="error">Couldn't cancel: {v.error}</InlineOutcome>
                </div>
              )}
            </>
          )}
        </OutgoingMessage>
      );
    return (
      <QuietLine key={q.id} icon={<Clock aria-hidden="true" />}>
        Compact queued until the turn ends{q.focus ? `: ${q.focus}` : ""}
      </QuietLine>
    );
  });
  for (const b of sending)
    out.push(
      <OutgoingMessage key={b.clientMessageId} sending>
        {(_young, slow) => (
          // The queued item's shape (block, then the slot for its cancel error): nothing remounts.
          <>
            <MessageBlock
              from={`@${self ?? "you"}`}
              body={b.body}
              urgent={b.urgent}
              sending={
                slow ? { label: b.urgent ? "Sending · will interrupt the turn" : "Sending…" } : {}
              }
            />
            {null}
          </>
        )}
      </OutgoingMessage>,
    );
  return <>{out}</>;
}

/**
 * A queued message, or a send in flight (U3 §13.2). The same component under the same key for both,
 * so when the 202 or the queue frame replaces a send its node stays, with no entrance. A send becomes
 * `slow` after 400ms; the item it becomes stays `young` (no "Not delivered yet") until 300ms after it
 * was sent. An item that was never a send on this screen is never young.
 */
function OutgoingMessage({
  sending = false,
  children,
}: {
  sending?: boolean;
  children: (young: boolean, slow: boolean) => ReactNode;
}) {
  const [sentAt] = useState(() => (sending ? Date.now() : undefined));
  const [slow, setSlow] = useState(false);
  const [grown, setGrown] = useState(sentAt === undefined);
  useEffect(() => {
    if (!sending) return;
    const t = setTimeout(() => setSlow(true), SLOW_SEND_MS);
    return () => clearTimeout(t);
  }, [sending]);
  useEffect(() => {
    if (sending || grown || sentAt === undefined) return;
    const t = setTimeout(() => setGrown(true), Math.max(0, sentAt + YOUNG_ITEM_MS - Date.now()));
    return () => clearTimeout(t);
  }, [sending, grown, sentAt]);
  return <div className="pt-3">{children(!grown, sending && slow)}</div>;
}

/** "Message cancelled. Undo" in the message's place; after a failed Undo it says why, without Undo
 *  (the line stays under the pointer). Focus moves to Undo: the Cancel that had it is gone; when an
 *  error replaces Undo, to the line. Once restored there is no second Undo. A cancel that failed after
 *  its item left the queue (delivered first) is this line with the reason. */
function CancelledLine({
  id,
  entry,
  onUndo,
}: {
  id: string;
  entry: CancelledEntry;
  onUndo?: (id: string, entry: CancelledEntry) => void;
}) {
  const failed = entry.error !== undefined;
  return (
    <div className="pt-3">
      <InlineOutcome
        tone={failed ? "error" : "success"}
        undo={failed || entry.restored || !onUndo ? undefined : () => onUndo(id, entry)}
        focusOnMount
        // Undo unmounts on an error or a restore: focus goes to the line instead of the page.
        focusKey={failed ? `error:${entry.error}` : entry.restored ? "restored" : undefined}
      >
        {entry.rolledBack
          ? `Couldn't cancel: ${entry.error}`
          : failed
            ? `Message cancelled. Couldn't undo: ${entry.error}`
            : entry.inBox
              ? "Message cancelled · back in the box."
              : "Message cancelled."}
      </InlineOutcome>
    </div>
  );
}
