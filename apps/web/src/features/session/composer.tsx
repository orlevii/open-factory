import { type AgentSummary, ApiError, MAX_BODY_BYTES, type QueueItem } from "@open-factory/shared";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { CircleAlert } from "lucide-react";
import {
  memo,
  type Ref,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  type ComposerHandle,
  type ComposerNote,
  Composer as ComposerPrimitive,
  type HintMode,
  NETWORK_ERROR,
  SubmitError,
  type SubmitOptions,
  UNCONFIRMED,
} from "@/components/composer/composer";
import { Button } from "@/components/ui/button";
import { SESSION_AT_LABEL, useMentionSource } from "@/features/mentions/mention-source";
import { readDraft, sessionDraftKey, writeDraft } from "@/lib/drafts";
import { isCoarsePointer } from "@/lib/send-key";
import { postInput, postInterrupt, postMessage } from "./api";
import { commandsQueryOptions, useCommandSource } from "./commands";
import { LINK_CLASS } from "./message-block";
import { registerComposerFocus, repinTimeline } from "./session-commands";
import type { SendingBlock } from "./session-state";

export { NETWORK_ERROR, UNCONFIRMED, UNCONFIRMED_EDITED } from "@/components/composer/composer";
export type { ComposerHandle };
/** U3 §13.2: a send not answered in this long is aborted; it may still land, so a retry reuses its id. */
export const SEND_TIMEOUT_MS = 15_000;
const NO_LANDED: ReadonlySet<string> = new Set();
const WAITS_NOTE: ComposerNote = {
  kind: "hint",
  text: "Messages wait until a new session is started.",
};
/** The session composer's hint while a turn is open: raw input is held until it ends. */
const RAW_TURN_NOTE: ComposerNote = { kind: "hint", text: "Runs after the current turn." };
/** Dropped or pasted files have no place in the raw session. */
const RAW_FILES_NOTE = "Files can be sent from the chat";

/** Moves focus to the composer's textarea (after a Restart or a new session, UI design §3.1). */
export function focusComposer() {
  document.querySelector<HTMLTextAreaElement>("#composer textarea")?.focus();
}

/** After a termination (S7 UI design §5.2, §5.3): Pin workspace when asked for and there is a
 *  workspace to pin, else the read-only line. */
export function focusReadOnly(preferPin: boolean) {
  const pin = preferPin ? document.querySelector<HTMLElement>("[data-pin-toggle]") : null;
  (pin ?? document.querySelector<HTMLElement>("[data-readonly-line]"))?.focus();
}

export const terminatedNotSent = (slug: string) => `@${slug} was terminated, so this wasn't sent.`;

/**
 * A terminated agent's composer (S7 UI design §5.3): one muted, focusable line. An unsent draft can
 * be copied out (then it is cleared); `notice` is a send that raced the termination.
 */
export function TerminatedComposer({ slug, notice }: { slug: string; notice?: string }) {
  const [draft, setDraft] = useState(() => readDraft(sessionDraftKey(slug)));
  const [copyFailed, setCopyFailed] = useState(false);
  const lineRef = useRef<HTMLParagraphElement>(null);
  async function copy() {
    setCopyFailed(false);
    try {
      const write = navigator.clipboard?.writeText(draft);
      if (!write) throw new Error("no clipboard");
      await write;
      writeDraft(sessionDraftKey(slug), "");
      setDraft("");
      lineRef.current?.focus(); // the button is gone
    } catch {
      setCopyFailed(true);
    }
  }
  return (
    <div id="composer" className="shrink-0 border-t border-border px-4 py-3 md:px-6">
      <div className="flex max-w-[52rem] flex-wrap items-center gap-x-3 gap-y-1">
        <p
          ref={lineRef}
          data-readonly-line
          tabIndex={-1}
          className="text-sm text-muted-foreground outline-none" // ui-contract:allow programmatic focus target, not interactive
        >
          This agent was terminated. Its session is read-only.
        </p>
        {draft && (
          <Button type="button" variant="ghost" size="sm" onClick={() => void copy()}>
            Copy unsent message
          </Button>
        )}
      </div>
      {(notice || copyFailed) && (
        <p
          role="alert"
          className="mt-2 flex items-center gap-1.5 text-[0.8125rem] leading-[1.125rem] text-destructive"
        >
          <CircleAlert aria-hidden="true" className="size-3.5 shrink-0" />
          {copyFailed ? "Couldn't copy the message." : notice}
        </p>
      )}
    </div>
  );
}

