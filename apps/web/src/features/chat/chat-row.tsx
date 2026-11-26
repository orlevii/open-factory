import { useQuery } from "@tanstack/react-query";
import { CircleAlert, Clock } from "lucide-react";
import { memo, type TransitionEvent, useEffect, useId, useMemo, useState } from "react";
import { InlineOutcome } from "@/components/inline-outcome";
import { Markdown } from "@/components/markdown/markdown";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useHandle } from "@/features/agents/use-agent-index";
import { handleText, principalsQueryOptions } from "@/features/principals/api";
import { usePrincipal } from "@/features/principals/use-principal";
import { formatTime } from "@/features/session/format";
import { InLongPressRow } from "@/features/session/long-press-region";
import { AttachmentList, ClampedMarkdown, UrgentBadge } from "@/features/session/message-block";
import { RowGutter, useRowLongPress } from "@/features/session/row-chrome";
import { useSendPhase } from "@/features/session/send-phase";
import { SpeakerLine } from "@/features/session/speaker-line";
import { ROW_GUTTER } from "@/features/session/timeline-item";
import { stripAttachedLines } from "@/features/session/uploads";
import type { Arrival } from "@/lib/use-arrival";
import { AlsoTo } from "./also-to";
import { ChatRowMenu, type MessageEntry } from "./chat-row-menu";
import { entryKey, isSending } from "./chat-state";

/** A message of yours the Chat shows as cancelled, in its place (I1 §6.4). */
export type CancelNote = {
  error?: string;
  /** The cancel itself failed: the message stays, with the reason under it. */
  rolledBack?: boolean;
};

/** The space above a row (a class name, so a primitive): speakers 24px, status lines 8px. */
export const rowGap = (first: boolean, statusLine = false) =>
  first ? "" : statusLine ? "mt-2" : "mt-6";

/** What a row shows of its recipients: the refs of everyone but you and the agent whose chat this is, and
 *  every recipient's handle for the menu's Recipients item. */
type RecipientsView = { others: readonly string[]; text: string };
const NO_RECIPIENTS: RecipientsView = { others: [], text: "" };

/** Read from the principals cache by `select`, so a row re-renders only when its own view changes. Until
 *  your ref is known, "you" can't be told from another recipient: nothing shows. */
function useRecipientsView(
  recipients: MessageEntry["recipients"],
  agentRef: string,
  selfRef: string | undefined,
): RecipientsView {
  const { data } = useQuery({
    ...principalsQueryOptions,
    select: (cache): RecipientsView => {
      return {
        others:
          selfRef === undefined
            ? []
            : recipients.filter((r) => r.ref !== agentRef && r.ref !== selfRef).map((r) => r.ref),
        text: recipients.map((r) => `@${handleText(cache, r.ref)}`).join(", "),
      };
    },
  });
  return data ?? NO_RECIPIENTS;
}

