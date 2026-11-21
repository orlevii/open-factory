import { type AgentSummary, ApiError, MAX_BODY_BYTES, type QueueItem } from "@open-factory/shared";
import { CircleAlert } from "lucide-react";
import { type KeyboardEvent, useCallback, useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { isMac, Kbd } from "@/components/ui/kbd";
import { Textarea } from "@/components/ui/textarea";
import { isCoarsePointer, isSendKey, isUrgentSendKey } from "@/lib/send-key";
import { postMessage } from "./api";
import { registerComposerFocus, repinTimeline } from "./session-commands";
import { StopButton, type StopHandle } from "./stop-button";

const draftKey = (slug: string) => `of-draft:${slug}`;
const readDraft = (slug: string) => {
  try {
    return sessionStorage.getItem(draftKey(slug)) ?? "";
  } catch {
    return "";
  }
};
const writeDraft = (slug: string, v: string) => {
  try {
    sessionStorage.setItem(draftKey(slug), v);
  } catch {
    /* private mode */
  }
};

export const NETWORK_ERROR = "Can't reach the server. Check that it's running, then try again.";

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
  const [draft, setDraft] = useState(() => (readDraft(slug).trim() ? readDraft(slug) : ""));
  const [copyFailed, setCopyFailed] = useState(false);
  const lineRef = useRef<HTMLParagraphElement>(null);
  async function copy() {
    setCopyFailed(false);
    try {
      const write = navigator.clipboard?.writeText(draft);
      if (!write) throw new Error("no clipboard");
      await write;
      writeDraft(slug, "");
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

export function Composer({
  slug,
  agent,
  turnEpoch,
  waiting = false,
  onQueued,
  onSent,
  onTerminated,
}: {
  slug: string;
  agent: AgentSummary;
  /** The session's turn epoch: Stop resets on every turn edge (U3 §6.1). Without one (the inbox
   *  pane, which holds no session state) the composer shows no Stop. */
  turnEpoch?: number;
  /** The session is still loading: typing works, sending waits. */
  waiting?: boolean;
  /** Called with the 202 queue item (the session inserts it locally while disconnected). */
  onQueued?: (item: QueueItem) => void;
  /** The server took the message (queued, or queued while its start failed). */
  onSent?: () => void;
  /** A send that raced a termination (`409 agent_terminated`), with the sentence that says so. */
  onTerminated?: (notice: string) => void;
}) {
  const [text, setText] = useState(() => readDraft(slug));
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | undefined>();
  // A failed Stop, on the composer's error line; it belongs to that turn (reset on its edge).
  const [stopError, setStopError] = useState<string | undefined>();
  const [errorEpoch, setErrorEpoch] = useState(turnEpoch);
  if (errorEpoch !== turnEpoch) {
    setErrorEpoch(turnEpoch);
    setStopError(undefined);
  }
  const onStopError = useCallback(
    (e: unknown) =>
      setStopError(
        e === undefined
          ? undefined
          : `Couldn't stop: ${e instanceof ApiError ? e.message : NETWORK_ERROR}`,
      ),
    [],
  );
  const stopRef = useRef<StopHandle>(null);
  const boxRef = useRef<HTMLTextAreaElement>(null);
  const id = useId();
  const hintId = `${id}-hint`;
  const boxId = `${id}-box`;
  const waitHintId = `${id}-wait`;
  // Messages still queue; only a new session delivers them (UI design §3.6).
  const waitsForNewSession =
    agent.status === "errored" && agent.errorKind === "resume_unrecoverable";
  useEffect(() => writeDraft(slug, text), [slug, text]);
  useEffect(() => registerComposerFocus(slug, () => boxRef.current?.focus()), [slug]);
  const empty = text.trim() === "";
  const shownError = error ?? stopError;

  async function send(urgent = false) {
    if (empty || sending || waiting) return;
    const sent = text;
    // Clear only what was sent: anything typed while the POST was in flight stays.
    const accepted = () => {
      setText((cur) => (cur.startsWith(sent) ? cur.slice(sent.length) : cur));
      onSent?.();
    };
    const bytes = new TextEncoder().encode(sent.trim()).length;
    if (bytes > MAX_BODY_BYTES) {
      setError(
        `This message is ${Math.ceil(bytes / 1024)} KB; the limit is 64 KB. Shorten it to send.`,
      );
      return;
    }
    setSending(true);
    setError(undefined);
    repinTimeline(slug); // sending follows the conversation again (U3 §8.1)
    try {
      const item = await postMessage(slug, sent.trim(), urgent);
      onQueued?.(item);
      accepted();
    } catch (e) {
      // 503: queued server-side; the queued row shows "Not delivered yet: <reason>".
      if (e instanceof ApiError && e.code === "agent_start_failed") accepted();
      else if (e instanceof ApiError && e.code === "agent_terminated") {
        // The draft stays: the read-only line that replaces the composer offers to copy it.
        setError(terminatedNotSent(slug));
        onTerminated?.(terminatedNotSent(slug));
      } else setError(e instanceof ApiError ? e.message : NETWORK_ERROR);
    } finally {
      setSending(false);
      boxRef.current?.focus(); // focus stays in the composer after sending (UI §7)
    }
  }

  // U3 §6.2, in order: IME guard, Esc, ⌥Enter, Enter. PR5 adds the menu, command mode and recall.
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === "Escape") {
      // An open peek or popover took this Esc first (Radix marks it handled): let it just close.
      if (e.nativeEvent.defaultPrevented) return;
      if (!stopRef.current?.stop()) return;
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    const urgent = isUrgentSendKey(e.nativeEvent);
    if (!urgent && !isSendKey(e.nativeEvent)) return;
    e.preventDefault();
    void send(urgent);
  };

  return (
    <form
      id="composer"
      className="shrink-0 border-t border-border px-4 py-3 md:px-6"
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      <div className="@container max-w-[52rem]">
        <label htmlFor={boxId} className="sr-only">
          Message to {agent.displayName}
        </label>
        <Textarea
          ref={boxRef}
          id={boxId}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setError(undefined);
          }}
          onKeyDown={onKeyDown}
          placeholder={`Message ${agent.displayName}`}
          rows={2}
          aria-describedby={
            [waitsForNewSession && waitHintId, agent.turnOpen && hintId]
              .filter(Boolean)
              .join(" ") || undefined
          }
          className="max-h-[9rem] min-h-[3.5rem] resize-none md:max-h-[18rem]"
        />
        {waitsForNewSession && (
          <p
            id={waitHintId}
            className="mt-2 text-[0.8125rem] leading-[1.125rem] text-muted-foreground"
          >
            Messages wait until a new session is started.
          </p>
        )}
        {/* Send stays right-anchored; Stop appears to its left while a turn is open. */}
        <div className="mt-2 flex items-center justify-end gap-2">
          {agent.turnOpen && turnEpoch !== undefined && (
            <StopButton
              ref={stopRef}
              slug={slug}
              turnOpen={agent.turnOpen}
              turnEpoch={turnEpoch}
              compacting={agent.compacting === true}
              onError={onStopError}
            />
          )}
          <Button type="submit" disabled={empty || sending || waiting}>
            Send
          </Button>
        </div>
        {/* Height reserved whether or not a turn is open: the composer never resizes at a turn edge. */}
        <p
          id={hintId}
          data-composer-hint
          className="mt-2 min-h-5 truncate text-[0.8125rem] leading-5 text-muted-foreground"
        >
          {agent.turnOpen ? <UrgentHint /> : null}
        </p>
        {shownError && (
          <p
            role="alert"
            className="mt-2 flex items-center gap-1.5 text-[0.8125rem] leading-[1.125rem] text-destructive"
          >
            <CircleAlert aria-hidden="true" className="size-3.5 shrink-0" />
            {shownError}
          </p>
        )}
      </div>
    </form>
  );
}

/** "Arrives at the agent's next step. ⌥↵ to interrupt instead." (Alt off Apple platforms; on touch, where
 *  there is no ⌥Enter, it points at Stop). U3 §6.2. */
function UrgentHint() {
  if (isCoarsePointer()) return <>Arrives at the agent's next step. Stop first to interrupt.</>;
  return (
    <>
      Arrives at the agent's next step.{" "}
      <Kbd keys={[isMac() ? "⌥" : "Alt", "↵"]} className="align-middle" /> to interrupt instead.
    </>
  );
}
