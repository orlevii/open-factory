import { ApiError } from "@open-factory/shared";
import { AtSign, CircleAlert, CircleStop } from "lucide-react";
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
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Markdown } from "@/components/markdown/markdown";
import { Button, buttonVariants } from "@/components/ui/button";
import { isMac, Kbd } from "@/components/ui/kbd";
import { Textarea } from "@/components/ui/textarea";
import { readUnconfirmed, useDraft, writeUnconfirmed } from "@/lib/drafts";
import { isSendKey, isUrgentSendKey } from "@/lib/send-key";
import { cn } from "@/lib/utils";
import { type CaretAnchor, CaretMenu, type CaretMenuHandle, caretAnchor } from "./caret-menu";
import { StopButton, type StopHandle } from "./stop-button";

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
  /** An agent row's face (16px). */
  avatar?: { slug: string; template?: string; avatarVersion?: string | null };
};
/** A `/` or `@` menu's source (Tasks 52 and 56); a module constant or built with `useMemo`. */
export type CompletionSource = {
  trigger: "/" | "@";
  /** The toolbar button's accessible name; without one there is no button. */
  label?: string;
  /** While a menu from this source is open: load what `items` reads if needed, and call `onChange`
   *  when it changes, so late data shows without a keystroke. Returns the unsubscribe. */
  watch?(onChange: () => void): () => void;
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
  /** A muted status line while a submit is pending ("Posting…" for comments, which have no
   *  optimistic block of their own). */
  pendingLabel?: string;
  /** A message that stops the send before the box empties. */
  validate?(text: string): string | undefined;
  /** The `clientMessageId`s that showed up: an aborted send among them counts as sent. */
  landed?: ReadonlySet<string>;
  /** The form's id and classes (the session's composer is `#composer`, its own bordered strip). */
  id?: string;
  className?: string;
  ref?: Ref<ComposerHandle>;
};

/** At most this many rows in a caret menu (U3 §13.3, §13.4). */
const MAX_ROWS = 8;
const NO_ITEMS: CompletionItem[] = [];
const NO_SOURCES: CompletionSource[] = [];
/** An open caret menu: its source, the trigger's index, the text typed after it, where it hangs. */
type OpenMenu = { source: CompletionSource; from: number; query: string; anchor: CaretAnchor };

