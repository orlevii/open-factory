import { ApiError } from "@open-factory/shared";
import { CircleAlert, CircleStop } from "lucide-react";
import {
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  memo,
  type Ref,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { Markdown } from "@/components/markdown/markdown";
import { Button, buttonVariants } from "@/components/ui/button";
import { isMac, Kbd } from "@/components/ui/kbd";
import { Textarea } from "@/components/ui/textarea";
import { StopButton, type StopHandle } from "@/features/session/stop-button";
import { readUnconfirmed, useDraft, writeUnconfirmed } from "@/lib/drafts";
import { isSendKey, isUrgentSendKey } from "@/lib/send-key";
import { cn } from "@/lib/utils";

export const NETWORK_ERROR = "Can't reach the server. Check that it's running, then try again.";
export const UNCONFIRMED = "Couldn't confirm the send. Retry sends it once.";
/** The box no longer holds the unconfirmed text (typed over, or edited), so there is no Retry. */
export const UNCONFIRMED_EDITED =
  "Couldn't confirm the send. It may still arrive; check before sending again.";
/** Where attachments aren't supported, a pasted or dropped file is ignored with this note (Q38). */
export const FILES_NOTE = "Files can be sent in an agent's session";
const NO_LANDED: ReadonlySet<string> = new Set();

export type SubmitOptions = { urgent: boolean; clientMessageId: string; attachments: string[] };

/** What `onSubmit` rejects with: `message` goes on the error line; `unconfirmed` when the send aborted
 *  and may still land (the box then resends that exact text under the same id, U3 §13.2). */
export class SubmitError extends Error {
  readonly unconfirmed: boolean;
  constructor(message: string, o: { unconfirmed?: boolean } = {}) {
    super(message);
    this.unconfirmed = o.unconfirmed === true;
  }
}

export type CompletionItem = {
  id: string;
  label: string;
  detail?: string;
  hint?: string;
  group: string;
  exact?: boolean;
};
/** A `/` or `@` menu's source (Tasks 52 and 56); a module constant or built with `useMemo`. */
export type CompletionSource = {
  trigger: "/" | "@";
  opensAt(text: string, caret: number): { query: string; from: number } | undefined;
  items(query: string): CompletionItem[];
  accept(
    item: CompletionItem,
    text: string,
    from: number,
    caret: number,
  ): { text: string; caret: number; commandMode?: boolean };
};

/** What callers do to the box from outside it: Reply, a deep link's prefill, Cancel and its Undo. */
export type ComposerHandle = {
  /** Write mode, then the textarea takes focus (scrolled into view). */
  focus(): void;
  /** `text` goes at the start of the box, once (nothing when the box already starts with it). */
  insertAtStart(text: string): void;
  /** Puts `text` in an empty box without focusing it and without keeping it as a draft. */
  prefillIfEmpty(text: string): boolean;
  /** Puts `text` in the box when it is empty, saved as the draft at once; true when it did. */
  putBackIfEmpty(text: string): boolean;
  /** Empties the box only if it still holds exactly `text`. */
  clearIfUnchanged(text: string): void;
};

/** The toolbar's hint (U3 §6.2), as a primitive so it never breaks `memo`: "none" keeps the line's
 *  room empty, "working" is the ⌥↵ hint, "coarse" the touch one (no ⌥Enter there). */
export type HintMode = "none" | "working" | "coarse";

export type ComposerProps = {
  draftKey: string;
  placeholder: string;
  /** The textarea's accessible name. */
  label: string;
  /** Called right after the box empties (its synchronous part runs first); resolve when the server
   *  took the text, reject with a `SubmitError` to put the text back with the reason. */
  onSubmit(text: string, o: SubmitOptions): Promise<void>;
  turnOpen?: boolean;
  compacting?: boolean;
  /** Stop resets on every change (a turn edge, an unconfirmed stop). Stop shows with `onStop`. */
  stopEpoch?: number;
  onStop?(): Promise<unknown>;
  completions?: { slash?: CompletionSource; at?: CompletionSource };
  /** A Write/Preview toggle in the toolbar (task comments). */
  preview?: boolean;
  /** Files can be attached (the session); elsewhere a pasted or dropped file gets `FILES_NOTE`. */
  attachments?: boolean;
  /** Without one there is no hint line. */
  hintMode?: HintMode;
  /** A muted line under the frame that describes the box (who it goes to, why messages wait). */
  note?: string;
  /** Sending waits (typing works). */
  waiting?: boolean;
  /** A message that stops the send before the box empties. */
  validate?(text: string): string | undefined;
  /** The `clientMessageId`s that showed up: an aborted send among them counts as sent. */
  landed?: ReadonlySet<string>;
  /** The form's id and classes (the session's composer is `#composer`, its own bordered strip). */
  id?: string;
  className?: string;
  ref?: Ref<ComposerHandle>;
};

/** A send whose POST aborted: the box got `sent` back (as `box`, after `before`). */
type Unconfirmed = { id: string; sent: string; box: string; before: string };

/**
 * The one composer (U3 §13.1, Q21): one plate holding the auto-growing textarea and a 32px toolbar,
 * with the draft, the optimistic send and the keys (§6.2) inside it. Memoised, with primitive props
 * and stable handlers from its callers, so a frame that changes nothing it reads never renders it and
 * a keystroke renders only it.
 */
export const Composer = memo(function Composer({
  draftKey,
  placeholder,
  label,
  onSubmit,
  turnOpen = false,
  compacting = false,
  stopEpoch,
  onStop,
  preview = false,
  attachments = false,
  hintMode,
  note,
  waiting = false,
  validate,
  landed = NO_LANDED,
  id: formId,
  className,
  ref,
}: ComposerProps) {
  const [text, setText, draft] = useDraft(draftKey);
  const [error, setError] = useState<string | undefined>();
  const [filesNote, setFilesNote] = useState(false);
  const [view, setView] = useState<"write" | "preview">("write");
  // An aborted send survives a remount beside its draft, so its unchanged text resends under its id.
  const [unconfirmed, setUnconfirmedState] = useState<Unconfirmed | undefined>(() => {
    const u = readUnconfirmed(draftKey);
    return u && text === u.sent ? { ...u, box: u.sent, before: "" } : undefined;
  });
  const setUnconfirmed = useCallback(
    (u: Unconfirmed | undefined) => {
      setUnconfirmedState(u);
      writeUnconfirmed(draftKey, u && { id: u.id, sent: u.sent });
    },
    [draftKey],
  );
  // Read when a submit settles, long after the render that started it.
  const landedRef = useRef(landed);
  useEffect(() => {
    landedRef.current = landed;
  }, [landed]);
  // A late landing of an aborted send (U3 §13.2): the unchanged box clears and the error goes.
  useEffect(() => {
    if (!unconfirmed || !landed.has(unconfirmed.id)) return;
    setText((cur) => (cur === unconfirmed.box ? unconfirmed.before : cur));
    draft.clearSent(unconfirmed.sent);
    setUnconfirmed(undefined);
    setError((e) => (e === UNCONFIRMED ? undefined : e));
  }, [landed, unconfirmed, setText, draft, setUnconfirmed]);
  // A failed Stop, on the error line; it belongs to that turn (reset on its edge).
  const [stopError, setStopError] = useState<string | undefined>();
  const [errorEpoch, setErrorEpoch] = useState(stopEpoch);
  if (errorEpoch !== stopEpoch) {
    setErrorEpoch(stopEpoch);
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
  const uid = useId();
  const boxId = `${uid}-box`;
  const hintId = `${uid}-hint`;
  const noteId = `${uid}-note`;

  useImperativeHandle(
    ref,
    () => ({
      focus() {
        setView("write");
        const go = () => {
          boxRef.current?.focus();
          boxRef.current?.scrollIntoView?.({ block: "nearest" });
        };
        // In Preview the textarea isn't mounted yet: focus once Write has rendered.
        if (boxRef.current) go();
        else requestAnimationFrame(go);
      },
      insertAtStart(t) {
        setView("write");
        setText((cur) => (cur.startsWith(t) ? cur : `${t}${cur}`));
      },
      prefillIfEmpty(t) {
        // The DOM value is the box as it is now (state may not have committed yet).
        if ((boxRef.current?.value ?? "").trim() !== "") return false;
        setText(t); // unfocused: useDraft doesn't store it
        return true;
      },
      putBackIfEmpty(next) {
        if ((boxRef.current?.value ?? "").trim() !== "") return false;
        setText(next);
        draft.persist(); // focus is elsewhere (Cancel): saved now, or a reload loses it
        return true;
      },
      clearIfUnchanged(sent) {
        setText((cur) => (cur === sent ? "" : cur));
        draft.persist();
      },
    }),
    [setText, draft],
  );

  const empty = text.trim() === "";
  const retryable = unconfirmed !== undefined && text === unconfirmed.sent;
  const shownError =
    error === UNCONFIRMED && !retryable ? UNCONFIRMED_EDITED : (error ?? stopError);

  /** The text goes back in the box after anything typed since; returns what the box then holds. */
  const putBack = (sent: string) => {
    draft.release(sent);
    let box = sent;
    setText((cur) => {
      box = cur.trim() ? `${cur}\n${sent}` : sent;
      return box;
    });
    draft.persist();
    return box;
  };

  async function send(urgent = false) {
    if (empty || waiting) return;
    const sent = text;
    const invalid = validate?.(sent);
    if (invalid) {
      setError(invalid);
      return;
    }
    // U3 §13.2: exactly the text of an unconfirmed send goes again under the same id, so a late-landing
    // original can never be delivered twice. Anything else (text typed meanwhile included) is a new
    // message: under the old id the server would dedupe it to the original and the extra text be lost.
    const retry =
      unconfirmed && sent === unconfirmed.sent && !landedRef.current.has(unconfirmed.id)
        ? unconfirmed.id
        : undefined;
    const clientMessageId = retry ?? crypto.randomUUID();
    setUnconfirmed(undefined);
    setError(undefined);
    setFilesNote(false);
    // Optimistic: the box empties at once; the stored draft keeps the text until the server takes it.
    draft.hold(sent);
    setText("");
    let submitted: Promise<void>;
    try {
      submitted = onSubmit(sent, { urgent, clientMessageId, attachments: [] });
    } catch (e) {
      submitted = Promise.reject(e);
    }
    boxRef.current?.focus(); // focus stays in the composer after sending (UI §7)
    try {
      await submitted;
      draft.clearSent(sent);
    } catch (e) {
      const box = putBack(sent);
      if (e instanceof SubmitError && e.unconfirmed) {
        setUnconfirmed({
          id: clientMessageId,
          sent,
          box,
          before: box === sent ? "" : box.slice(0, -sent.length - 1),
        });
        setError(UNCONFIRMED);
      } else setError(e instanceof Error && e.message ? e.message : NETWORK_ERROR);
    }
  }

  // U3 §6.2, in order: IME guard, Esc, ⌥Enter, Enter. Menus, command mode and recall join later.
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

  // Q38: where files can't go, a file is ignored with a note. Text on the clipboard still pastes.
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    if (attachments || e.clipboardData.files.length === 0) return;
    if (e.clipboardData.getData("text/plain") !== "") return;
    e.preventDefault();
    setFilesNote(true);
  };
  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (!attachments && e.dataTransfer.types.includes("Files")) e.preventDefault();
  };
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    if (attachments || e.dataTransfer.files.length === 0) return;
    e.preventDefault();
    setFilesNote(true);
  };

  const hintShown = hintMode !== undefined && hintMode !== "none" && turnOpen;
  const describedBy = [note && noteId, hintShown && hintId].filter(Boolean).join(" ") || undefined;
  // 2 → 6 lines or 35svh below md, 2 → 12 lines or 40svh from md; then it scrolls (U3 §13.1).
  const growth =
    "min-h-[calc(2lh_+_1rem)] max-h-[min(calc(6lh_+_1rem),35svh)] md:max-h-[min(calc(12lh_+_1rem),40svh)] overflow-y-auto";

  return (
    <form
      id={formId}
      className={className}
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      <div className="@container max-w-[52rem]">
        <label htmlFor={boxId} className="sr-only">
          {label}
        </label>
        {/* biome-ignore lint/a11y/noStaticElementInteractions: a file drop target only; the keyboard pastes into the textarea */}
        <div
          data-composer-frame
          onDragOver={onDragOver}
          onDrop={onDrop}
          className="rounded-lg border border-input bg-card transition-[box-shadow,border-color] duration-150 focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/20" // ui-contract:allow the frame shows focus-within; the textarea inside has no ring of its own
        >
          {view === "write" ? (
            <Textarea
              ref={boxRef}
              id={boxId}
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                setError(undefined);
                setFilesNote(false);
              }}
              onFocus={draft.bind.onFocus}
              onBlur={draft.bind.onBlur}
              onKeyDown={onKeyDown}
              onPaste={onPaste}
              placeholder={placeholder}
              rows={2}
              aria-describedby={describedBy}
              className={`${growth} resize-none rounded-none border-0 bg-transparent shadow-none focus-visible:outline-none dark:bg-transparent`} // ui-contract:allow the frame shows focus-within
            />
          ) : (
            <div className={`${growth} px-2.5 py-2`}>
              {empty ? (
                <p className="text-sm text-muted-foreground">Nothing to preview.</p>
              ) : (
                <Markdown source={text} variant="detail" />
              )}
            </div>
          )}
          <div
            data-composer-toolbar
            className="mx-1 mb-1 flex h-8 flex-nowrap items-center gap-2 pointer-coarse:h-9"
          >
            {preview && (
              <div className="flex shrink-0 items-center">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-pressed={view === "write"}
                  className="aria-pressed:text-foreground text-muted-foreground"
                  onClick={() => setView("write")}
                >
                  Write
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-pressed={view === "preview"}
                  className="aria-pressed:text-foreground text-muted-foreground"
                  onClick={() => setView("preview")}
                >
                  Preview
                </Button>
              </div>
            )}
            {hintMode === undefined ? (
              <span className="min-w-0 flex-1" />
            ) : (
              // A fixed height whether or not it has text (a minimum would let the key caps grow it).
              <p
                id={hintId}
                data-composer-hint
                className="h-5 min-w-0 flex-1 truncate px-1.5 text-[0.8125rem] leading-5 text-muted-foreground"
              >
                {hintShown ? <Hint mode={hintMode} compacting={compacting} /> : null}
              </p>
            )}
            {onStop && (
              // Stop's slot keeps its width with no turn open, so a turn edge never re-wraps the toolbar.
              <div data-stop-slot className="grid shrink-0">
                <span
                  data-stop-stand-in
                  aria-hidden="true"
                  className={cn(
                    buttonVariants({ variant: "outline" }),
                    "invisible [grid-area:1/1]",
                  )}
                >
                  <CircleStop />
                  <span className="before:content-['Stop'] @max-[20rem]:hidden" />
                </span>
                {turnOpen && stopEpoch !== undefined && (
                  <StopButton
                    ref={stopRef}
                    onStop={onStop}
                    turnOpen={turnOpen}
                    turnEpoch={stopEpoch}
                    compacting={compacting}
                    onError={onStopError}
                    className="[grid-area:1/1]"
                  />
                )}
              </div>
            )}
            {/* Primary at once when there is text: a keyboard action, so no transition. */}
            <Button type="submit" disabled={empty || waiting} className="transition-none">
              Send
            </Button>
          </div>
        </div>
        {note && (
          <p id={noteId} className="mt-2 text-[0.8125rem] leading-[1.125rem] text-muted-foreground">
            {note}
          </p>
        )}
        {filesNote && (
          <p
            role="status"
            className="mt-2 text-[0.8125rem] leading-[1.125rem] text-muted-foreground"
          >
            {FILES_NOTE}
          </p>
        )}
        {shownError && (
          <p
            role="alert"
            className="mt-2 flex items-center gap-1.5 text-[0.8125rem] leading-[1.125rem] text-destructive"
          >
            <CircleAlert aria-hidden="true" className="size-3.5 shrink-0" />
            {shownError}
            {shownError === UNCONFIRMED && (
              <Button type="button" variant="ghost" size="xs" onClick={() => void send()}>
                Retry
              </Button>
            )}
          </p>
        )}
      </div>
    </form>
  );
});

/** "Arrives at the agent's next step. ⌥↵ to interrupt instead." (Alt off Apple platforms; on touch, where
 *  there is no ⌥Enter, it points at Stop). U3 §6.2. A compaction is never interrupted (D5), so while one
 *  runs it promises nothing more than "Arrives after the compaction." */
function Hint({ mode, compacting }: { mode: HintMode; compacting: boolean }) {
  if (compacting) return <>Arrives after the compaction.</>;
  if (mode === "coarse") return <>Arrives at the agent's next step. Stop first to interrupt.</>;
  return (
    <>
      Arrives at the agent's next step.{" "}
      {/* Top-aligned: the 1.25rem caps fill the 1.25rem line box instead of overhanging it. */}
      <Kbd keys={[isMac() ? "⌥" : "Alt", "↵"]} className="align-top" /> to interrupt instead.
    </>
  );
}
