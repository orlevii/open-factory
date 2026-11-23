import type { ChatEntry } from "@open-factory/shared";
import { Link } from "@tanstack/react-router";
import { Check, CircleAlert, Square } from "lucide-react";
import { memo, type TransitionEvent, useMemo } from "react";
import { InlineOutcome } from "@/components/inline-outcome";
import { Markdown } from "@/components/markdown/markdown";
import { MiddleTruncate } from "@/components/middle-truncate";
import { Button } from "@/components/ui/button";
import { Elapsed } from "@/features/session/activity-line";
import { formatTime } from "@/features/session/format";
import { InLongPressRow } from "@/features/session/long-press-region";
import { MessageBlock } from "@/features/session/message-block";
import { RowGutter, useRowLongPress } from "@/features/session/row-chrome";
import { SpeakerLine } from "@/features/session/speaker-line";
import { ROW_GUTTER } from "@/features/session/timeline-item";
import { AlsoTo } from "./also-to";
import { ChatRowMenu, type MessageEntry } from "./chat-row-menu";
import { entryKey } from "./chat-state";

/** The deep-link tint's phase: shown, then fading until its `transitionend` (the session's rule). */
export type Arrival = "on" | "fading";
/** A message of yours the Chat shows as cancelled, in its place (I1 §6.4). */
export type CancelNote = {
  error?: string;
  /** The cancel itself failed: the message stays, with the reason under it. */
  rolledBack?: boolean;
};

/** The space above a row (a class name, so a primitive): speakers 24px, status lines 8px. */
export const rowGap = (first: boolean, statusLine = false) =>
  first ? "" : statusLine ? "mt-2" : "mt-6";

/** Everyone a message went to but you and the agent whose chat this is, as `@handle`s. */
function othersOf(recipients: readonly string[], slug: string, self: string | undefined) {
  // Until your handle is known "you" can't be told from another recipient: show nothing rather than "@you".
  if (self === undefined) return [];
  const skip = new Set([`@${slug}`, `@${self}`].map((h) => h.toLowerCase()));
  return recipients.filter((r) => !skip.has(r.toLowerCase()));
}

export type ChatRowProps = {
  entry: MessageEntry;
  slug: string;
  /** The chat's agent: the pending line names it. */
  agentName: string;
  /** Your handle, without `@`. */
  self: string | undefined;
  /** Arrived by a live frame: fades in once. A boolean, never the live Set. */
  live: boolean;
  gap: string;
  /** The row is the log's one tab stop. */
  tabbable: boolean;
  /** Set on the deep-link target only. */
  arrival: Arrival | undefined;
  note: CancelNote | undefined;
  /** The view's stable handlers: they take the entry's id. */
  onCancel(id: string): void;
  onUndo(id: string): void;
  onRowFocus(key: string): void;
  onArrivedEnd(): void;
};

/**
 * One message of the thread (I1 §6.4): yours a card (speaker line "You", the clamp), the agent's an
 * unboxed `.prose-of` reply under its speaker line, never clamped. Memoised on primitives and stable
 * handlers, so a refetch that changes one entry renders one row.
 */
export const ChatRow = memo(function ChatRow(p: ChatRowProps) {
  const { entry, slug, self } = p;
  const key = entryKey(entry);
  const mine = entry.fromKind === "human";
  const { menu, press } = useRowLongPress();
  const others = useMemo(
    () => othersOf(entry.recipients, slug, self),
    [entry.recipients, slug, self],
  );
  const alsoTo = others.length > 0 ? <AlsoTo others={others} /> : undefined;
  const rowProps = {
    "data-row": key,
    tabIndex: p.tabbable ? 0 : -1,
    onFocus: () => p.onRowFocus(key),
    ...(p.arrival
      ? {
          "data-arrived": p.arrival === "fading" ? "fading" : "",
          onTransitionEnd: (e: TransitionEvent) => {
            if (e.target !== e.currentTarget || p.arrival !== "fading") return;
            if (e.propertyName && e.propertyName !== "opacity") return;
            p.onArrivedEnd();
          },
        }
      : {}),
  };
  if (p.note && !p.note.rolledBack)
    return (
      <div className={`${ROW_GUTTER} ${p.gap}`} data-row-wrap>
        <CancelledLine id={entry.id} note={p.note} onUndo={p.onUndo} />
      </div>
    );
  return (
    <div
      {...press}
      data-row-wrap
      {...(p.live ? { "data-live": "" } : {})}
      className={`group relative min-w-0 rounded-md ${mine ? "" : ROW_GUTTER} ${p.gap}`}
    >
      <InLongPressRow value={true}>
        {mine ? (
          <div {...rowProps}>
            <MessageBlock
              from={entry.from}
              fromKind="human"
              body={entry.body}
              urgent={entry.urgent}
              at={entry.createdAt}
              attachments={entry.attachments}
              slug={slug}
              badge={alsoTo}
              {...(entry.state === "pending"
                ? { queued: { text: `Waiting for ${p.agentName}'s current step` } }
                : {})}
              {...(entry.state === "rejected"
                ? {
                    failed: entry.rejectReason
                      ? `This message wasn't delivered: ${entry.rejectReason.replace(/\.$/, "")}.`
                      : "This message wasn't delivered.",
                  }
                : {})}
              action={
                entry.state === "pending" ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    data-cancel-for={entry.id}
                    onClick={() => p.onCancel(entry.id)}
                  >
                    Cancel
                  </Button>
                ) : undefined
              }
            />
          </div>
        ) : (
          <>
            <RowGutter />
            {/* An agent's reply carries no attachments or urgency in a human's chat today (the send tool has neither
                for a human recipient), so only the text renders. */}
            <div {...rowProps}>
              <SpeakerLine from={entry.from} fromKind={entry.fromKind} self at={entry.createdAt}>
                {alsoTo}
              </SpeakerLine>
              <div dir="auto">
                <Markdown source={entry.body} />
              </div>
            </div>
          </>
        )}
      </InLongPressRow>
      {p.note?.rolledBack && (
        <div className="pt-1">
          <InlineOutcome tone="error">Couldn't cancel: {p.note.error}</InlineOutcome>
        </div>
      )}
      <ChatRowMenu
        entry={entry}
        slug={slug}
        others={others}
        tabbable={p.tabbable}
        card={mine}
        menuRef={menu}
      />
    </div>
  );
});

