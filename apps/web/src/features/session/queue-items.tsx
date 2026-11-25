import type { AgentSummary, QueueItem } from "@open-factory/shared";
import { Clock } from "lucide-react";
import { memo, type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { InlineOutcome } from "@/components/inline-outcome";
import { Button } from "@/components/ui/button";
import { TaskBadge } from "@/features/tasks/task-badge";
import { focusComposer } from "./composer";
import { MessageBlock } from "./message-block";
import { QuietLine } from "./quiet-line";
import { useSendPhase } from "./send-phase";
import { type CancelledEntry, NO_CANCELLED, queueView, type SendingBlock } from "./session-state";
import { resetPhrase } from "./status-badge";
import { ROW_GUTTER } from "./timeline-item";
import { attachmentsSentWith } from "./uploads";

/** Why queued messages aren't out yet (S5 UI design §3.6), or the error that holds them. */
function heldReason(agent: AgentSummary): string | undefined {
  if (agent.status === "rate_limited") return `rate-limited${resetPhrase(agent)?.joined ?? ""}`;
  if (agent.status === "queued") return "waiting for a free slot";
  return agent.lastError;
}

/** A held message's own reason wins over the agent's status (U3 §6.3). */
const messageReason = (q: QueueItem, fallback: string | undefined) =>
  q.waitReason === "stopping" ? "stopping the turn" : fallback;

/** Cancel is for a plain message or a command you sent: never another sender's, a task comment or a
 *  scheduled row (U3 §6.4, §13.3, Q26, Q39, D2). */
const cancellable = (q: QueueItem, self: string | undefined) =>
  (q.kind === "message" || q.kind === "raw") &&
  self !== undefined &&
  q.from === `@${self}` &&
  q.taskKey === undefined &&
  q.scheduleKey === undefined;

const NO_SENDING: readonly SendingBlock[] = [];

/** More queued messages than this fold: the first `FOLD_SHOWN` show, then "+N more queued" (U3 §7.6). */
const FOLD_OVER = 3;
const FOLD_SHOWN = 2;

/** Pending items, drawn only from `queue` frames (never inferred), at full opacity, with the lines of
 *  the ones you cancelled in their place (U3 §6.4). */
export const QueueItems = memo(function QueueItems({
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
  // Once unfolded, a long queue stays unfolded; `revealFrom` is the first block the disclosure
  // revealed, which takes the focus from it.
  const [unfolded, setUnfolded] = useState(false);
  const [revealFrom, setRevealFrom] = useState<string>();
  let blocks = 0;
  for (const v of view)
    if (v.kind === "item" && (v.item.kind === "message" || v.item.kind === "notice")) blocks++;
  const folded = !unfolded && blocks > FOLD_OVER;
  let block = 0;
  // One array: a send and the queue item that replaces it share a key, so the node stays (§8.3).
  const out: ReactNode[] = view.map((v) => {
    if (v.kind === "cancelled") return <CancelledLine key={v.id} {...v} onUndo={onUndo} />;
    const q = v.item;
    const index = q.kind === "message" || q.kind === "notice" ? block++ : -1;
    if (folded && index >= FOLD_SHOWN)
      return index === FOLD_SHOWN ? (
        <div key="fold" className={`pt-3 ${ROW_GUTTER}`}>
          <button
            type="button"
            data-expands
            onClick={() => {
              setRevealFrom(q.clientMessageId ?? q.id);
              setUnfolded(true);
            }}
            className="text-[0.8125rem] leading-[1.125rem] text-muted-foreground underline-offset-4 hover:underline"
          >
            +{blocks - FOLD_SHOWN} more queued
          </button>
        </div>
      ) : null;
    if (q.kind === "message" || q.kind === "notice")
      return (
        <OutgoingMessage
          key={q.clientMessageId ?? q.id}
          focusOnMount={(q.clientMessageId ?? q.id) === revealFrom}
        >
          {(young) => (
            <>
              <MessageBlock
                from={q.from}
                fromKind={q.fromKind}
                system={q.kind === "notice" || (q.taskKey !== undefined && q.from === "@factory")}
                body={q.body ?? ""}
                urgent={q.urgent}
                brief
                // This tab's send with files: its chips, and its `[attached: …]` lines hidden.
                attachments={attachmentsSentWith(q.clientMessageId)}
                slug={agent.slug}
                // The reason once, on the first held block; the rest only say they wait (U3 §7.6).
                {...(young
                  ? {}
                  : { queued: { reason: index === 0 ? messageReason(q, reason) : undefined } })}
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
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      data-cancel-for={q.id}
                      onClick={() => onCancel(q)}
                    >
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
    // A raw item is a block at the timeline's tail (`rawTailRows`), not a line here.
    if (q.kind === "raw") return null;
    return (
      <QuietLine key={q.id} icon={<Clock aria-hidden="true" />}>
        Compact queued until the turn ends{q.focus ? `: ${q.focus}` : ""}
      </QuietLine>
    );
  });
  for (const b of sending) {
    if (b.raw) continue;
    out.push(
      <OutgoingMessage key={b.clientMessageId} sending>
        {(_young, slow) => (
          // The queued item's shape (block, then the slot for its cancel error): nothing remounts.
          <>
            <MessageBlock
              from={`@${self ?? "you"}`}
              fromKind="human"
              body={b.body}
              urgent={b.urgent}
              brief
              attachments={b.attachments}
              slug={agent.slug}
              sending={
                slow ? { label: b.urgent ? "Sending · will interrupt the turn" : "Sending…" } : {}
              }
            />
            {null}
          </>
        )}
      </OutgoingMessage>,
    );
  }
  return <>{out}</>;
});

/**
 * A queued message, or a send in flight (U3 §13.2). The same component under the same key for both,
 * so when the 202 or the queue frame replaces a send its node stays, with no entrance. A send becomes
 * `slow` after 400ms; the item it becomes stays `young` (no "Not delivered yet") until 300ms after it
 * was sent. An item that was never a send on this screen is never young.
 */
function OutgoingMessage({
  sending = false,
  focusOnMount = false,
  children,
}: {
  sending?: boolean;
  /** Revealed by "+N more queued" from under the focus: takes it (its Cancel, else itself). */
  focusOnMount?: boolean;
  children: (young: boolean, slow: boolean) => ReactNode;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const [focusFirst] = useState(focusOnMount);
  useLayoutEffect(() => {
    if (!focusFirst) return;
    const el = wrap.current;
    (el?.querySelector<HTMLElement>("[data-cancel-for]") ?? el)?.focus({ preventScroll: true });
  }, [focusFirst]);
  const { young, slow } = useSendPhase(sending);
  return (
    // A card spans the column like the delivered card that replaces it (U3 §7.5): no right gutter.
    <div ref={wrap} {...(focusFirst ? { tabIndex: -1 } : {})} className="pt-3">
      {children(young, slow)}
    </div>
  );
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
  // A command is cancelled for good: it lived in memory, so there is nothing to restore (Q39).
  const isCommand = entry.item.kind === "raw";
  // The line going under the focus (Undo brought the message back, or a rollback did): focus lands on
  // that message's Cancel, else the composer, never <body>. The cleanup runs before the node is removed.
  const wrap = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = wrap.current;
    return () => {
      if (!el?.contains(document.activeElement)) return;
      requestAnimationFrame(() => {
        const cancel = document.querySelector<HTMLElement>(`[data-cancel-for="${CSS.escape(id)}"]`);
        if (cancel) cancel.focus();
        else focusComposer();
      });
    };
  }, [id]);
  return (
    <div ref={wrap} className={`pt-3 ${ROW_GUTTER}`}>
      <InlineOutcome
        tone={failed ? "error" : "success"}
        undo={
          failed || entry.restored || isCommand || !onUndo ? undefined : () => onUndo(id, entry)
        }
        focusOnMount
        // Undo unmounts on an error or a restore: focus goes to the line instead of the page.
        focusKey={failed ? `error:${entry.error}` : entry.restored ? "restored" : undefined}
      >
        {entry.rolledBack
          ? `Couldn't cancel: ${entry.error}`
          : isCommand
            ? "Command cancelled."
            : failed
              ? `Message cancelled. Couldn't undo: ${entry.error}`
              : entry.inBox
                ? "Message cancelled · back in the box."
                : "Message cancelled."}
      </InlineOutcome>
    </div>
  );
}