/** The 64 KB body limit, checked before the box empties (a module constant: a stable prop). */
function checkBody(text: string): string | undefined {
  const bytes = new TextEncoder().encode(text.trim()).length;
  return bytes > MAX_BODY_BYTES
    ? `This message is ${Math.ceil(bytes / 1024)} KB; the limit is 64 KB. Shorten it to send.`
    : undefined;
}

type SessionComposerProps = {
  ref?: Ref<ComposerHandle>;
  slug: string;
  agent: AgentSummary;
  /** The session's `stopEpoch`: Stop resets on every turn edge (U3 §6.1) and when a stop went
   *  unconfirmed. Without one (the inbox pane, which holds no session state) the composer shows no Stop. */
  stopEpoch?: number;
  /** The session is still loading: typing works, sending waits. */
  waiting?: boolean;
  /** Called with the 202 queue item: it replaces the "Sending" block (U3 §13.2). */
  onQueued?: (item: QueueItem) => void;
  /** Enter: the optimistic block goes in the queue area at once (U3 §13.2). */
  onSending?: (block: SendingBlock) => void;
  /** The send failed (its block goes); `unconfirmed` when it aborted and may still land. */
  onSendFailed?: (clientMessageId: string, unconfirmed?: boolean) => void;
  /** The session's echoed `clientMessageId`s: an aborted send that shows up counts as sent. */
  landed?: ReadonlySet<string>;
  /** The server took the message (queued, or queued while its start failed). */
  onSent?: () => void;
  /** A send that raced a termination (`409 agent_terminated`), with the sentence that says so. */
  onTerminated?: (notice: string) => void;
  /** ↑ in an empty box: your last message's text from the loaded timeline (U3 §13.2). Stable. */
  recall?: () => string | undefined;
  /** Where it stands. The session view's composer is raw: its text goes to Claude as typed (I1 §5.4),
   *  with `/` commands and no `@` or files. Elsewhere (the inbox pane's reply) it sends a message, with
   *  `@` and no `/`; a pasted or dropped file gets the "Files can be sent in an agent's session" note. */
  context?: "session" | "inbox";
  /** Bottom-docked: its height lifts the toasts above it. */
  docked?: boolean;
};

/** The props compared by identity: every prop but `agent` (keep this list in step with the type). */
const IDENTITY_KEYS = [
  "ref",
  "slug",
  "stopEpoch",
  "waiting",
  "onQueued",
  "onSending",
  "onSendFailed",
  "landed",
  "onSent",
  "onTerminated",
  "recall",
  "context",
  "docked",
] as const satisfies readonly Exclude<keyof SessionComposerProps, "agent">[];

/** Only the agent fields the composer reads: a status frame that changes nothing here (a new
 *  `turnStartedAt`, a status label) never renders it (U3 M3). When the wrapper starts reading another
 *  `agent` field, add it here, or frames that change it won't reach the composer. */
function sameProps(a: SessionComposerProps, b: SessionComposerProps): boolean {
  for (const k of IDENTITY_KEYS) if (a[k] !== b[k]) return false;
  const x = a.agent;
  const y = b.agent;
  return (
    x.displayName === y.displayName &&
    x.turnOpen === y.turnOpen &&
    x.compacting === y.compacting &&
    x.status === y.status &&
    x.errorKind === y.errorKind
  );
}

/**
 * The session's composer (U3 §13.1): the shared `Composer` with the session's send (the optimistic
 * block, the 15s abort, the `clientMessageId` dedupe), Stop and the turn hint.
 */