function CancelledLine({
  id,
  note,
  onUndo,
}: {
  id: string;
  note: CancelNote;
  onUndo(id: string): void;
}) {
  const failed = note.error !== undefined;
  return (
    <InlineOutcome
      tone={failed ? "error" : "success"}
      undo={failed ? undefined : () => onUndo(id)}
      focusOnMount
      focusKey={failed ? `error:${note.error}` : undefined}
    >
      {failed ? `Message cancelled. Couldn't undo: ${note.error}` : "Message cancelled."}
    </InlineOutcome>
  );
}

type Outcome = Extract<ChatEntry, { kind: "turn_outcome" }>["outcome"];
const OUTCOME_TEXT: Record<Outcome, { suffix: string; Icon: typeof Check }> = {
  no_reply: { suffix: " finished without replying", Icon: Check },
  stopped: { suffix: " was stopped before replying", Icon: Square },
  error: { suffix: " hit an error before replying", Icon: CircleAlert },
};

/** "Ada hit an error before replying": the line's sentence, also what the live region announces. */
export const outcomeSentence = (name: string, outcome: Outcome) =>
  `${name}${OUTCOME_TEXT[outcome].suffix}`;

/**
 * The thread's status line (I1 §6.4): "[tooth] 42s · Ada is working · Open session" while a turn that
 * read your message runs, and in the same box, "[icon] Ada finished without replying · Open session"
 * once it ended. One node under one key (`turn:<key>`), so the outcome replacing the working line
 * keeps its element. The elapsed time is its own component: a tick renders nothing else.
 */
export const StatusLine = memo(function StatusLine({
  slug,
  name,
  at,
  outcome,
  eventSeq,
  live,
  gap,
}: {
  slug: string;
  name: string;
  /** `working.since`, or the turn's `endedAt`. */
  at: string;
  /** Absent while the turn runs. */
  outcome?: Outcome | undefined;
  eventSeq?: number | null | undefined;
  /** Appeared by a live frame: fades in once (the working line, like the activity line). */
  live: boolean;
  gap: string;
}) {
  const text = outcome ? OUTCOME_TEXT[outcome] : undefined;
  return (
    <p
      data-status-line={outcome ?? "working"}
      {...(live ? { "data-live": "" } : {})}
      className={`flex h-6 min-w-0 items-center ${ROW_GUTTER} ${gap} text-[0.8125rem] leading-[1.125rem] text-muted-foreground`}
    >
      <span
        aria-hidden="true"
        className="mr-2 inline-flex size-3 shrink-0 items-center justify-center"
      >
        {text ? <text.Icon className="size-3" /> : <span className="of-tooth" />}
      </span>
      {!outcome && (
        <>
          <Elapsed since={at} />
          <span className="shrink-0 whitespace-pre"> · </span>
        </>
      )}
      <span className="flex min-w-0 items-baseline">
        <span className="flex min-w-0">
          <MiddleTruncate text={name} />
        </span>
        <span className="shrink-0 whitespace-pre">{text?.suffix ?? " is working"}</span>
      </span>
      <span className="shrink-0 whitespace-pre"> · </span>
      <Link
        to="/agents/$slug/session"
        params={{ slug }}
        search={eventSeq != null ? { event: eventSeq } : {}}
        aria-label={`Open session at ${formatTime(at)}`}
        className="shrink-0 underline underline-offset-4 decoration-muted-foreground hover:text-foreground hover:decoration-ring"
      >
        Open session
      </Link>
    </p>
  );
});