/** Whether `text` still has the menu's token where it was typed. */
function holds(m: OpenMenu, text: string): boolean {
  const hit = m.source.opensAt(text, m.from + 1 + m.query.length);
  return hit?.from === m.from && hit.query === m.query;
}

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
  pendingLabel,
  validate,
  completions,
  landed = NO_LANDED,
  id: formId,
  className,
  ref,
}: ComposerProps) {
  const [text, setText, draft] = useDraft(draftKey);
  const [error, setError] = useState<string | undefined>();
  const [filesNote, setFilesNote] = useState(false);
  const [view, setView] = useState<"write" | "preview">("write");
  // Submits still waiting on the server (more than one when sends overlap).
  const [pending, setPending] = useState(0);
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

  // Caret menus (U3 §13.3, §13.4). `items` runs only while one is open (review note M3).
  const slash = completions?.slash;
  const at = completions?.at;
  const sources = useMemo(
    () => (slash || at ? [slash, at].filter((c) => c !== undefined) : NO_SOURCES),
    [slash, at],
  );
  const [menuState, setMenu] = useState<OpenMenu | undefined>();
  // The menu holds only while the text still has its token (a send, Reply or a draft change can
  // replace the text without a keystroke): otherwise it is closed, whatever the state says.
  const menu = menuState && holds(menuState, text) ? menuState : undefined;
  // Bumped when the open menu's data changes (the users list arriving, a renamed agent).
  const [dataVersion, setDataVersion] = useState(0);
  const watched = menu?.source;
  useEffect(() => watched?.watch?.(() => setDataVersion((v) => v + 1)), [watched]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: dataVersion re-reads the source's data
  const items = useMemo(
    () => (menu ? menu.source.items(menu.query).slice(0, MAX_ROWS) : NO_ITEMS),
    [menu, dataVersion],
  );
  const menuOpen = items.length > 0;
  const menuRef = useRef<CaretMenuHandle>(null);
  // The trigger whose menu Esc closed: typing on in that token doesn't bring it back.
  const dismissedAt = useRef<number | undefined>(undefined);
  // After an accept or the `@` button, where the caret goes and whether to look for a menu there.
  const pendingCaret = useRef<{ at: number; look: boolean } | undefined>(undefined);

  /** Opens, updates or closes the menu for the box's text and caret. */
  const lookForMenu = (box: HTMLTextAreaElement) => {
    const caret = box.selectionStart === box.selectionEnd ? box.selectionStart : null;
    for (const source of caret === null ? NO_SOURCES : sources) {
      const hit = source.opensAt(box.value, caret as number);
      if (!hit) continue;
      if (dismissedAt.current === hit.from) break;
      dismissedAt.current = undefined;
      if (menu?.source === source && menu.from === hit.from) {
        if (menu.query !== hit.query) setMenu({ ...menu, query: hit.query });
      } else setMenu({ source, ...hit, anchor: caretAnchor(box, hit.from) });
      return;
    }
    if (caret !== null && !sources.some((c) => c.opensAt(box.value, caret))) {
      dismissedAt.current = undefined;
    }
    if (menuState) setMenu(undefined);
  };
  const closeMenu = () => {
    if (menu) dismissedAt.current = menu.from;
    setMenu(undefined);
  };
  const pick = useCallback(
    (item: CompletionItem) => {
      const box = boxRef.current;
      if (!box || !menu) return;
      const caret = box.selectionStart ?? box.value.length;
      const r = menu.source.accept(item, box.value, menu.from, caret);
      setMenu(undefined);
      setText(r.text);
      pendingCaret.current = { at: r.caret, look: false };
      box.focus();
    },
    [menu, setText],
  );
  /** The toolbar's `@`: inserts the trigger at the caret (after a space when it follows a word). */
  const insertTrigger = (trigger: string) => {
    setView("write");
    const box = boxRef.current;
    const cur = box?.value ?? text;
    const caret = box?.selectionStart ?? cur.length;
    const before = cur.slice(0, caret);
    const insert = before === "" || /\s$/.test(before) ? trigger : ` ${trigger}`;
    setText(before + insert + cur.slice(caret));
    pendingCaret.current = { at: caret + insert.length, look: true };
    if (box) box.focus();
  };
  // Runs after the text an accept or the button produced has rendered: the caret goes after it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the text that render committed
  useLayoutEffect(() => {
    const p = pendingCaret.current;
    const box = boxRef.current;
    if (!p || !box) return;
    pendingCaret.current = undefined;
    box.focus();
    box.setSelectionRange(p.at, p.at);
    if (p.look) lookForMenu(box);
  }, [text, view]);

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
      // Emptiness comes from the draft's text as last set (the updater runs at once on it), not the
      // textarea, which Preview unmounts and whose state may not have committed yet.
      prefillIfEmpty(t) {
        let did = false;
        setText((cur) => {
          if (cur.trim() !== "") return cur;
          did = true;
          return t;
        }); // unfocused: useDraft doesn't store it
        return did;
      },
      putBackIfEmpty(next) {
        let did = false;
        setText((cur) => {
          if (cur.trim() !== "") return cur;
          did = true;
          return next;
        });
        if (did) draft.persist(); // focus is elsewhere (Cancel): saved now, or a reload loses it
        return did;
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
    setMenu(undefined); // ⌥Enter or ⌘Enter sends as typed, with a menu open: it goes with the text
    setPending((n) => n + 1);
    let submitted: Promise<void>;
    try {
      submitted = onSubmit(sent, { urgent, clientMessageId, attachments: [] });
    } catch (e) {
      submitted = Promise.reject(e);
    }
    // Focus stays in the composer after sending (UI §7); from Preview, back to Write first.
    if (view === "preview") {
      setView("write");
      requestAnimationFrame(() => boxRef.current?.focus());
    } else boxRef.current?.focus();
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
    } finally {
      setPending((n) => n - 1);
    }
  }

  // U3 §6.2, in order: IME guard, the caret menu, Esc, ⌥Enter, Enter. Command mode and recall join later.
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (menuOpen) {
      const plain = !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey;
      if (plain && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
        e.preventDefault();
        menuRef.current?.move(e.key === "ArrowDown" ? 1 : -1);
        return;
      }
      // Tab commits too (Q43).
      if (plain && (e.key === "Enter" || e.key === "Tab")) {
        e.preventDefault();
        menuRef.current?.accept();
        return;
      }
      // Esc closes the menu first and leaves the text; it never goes on to stop the turn. The popover
      // may already have closed it (its own Esc listener runs first).
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closeMenu();
        return;
      }
    }
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
          className="relative rounded-lg border border-input bg-card transition-[box-shadow,border-color] duration-150 focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/20" // ui-contract:allow the frame shows focus-within; the textarea inside has no ring of its own
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
                if (sources.length) lookForMenu(e.target);
              }}
              onSelect={sources.length ? (e) => lookForMenu(e.currentTarget) : undefined}
              // A multiline combobox while it has caret menus (U3 §13.4); CaretMenu adds aria-controls
              // and aria-activedescendant while one is open.
              role={sources.length ? "combobox" : undefined}
              aria-haspopup={sources.length ? "listbox" : undefined}
              aria-expanded={sources.length ? menuOpen : undefined}
              aria-autocomplete={sources.length ? "list" : undefined}
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
          {menuOpen && menu ? (
            <CaretMenu
              ref={menuRef}
              input={boxRef}
              label={menu.source.label ?? label}
              anchor={menu.anchor}
              items={items}
              onPick={pick}
              onClose={closeMenu}
            />
          ) : null}
          <div
            data-composer-toolbar
            className="mx-1 mb-1 flex h-8 flex-nowrap items-center gap-2 pointer-coarse:h-9"
          >
            {at?.label ? (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={at.label}
                className="shrink-0 text-muted-foreground"
                onClick={() => insertTrigger("@")}
              >
                <AtSign aria-hidden="true" />
              </Button>
            ) : null}
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
                  {/* As wide as the widest label Stop shows, so the slot never grows within a turn. */}
                  <span className="grid @max-[20rem]:hidden">
                    <span
                      data-stop-label="Stop"
                      className="[grid-area:1/1] before:content-['Stop']"
                    />
                    <span
                      data-stop-label="Stopping…"
                      className="[grid-area:1/1] before:content-['Stopping…']"
                    />
                    <span
                      data-stop-label="Compacting…"
                      className="[grid-area:1/1] before:content-['Compacting…']"
                    />
                  </span>
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
        {pendingLabel && pending > 0 ? (
          <p
            role="status"
            className="mt-2 text-[0.8125rem] leading-[1.125rem] text-muted-foreground"
          >
            {pendingLabel}
          </p>
        ) : null}
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