export const Composer = memo(function SessionComposer({
  ref,
  slug,
  agent,
  stopEpoch,
  waiting = false,
  onQueued,
  onSent,
  onTerminated,
  onSending,
  onSendFailed,
  landed = NO_LANDED,
  recall,
  context = "inbox",
  docked = false,
}: SessionComposerProps) {
  const inSession = context === "session";
  const inner = useRef<ComposerHandle>(null);
  useImperativeHandle(
    ref,
    () => ({
      focus: () => inner.current?.focus(),
      insertAtStart: (t) => inner.current?.insertAtStart(t),
      prefillIfEmpty: (t) => inner.current?.prefillIfEmpty(t) ?? false,
      putBackIfEmpty: (t) => inner.current?.putBackIfEmpty(t) ?? false,
      clearIfUnchanged: (t) => inner.current?.clearIfUnchanged(t),
    }),
    [],
  );
  useEffect(() => registerComposerFocus(slug, () => inner.current?.focus()), [slug]);
  // Read when a POST settles, long after the render that started it.
  const landedRef = useRef(landed);
  useEffect(() => {
    landedRef.current = landed;
  }, [landed]);

  const onSubmit = useCallback(
    async (text: string, { urgent, clientMessageId }: SubmitOptions) => {
      // Raw input goes as typed, its trailing whitespace trimmed (the server does the same); a message
      // is trimmed at both ends, and may interrupt.
      const body = inSession ? text.trimEnd() : text.trim();
      onSending?.({
        clientMessageId,
        body,
        urgent: inSession ? false : urgent,
        ...(inSession ? { raw: true, at: new Date().toISOString() } : {}),
      });
      repinTimeline(slug); // sending follows the conversation again (U3 §8.1)
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), SEND_TIMEOUT_MS);
      try {
        const item = await (inSession
          ? postInput(slug, { text: body, clientMessageId }, abort.signal)
          : postMessage(slug, body, { urgent, clientMessageId, signal: abort.signal }));
        // The item echoes the id; filled in if a server leaves it out, so the block never stays behind.
        onQueued?.(item.clientMessageId ? item : { ...item, clientMessageId });
        onSent?.();
      } catch (e) {
        if (e instanceof ApiError && e.code === "agent_start_failed") {
          // 503: queued server-side; the queue frame shows "Not delivered yet: <reason>".
          onSendFailed?.(clientMessageId);
          onSent?.();
          return;
        }
        if (abort.signal.aborted) {
          // The send already showed up (its queue item or delivery): it was sent.
          if (landedRef.current.has(clientMessageId)) {
            onSent?.();
            return;
          }
          onSendFailed?.(clientMessageId, true);
          throw new SubmitError(UNCONFIRMED, { unconfirmed: true });
        }
        onSendFailed?.(clientMessageId);
        if (e instanceof ApiError && e.code === "agent_terminated") {
          // The draft stays: the read-only line that replaces the composer offers to copy it.
          onTerminated?.(terminatedNotSent(slug));
          throw new SubmitError(terminatedNotSent(slug));
        }
        throw new SubmitError(e instanceof ApiError ? e.message : NETWORK_ERROR);
      } finally {
        clearTimeout(timer);
      }
    },
    [slug, inSession, onSending, onQueued, onSent, onSendFailed, onTerminated],
  );
  const onStop = useCallback(() => postInterrupt(slug), [slug]);
  // `@` inserts a handle as plain text; the session never calls it a mention (Q23). The raw session
  // has no `@`: what it sends is what Claude reads.
  const at = useMentionSource(SESSION_AT_LABEL);
  const slash = useCommandSource(slug);
  // The list also loads where this composer stands outside a session view (the inbox pane); in a
  // session the view's own prefetch already started it, and this one is deduped.
  const qc = useQueryClient();
  useEffect(() => {
    if (inSession) void qc.prefetchQuery(commandsQueryOptions(slug));
  }, [qc, slug, inSession]);
  const completions = useMemo(() => (inSession ? { slash } : { at }), [at, slash, inSession]);

  // Messages still queue; only a new session delivers them (UI design §3.6).
  const waitsForNewSession =
    agent.status === "errored" && agent.errorKind === "resume_unrecoverable";
  const hintMode: HintMode =
    inSession || !agent.turnOpen ? "none" : isCoarsePointer() ? "coarse" : "working";
  // The raw session's one hint: where the text goes, and the way to the chat (one object per
  // inputs, so the composer's `memo` holds).
  const displayName = agent.displayName;
  const restNote = useMemo<ComposerNote>(
    () => ({
      kind: "hint",
      text: (
        <>
          Goes to Claude as typed ·{" "}
          <Link to="/agents/$slug" params={{ slug }} className={LINK_CLASS}>
            Message {displayName} in Chat
          </Link>
        </>
      ),
    }),
    [slug, displayName],
  );
  const note = waitsForNewSession
    ? WAITS_NOTE
    : inSession
      ? agent.turnOpen
        ? RAW_TURN_NOTE
        : restNote
      : undefined;
  return (
    <ComposerPrimitive
      docked={docked}
      ref={inner}
      id="composer"
      className="shrink-0 border-t border-border px-4 py-3 md:px-6"
      draftKey={sessionDraftKey(slug)}
      label={`Message to ${agent.displayName}`}
      placeholder={
        inSession ? "Raw input to Claude · / for commands" : `Message ${agent.displayName}`
      }
      turnPlaceholder={inSession ? undefined : `Sends after @${slug}'s current step`}
      onSubmit={onSubmit}
      validate={checkBody}
      waiting={waiting}
      landed={landed}
      turnOpen={agent.turnOpen}
      compacting={agent.compacting === true}
      stopEpoch={stopEpoch}
      onStop={stopEpoch === undefined ? undefined : onStop}
      hintMode={hintMode}
      completions={completions}
      note={note}
      noFilesNote={inSession ? RAW_FILES_NOTE : undefined}
      recall={recall}
    />
  );
}, sameProps);