export type ChatRowProps = {
  entry: MessageEntry;
  agentRef: string;
  /** The chat's agent: the pending line names it. */
  agentName: string;
  /** Your handle, without `@`: the sender's stand-in until the principals cache knows you. */
  self: string | undefined;
  /** Your ref: the recipients that are you. */
  selfRef: string | undefined;
  /** Arrived by a live frame: fades in once. A boolean, never the live Set. */
  live: boolean;
  /** Continues the message above: no speaker line. */
  grouped: boolean;
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
 * One message of the thread (I1 §6.4, I9 §2.16): every sender the same, a speaker line then the body
 * unboxed (yours clamped, an agent's never), the time or the message's status in one slot. A message that
 * continues the one above (`grouped`) has no speaker line: its time shows in the leading edge on hover.
 * Memoised on primitives and stable handlers, so a refetch that changes one entry renders one row.
 */
export const ChatRow = memo(function ChatRow(p: ChatRowProps) {
  const { entry, agentRef, self, selfRef } = p;
  const key = entryKey(entry);
  const mine = entry.from.kind === "human";
  // The sender's handle is the principals cache's, so a rename shows here without a refetch of the thread.
  // While the cache doesn't know the ref yet, the thread's own two parties stand in.
  const sender = usePrincipal(entry.from.ref);
  const agentHandle = useHandle(agentRef);
  const fromHandle =
    sender.status === "found" ? sender.principal.handle : mine ? (self ?? "") : agentHandle;
  // Your send before the server's row: the delivered row's shape, its body muted; "Sending…" only when slow.
  const sending = isSending(entry);
  const { slow } = useSendPhase(sending);
  const { menu, press } = useRowLongPress();
  const statusId = useId();
  const rejectedId = useId();
  const { others, text: recipientsText } = useRecipientsView(entry.recipients, agentRef, selfRef);
  const chips = entry.attachments?.length ? entry.attachments : undefined;
  const shown = useMemo(() => stripAttachedLines(entry.body, chips), [entry.body, chips]);
  const queued = entry.state === "pending" && !sending;
  const status: Status | undefined = sending
    ? { icon: "spinner", text: "Sending…", visible: slow }
    : queued
      ? { icon: "clock", text: `Waiting for ${p.agentName}'s current step`, visible: true }
      : undefined;
  const rejected = entry.state === "rejected";
  const describedBy = rejected ? rejectedId : status ? statusId : undefined;
  const cancel = queued ? (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      data-cancel-for={entry.id}
      onClick={() => p.onCancel(entry.id)}
    >
      Cancel
    </Button>
  ) : undefined;
  const rowProps = {
    "data-row": key,
    tabIndex: p.tabbable ? 0 : -1,
    onFocus: () => p.onRowFocus(key),
    "aria-describedby": describedBy,
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
      className={`group relative min-w-0 rounded-md pointer-fine:hover:bg-accent ${ROW_GUTTER} ${p.gap}`}
    >
      <InLongPressRow value={true}>
        <RowGutter />
        <div {...rowProps}>
          {!p.grouped && (
            <SpeakerLine
              from={fromHandle}
              fromKind={entry.from.kind}
              self={!mine}
              status={
                <TimeSlot
                  at={entry.createdAt}
                  status={status?.visible ? status : undefined}
                  statusId={statusId}
                />
              }
              action={cancel}
            >
              {alsoTo(others)}
              {entry.urgent && <UrgentBadge />}
            </SpeakerLine>
          )}
          <div className="relative pl-8">
            {p.grouped && (
              <time
                dateTime={entry.createdAt}
                title={new Date(entry.createdAt).toLocaleString()}
                className="absolute top-0 left-0 w-8 pr-1.5 text-right text-[0.6875rem] leading-6 text-muted-foreground tabular-nums opacity-0 transition-opacity duration-100 ease-(--ease-out) group-focus-within:opacity-100 group-hover:opacity-100"
              >
                {formatTime(entry.createdAt)}
              </time>
            )}
            {p.grouped && status?.visible && (
              <div className="mb-1 flex items-center gap-2 text-[0.8125rem] leading-[1.125rem] text-muted-foreground">
                <span id={statusId} className="flex items-center gap-1">
                  <StatusMark icon={status.icon} />
                  {status.text}
                </span>
                {cancel}
              </div>
            )}
            {status && !status.visible && (
              <span id={statusId} className="sr-only">
                {status.text}
              </span>
            )}
            {rejected && (
              <p
                id={rejectedId}
                className="mb-1 flex items-start gap-1.5 text-[0.8125rem] leading-[1.125rem] text-destructive"
              >
                <CircleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
                <span className="min-w-0 [overflow-wrap:anywhere]">
                  {entry.rejectReason ? `Not delivered: ${entry.rejectReason}` : "Not delivered"}
                </span>
              </p>
            )}
            <div
              dir="auto"
              className={
                sending ? "text-muted-foreground [--foreground:var(--muted-foreground)]" : undefined
              }
            >
              {mine ? (
                <ClampedMarkdown source={shown} variant="default" />
              ) : (
                <Markdown source={shown} />
              )}
            </div>
            {chips ? <AttachmentList agentRef={agentRef} attachments={chips} /> : null}
          </div>
        </div>
      </InLongPressRow>
      {p.note?.rolledBack && (
        <div className="pt-1">
          <InlineOutcome tone="error">Couldn't cancel: {p.note.error}</InlineOutcome>
        </div>
      )}
      <ChatRowMenu
        entry={entry}
        agentRef={agentRef}
        others={others}
        recipientsText={recipientsText}
        sender={fromHandle}
        tabbable={p.tabbable}
        menuRef={menu}
      />
    </div>
  );
});

const alsoTo = (others: readonly string[]) =>
  others.length > 0 ? <AlsoTo others={others} /> : undefined;

/** A message's state before it is just a delivered message with a time. */
type Status = { icon: "spinner" | "clock"; text: string; visible: boolean };

function StatusMark({ icon }: { icon: Status["icon"] }) {
  return icon === "spinner" ? (
    <Spinner size="text" />
  ) : (
    <Clock aria-hidden="true" className="size-3.5" />
  );
}

/**
 * The speaker line's time, and a status (sending, waiting for the agent) in the same slot: the two
 * are layers of one grid cell swapped by opacity (150ms in, 100ms out), so the line never changes size
 * between them. The last status stays mounted while it fades out, then leaves so it holds no width.
 */
function TimeSlot({
  at,
  status,
  statusId,
}: {
  at: string;
  status: Status | undefined;
  statusId: string;
}) {
  const [kept, setKept] = useState(status);
  if (status && (kept?.text !== status.text || kept.icon !== status.icon)) setKept(status);
  useEffect(() => {
    if (status || !kept) return;
    const t = setTimeout(() => setKept(undefined), 100);
    return () => clearTimeout(t);
  }, [status, kept]);
  return (
    <span className="slot-swap">
      <time
        dateTime={at}
        title={new Date(at).toLocaleString()}
        aria-hidden={status ? true : undefined}
        data-shown={status ? undefined : ""}
        className="text-muted-foreground tabular-nums"
      >
        {formatTime(at)}
      </time>
      {kept && (
        <span
          id={status ? statusId : undefined}
          aria-hidden={status ? undefined : true}
          data-shown={status ? "" : undefined}
          className="flex items-center gap-1 text-muted-foreground"
        >
          <StatusMark icon={kept.icon} />
          {kept.text}
        </span>
      )}
    </span>
  );
}

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
