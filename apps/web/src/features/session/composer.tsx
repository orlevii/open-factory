import { type AgentSummary, ApiError, MAX_BODY_BYTES, type QueueItem } from "@open-factory/shared";
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
  Composer as ComposerPrimitive,
  type HintMode,
  NETWORK_ERROR,
  SubmitError,
  type SubmitOptions,
  UNCONFIRMED,
} from "@/components/composer/composer";
import { SESSION_AT_LABEL, useMentionSource } from "@/components/composer/mentions";
import { Button } from "@/components/ui/button";
import { agentDraftKey, readDraft, writeDraft } from "@/lib/drafts";
import { isCoarsePointer } from "@/lib/send-key";
import { postInterrupt, postMessage } from "./api";
import { registerComposerFocus, repinTimeline } from "./session-commands";
import type { SendingBlock } from "./session-state";

export { NETWORK_ERROR, UNCONFIRMED, UNCONFIRMED_EDITED } from "@/components/composer/composer";
export type { ComposerHandle };
/** U3 §13.2: a send not answered in this long is aborted; it may still land, so a retry reuses its id. */
export const SEND_TIMEOUT_MS = 15_000;
const NO_LANDED: ReadonlySet<string> = new Set();

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
  const [draft, setDraft] = useState(() => readDraft(agentDraftKey(slug)));
  const [copyFailed, setCopyFailed] = useState(false);
  const lineRef = useRef<HTMLParagraphElement>(null);
  async function copy() {
    setCopyFailed(false);
    try {
      const write = navigator.clipboard?.writeText(draft);
      if (!write) throw new Error("no clipboard");
      await write;
      writeDraft(agentDraftKey(slug), "");
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
}: SessionComposerProps) {
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
      const body = text.trim();
      onSending?.({ clientMessageId, body, urgent });
      repinTimeline(slug); // sending follows the conversation again (U3 §8.1)
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), SEND_TIMEOUT_MS);
      try {
        const item = await postMessage(slug, body, {
          urgent,
          clientMessageId,
          signal: abort.signal,
        });
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
    [slug, onSending, onQueued, onSent, onSendFailed, onTerminated],
  );
  const onStop = useCallback(() => postInterrupt(slug), [slug]);
  // `@` inserts a handle as plain text; the session never calls it a mention (Q23).
  const at = useMentionSource(SESSION_AT_LABEL);
  const completions = useMemo(() => ({ at }), [at]);

  // Messages still queue; only a new session delivers them (UI design §3.6).
  const waitsForNewSession =
    agent.status === "errored" && agent.errorKind === "resume_unrecoverable";
  const hintMode: HintMode = !agent.turnOpen ? "none" : isCoarsePointer() ? "coarse" : "working";
  return (
    <ComposerPrimitive
      ref={inner}
      id="composer"
      className="shrink-0 border-t border-border px-4 py-3 md:px-6"
      draftKey={agentDraftKey(slug)}
      label={`Message to ${agent.displayName}`}
      placeholder={`Message ${agent.displayName}`}
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
      note={waitsForNewSession ? "Messages wait until a new session is started." : undefined}
      attachments
    />
  );
}, sameProps);
