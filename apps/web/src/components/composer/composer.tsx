import { ApiError } from "@open-factory/shared";
import { ArrowUp, AtSign, CircleAlert, CircleStop, Paperclip, Slash } from "lucide-react";
import {
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  memo,
  type ReactNode,
  type Ref,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Markdown } from "@/components/markdown/markdown";
import { Button, buttonVariants } from "@/components/ui/button";
import { isMac, Kbd } from "@/components/ui/kbd";
import { Textarea } from "@/components/ui/textarea";
import { useIsMobile } from "@/hooks/use-mobile";
import { registerDockedComposer } from "@/lib/composer-height";
import { readUnconfirmed, useDraft, writeUnconfirmed } from "@/lib/drafts";
import { isSendKey, isUrgentSendKey } from "@/lib/send-key";
import { cn } from "@/lib/utils";
import {
  ADD_A_MESSAGE,
  AttachmentChips,
  type AttachmentStore,
  NO_FOLDERS,
  sendBlockedBy,
  type TakenUploads,
  TOO_MANY,
  type UploadSummary,
} from "./attachments";
import { CaretMenu } from "./caret-menu";
import { Recipients } from "./recipients";
import { StopButton, type StopHandle } from "./stop-button";
import { TagHighlighter } from "./tag-highlighter";
import { useTagMenu } from "./use-tag-menu";

export const NETWORK_ERROR = "Can't reach the server. Check that it's running, then try again.";
export const UNCONFIRMED = "Couldn't confirm the send. Retry sends it once.";
/** The box no longer holds the unconfirmed text (typed over, or edited), so there is no Retry. */
export const UNCONFIRMED_EDITED =
  "Couldn't confirm the send. It may still arrive; check before sending again.";
/** Where attachments aren't supported, a pasted or dropped file is ignored with this note (Q38). */
export const FILES_NOTE = "Files can be sent in an agent's session";
/** A phone's composer controls are 40px (U4 §11.4). The coarse-pointer form too: `size="icon"` sets
 *  `pointer-coarse:size-9`, which would otherwise beat a bare `size-10` on a touch screen (evidence D1). */
const PHONE_ICON = "size-10 pointer-coarse:size-10";

const NO_LANDED: ReadonlySet<string> = new Set();
const NO_UPLOADS: UploadSummary = { count: 0, pending: 0, failed: 0 };
const noUploads = () => NO_UPLOADS;
const noSubscribe = () => () => {};

/** A drop's files, without its folders (a folder arrives as a file entry that is a directory). */
function filesOf(dt: DataTransfer): { files: File[]; folders: number } {
  const items = Array.from(dt.items ?? []).filter((i) => i.kind === "file");
  const files: File[] = [];
  let folders = 0;
  Array.from(dt.files).forEach((f, i) => {
    if (items[i]?.webkitGetAsEntry?.()?.isDirectory) folders++;
    else files.push(f);
  });
  return { files, folders };
}

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
  /** Starts a group headed by this text in the menu (the `/` menu while browsing, U3 §13.3). */
  heading?: string;
  /** Enter sends the text as typed instead of accepting this row (a name typed in full); Tab and a
   *  click still accept it. */
  enterSends?: boolean;
  /** A row that can't be picked, with the reason shown in its place (a denied command). */
  disabled?: string;
  /** An agent row's face (16px). */
  avatar?: {
    agentRef: string;
    template?: string;
    avatarVersion?: string | null;
    color?: number | null;
  };
  /** A person's face (16px: their initials). */
  human?: { name: string };
  /** A `/` row: `label` is `/name` in mono, `hint` the argument hint, `detail` the description. */
  kind?: "command";
  /** "alias: cost": the alias the query matched, on the canonical row. */
  alias?: string;
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
  ): { text: string; caret: number };
  /** An `@` source that tags: picking a row records a tag range for this principal instead of calling
   *  `accept`. Its presence turns the box into a tag field (atomic ranges, sent as `<@ref>`). */
  acceptTag?(item: CompletionItem): { ref: string; handle: string };
  /** For a tag field: a principal's handle by ref (undefined while pending), to hydrate stored tags. */
  tagHandle?(ref: string): string | undefined;
  /** For a tag field: calls back when `tagHandle` may answer differently. Returns the unsubscribe. */
  watchTags?(onChange: () => void): () => void;
  /** A line in the open menu, given how many rows it has: with none, the menu still opens for it (an
   *  empty state); undefined closes a menu with no rows. */
  menuNote?(rows: number): string | undefined;
  /** Every row renders and the list scrolls at about 8 rows' height (the `/` menu: a short, fixed list
   *  where a cap would hide the built-ins behind the skills). Without it, the best 8 (`@`). */
  allRows?: boolean;
  /** The note slot's text for the whole text, at any time; cheap, it runs on every render. A
   *  `refusal` holds Send (its reason is the text). `sending` is true when Enter or Send was pressed:
   *  the first token then counts as complete without a trailing space. */
  textNote?(text: string, sending?: boolean): SourceNote | undefined;
};
/** A note a completion source puts in the slot: a refusal also holds Send. */
export type SourceNote = { kind: "refusal" | "hint"; text: string };

/**
 * The one external note the composer may show (I1 §5.4, DESIGN §9.3): a stable object from the caller.
 * The composer shows one note at a time, picked during render by priority: error > refusal > conflict >
 * hint, merged with its own notes (error, files, pending, a held Send's reason).
 */
export type ComposerNote = { kind: "refusal" | "conflict" | "hint"; text: ReactNode };
type Shown = { kind: "error" | ComposerNote["kind"]; text: ReactNode };
const NOTE_RANK = { error: 0, refusal: 1, conflict: 2, hint: 3 } as const;

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
  /** The placeholder on a phone while a turn is open: the queued-message hint, there in place of the
   *  hidden hint line (U4 §11.4). */
  turnPlaceholder?: string;
  /** The textarea's accessible name. */
  label: string;
  /** Called right after the box empties (its synchronous part runs first); resolve when the server
   *  took the text, reject with a `SubmitError` to put the text back with the reason. */
  onSubmit(text: string, o: SubmitOptions): Promise<void>;
  /** A turn is open: the hint and the phone's placeholder. */
  turnOpen?: boolean;
  compacting?: boolean;
  /** Stop shows (left of Send) with `onStop` and a `stopEpoch`: the session's open turn, the chat's
   *  turn that read your message. Esc stops it. */
  stopVisible?: boolean;
  /** Stop resets on every change (a turn edge, an unconfirmed stop). */
  stopEpoch?: number;
  onStop?(): Promise<unknown>;
  completions?: { slash?: CompletionSource; at?: CompletionSource };
  /** A Write/Preview toggle in the toolbar (task comments). */
  preview?: boolean;
  /** Files can be attached (the chat: its per-agent upload store, a stable object); elsewhere a
   *  pasted or dropped file gets `noFilesNote`. */
  attachments?: AttachmentStore;
  /** The note a pasted or dropped file gets where files can't go (default `FILES_NOTE`). */
  noFilesNote?: string;
  /** Files can't go with this send: the paperclip is aria-disabled and says why on pressing it. */
  attachBlocked?: string;
  /** The agents you added to the send (agentRefs; the chat's own is `recipientsTo`): the "To:" row shows
   *  with one. Backspace in an empty box selects the last, then removes it. */
  recipients?: readonly string[];
  /** The agent the chat is with, first in "To:". */
  recipientsTo?: string;
  /** A stable setter. */
  onRecipientsChange?(next: readonly string[]): void;
  /** The user edited the text: a note the caller holds goes (a stable callback). */
  onEdit?(): void;
  /** A note for the text as it stands (a leading `/` in the chat); cheap, it runs on every render. */
  noteFor?(text: string): ComposerNote | undefined;
  /** ↑ in an empty box with the caret at 0: the text to fill it with (U3 §13.2), if any. */
  recall?(): string | undefined;
  /** Without one there is no hint line. */
  hintMode?: HintMode;
  /** The one external note slot (who it goes to, why messages wait, a refusal). */
  note?: ComposerNote;
  /** Below md the note line is reserved under the frame only for composers that show notes; the
   *  others get it when an error or a refusal needs it. */
  reserveNote?: boolean;
  /** Sending waits (typing works). */
  waiting?: boolean;
  /** A muted status line while a submit is pending ("Posting…" for comments, which have no
   *  optimistic block of their own). */
  pendingLabel?: string;
  /** A message that stops the send before the box empties. */
  validate?(text: string, files: number): string | undefined;
  /** The `clientMessageId`s that showed up: an aborted send among them counts as sent. */
  landed?: ReadonlySet<string>;
  /** The form's id and classes (the session's composer is `#composer`, its own bordered strip). */
  id?: string;
  className?: string;
  /** A bottom-docked composer (not one mid-page): its height lifts the toasts above it. */
  docked?: boolean;
  ref?: Ref<ComposerHandle>;
};

const NO_SOURCES: CompletionSource[] = [];

/** A send whose POST aborted: the box got `sent` back (as `box`, after `before`), and its files. */
type Unconfirmed = { id: string; sent: string; box: string; before: string; taken?: TakenUploads };

/**
 * The one composer (U3 §13.1, Q21): one plate holding the auto-growing textarea and a 32px toolbar,
 * with the draft, the optimistic send and the keys (§6.2) inside it. Memoised, with primitive props
 * and stable handlers from its callers, so a frame that changes nothing it reads never renders it and
 * a keystroke renders only it.
 */
export const Composer = memo(function Composer({
  draftKey,
  placeholder,
  turnPlaceholder,
  label,
  onSubmit,
  turnOpen = false,
  compacting = false,
  stopVisible = false,
  stopEpoch,
  onStop,
  preview = false,
  attachments,
  attachBlocked,
  recipients,
  recipientsTo = "",
  onRecipientsChange,
  onEdit,
  noteFor,
  recall,
  noFilesNote = FILES_NOTE,
  hintMode,
  note,
  reserveNote,
  waiting = false,
  pendingLabel,
  validate,
  completions,
  landed = NO_LANDED,
  id: formId,
  className,
  docked = false,
  ref,
}: ComposerProps) {
  const formRef = useRef<HTMLFormElement>(null);
  const dockId = useId();
  useLayoutEffect(() => {
    const form = formRef.current;
    return docked && form ? registerDockedComposer(dockId, form) : undefined;
  }, [docked, dockId]);
  const [text, setText, draft] = useDraft(draftKey);
  const [error, setError] = useState<string | undefined>();
  const [filesNote, setFilesNote] = useState(false);
  // A refusal from the `/` source when Enter was pressed on a first token still being typed.
  const [sentRefusal, setSentRefusal] = useState<string | undefined>();
  // The reason a held Send showed when it was pressed; it goes when the box changes or the hold does.
  const [heldShownFor, setHeldShownFor] = useState<string | undefined>();
  // Files (U3 §13.5): the counts Send reads; a progress tick never changes them.
  const uploads = useSyncExternalStore(
    attachments?.subscribe ?? noSubscribe,
    attachments?.summary ?? noUploads,
  );
  const [attachNote, setAttachNote] = useState<string | undefined>();
  // The reason files can't go goes with the thing that caused it (adjusted in render, no effect).
  const [blockedWas, setBlockedWas] = useState(attachBlocked);
  if (blockedWas !== attachBlocked) {
    setBlockedWas(attachBlocked);
    if (attachNote !== undefined && attachNote === blockedWas) setAttachNote(undefined);
  }
  // The last added recipient chip is selected: the next Backspace in the empty box removes it.
  const [chipSelected, setChipSelected] = useState(false);
  const removeRecipient = useCallback(
    (agentRef: string) => {
      setChipSelected(false);
      onRecipientsChange?.((recipientsRef.current ?? []).filter((r) => r !== agentRef));
    },
    [onRecipientsChange],
  );
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  // dragenter/dragleave pairs over the frame and its children: the edge goes when the last one leaves.
  const dragDepth = useRef(0);
  const [view, setView] = useState<"write" | "preview">("write");
  // A phone (below 48rem) has no Write/Preview toggle (U4 §11.4): a Preview left open goes back to Write.
  const phone = useIsMobile();
  if (phone && view !== "write") setView("write");
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
  const recipientsRef = useRef(recipients);
  recipientsRef.current = recipients;
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
    // Its files went with it: their chips go (the uploads now belong to that message).
    if (unconfirmed.taken) attachments?.forget(unconfirmed.taken);
    setUnconfirmed(undefined);
    setError((e) => (e === UNCONFIRMED ? undefined : e));
  }, [landed, unconfirmed, setText, draft, setUnconfirmed, attachments]);
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
  const boxRef = useRef<HTMLTextAreaElement | null>(null);
  const uid = useId();
  const boxId = `${uid}-box`;
  const hintId = `${uid}-hint`;
  const lineId = `${uid}-line`;
  const sendReasonId = `${uid}-send-reason`;

  // Caret menus (U3 §13.3, §13.4). `items` runs only while one is open (review note M3).
  const slash = completions?.slash;
  const at = completions?.at;
  const sources = useMemo(
    () => (slash || at ? [slash, at].filter((c) => c !== undefined) : NO_SOURCES),
    [slash, at],
  );
  // After an accept or the `@` button, where the caret goes and whether to look for a menu there.
  const pendingCaret = useRef<{ at: number; look: boolean } | undefined>(undefined);
  // The caret menus and the tag field, one hook (use-tag-menu.tsx): a tagging `@` source makes the box a tag field.
  const {
    tag,
    menu,
    menuOpen,
    items,
    menuNote,
    menuRef,
    combobox,
    pick,
    closeMenu,
    clearMenu,
    lookForMenu,
    change,
    select,
    paste,
    keyDown,
    attach: setBox,
  } = useTagMenu({
    value: text,
    setValue: setText,
    sources,
    tagSource: at?.acceptTag ? at : undefined,
    box: boxRef,
    acceptPlain: (source, item, el, from, caret) => {
      const r = source.accept(item, el.value, from, caret);
      setText(r.text);
      pendingCaret.current = { at: r.caret, look: false };
    },
  });
  const shown = tag.tagged.text;

  /** The toolbar's `@`: inserts the trigger at the caret (after a space when it follows a word). */
  const insertTrigger = (trigger: string) => {
    setView("write");
    const box = boxRef.current;
    const cur = box?.value ?? shown;
    const caret = box?.selectionStart ?? cur.length;
    const before = cur.slice(0, caret);
    const insert = before === "" || /\s$/.test(before) ? trigger : ` ${trigger}`;
    tag.edit(before + insert + cur.slice(caret), caret + insert.length);
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
  const blocked = sendBlockedBy(uploads);
  // Why Send holds while there are files (U3 §13.5), shown under the box: Send stays focusable
  // (aria-disabled), so the reason is reachable by keyboard too.
  // A refusal from the `/` source (a denied command) holds Send too; its reason is in the slot.
  const slashNote = slash?.textNote?.(text);
  const slashRefusal = slashNote?.kind === "refusal" ? slashNote.text : undefined;
  const held = blocked ?? (uploads.count > 0 && empty ? ADD_A_MESSAGE : undefined) ?? slashRefusal;
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
    // A held Send is pressable: it says why, in the note slot.
    if (held !== undefined) {
      setHeldShownFor(held);
      return;
    }
    // A denied command whose first token is still the whole text: refused here, as when it is complete.
    const refused = slash?.textNote?.(text, true);
    if (refused?.kind === "refusal") {
      setSentRefusal(refused.text);
      return;
    }
    if (empty || waiting) return;
    const sent = text;
    const invalid = validate?.(sent, uploads.count);
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
    setAttachNote(undefined);
    setSentRefusal(undefined);
    // The finished files leave the composer with the text (back on a failure).
    const taken = attachments?.take();
    // Optimistic: the box empties at once; the stored draft keeps the text until the server takes it.
    draft.hold(sent);
    setText("");
    clearMenu(); // ⌥Enter or ⌘Enter sends as typed, with a menu open: it goes with the text
    setPending((n) => n + 1);
    let submitted: Promise<void>;
    try {
      submitted = onSubmit(sent, { urgent, clientMessageId, attachments: taken?.ids ?? [] });
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
      if (taken) attachments?.settle(taken);
    } catch (e) {
      const box = putBack(sent);
      // The chips come back too, the 15s abort's included (U3 §13.2).
      if (taken) attachments?.restore(taken);
      if (e instanceof SubmitError && e.unconfirmed) {
        setUnconfirmed({
          id: clientMessageId,
          sent,
          box,
          before: box === sent ? "" : box.slice(0, -sent.length - 1),
          ...(taken?.ids.length ? { taken } : {}),
        });
        setError(UNCONFIRMED);
      } else setError(e instanceof Error && e.message ? e.message : NETWORK_ERROR);
    } finally {
      setPending((n) => n - 1);
    }
  }

  // U3 §6.2 and §13.3, in order: IME guard, the caret menu, Esc (menu, peek, stop),
  // ⌥Enter, Enter. Recall joins later.
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (keyDown(e)) return;
    if (e.key === "Escape") {
      // An open peek or popover took this Esc first (Radix marks it handled): let it just close.
      if (e.nativeEvent.defaultPrevented) return;
      if (!stopRef.current?.stop()) return;
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    // Backspace in an empty box: the last added recipient is selected, then removed.
    if (
      e.key === "Backspace" &&
      recipients?.length &&
      text === "" &&
      !e.altKey &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.shiftKey
    ) {
      e.preventDefault();
      if (chipSelected) removeRecipient(recipients[recipients.length - 1] as string);
      else setChipSelected(true);
      return;
    }
    // Recall (U3 §13.2): ↑ in an empty box with the caret at 0 fills it with your last message's text.
    if (
      recall &&
      e.key === "ArrowUp" &&
      !e.altKey &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.shiftKey &&
      text === "" &&
      e.currentTarget.selectionStart === 0 &&
      e.currentTarget.selectionEnd === 0
    ) {
      const t = recall();
      if (t) {
        e.preventDefault();
        setText(t);
        pendingCaret.current = { at: t.length, look: false };
      }
      return;
    }
    const urgent = isUrgentSendKey(e.nativeEvent);
    if (!urgent && !isSendKey(e.nativeEvent)) return;
    e.preventDefault();
    void send(urgent);
  };

  /** Files from a paste, a drop or the picker (U3 §13.5); past the limit the rest are left out. */
  const addFiles = (files: File[], folders = 0) => {
    if (!attachments) return;
    if (attachBlocked !== undefined) {
      setAttachNote(attachBlocked);
      return;
    }
    const took = files.length ? attachments.add(files) : 0;
    setAttachNote(folders > 0 ? NO_FOLDERS : took < files.length ? TOO_MANY : undefined);
  };
  // A paste with text inserts the text and ignores its files (a spreadsheet's cells carry a PNG of
  // them); files attach only when they are all there is. Where files can't go, they get a note (Q38).
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const fileOnly =
      e.clipboardData.files.length > 0 && e.clipboardData.getData("text/plain") === "";
    if (!fileOnly) {
      // Tags in the paste go in as tags, with no change event; anything else is the browser's paste.
      paste(e);
      return;
    }
    e.preventDefault();
    if (attachments) addFiles(Array.from(e.clipboardData.files));
    else setFilesNote(true);
  };
  const hasFiles = (e: DragEvent<HTMLDivElement>) =>
    Array.from(e.dataTransfer.types).includes("Files");
  const onDragEnter = (e: DragEvent<HTMLDivElement>) => {
    if (!hasFiles(e)) return;
    dragDepth.current++;
    if (attachments && !dragging) setDragging(true);
  };
  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (attachments && !dragging) setDragging(true);
  };
  // A depth count, not `relatedTarget` (Safari reports it null on dragleave): moving between the
  // frame's children never drops the edge.
  const onDragLeave = (e: DragEvent<HTMLDivElement>) => {
    if (!hasFiles(e)) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  };
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    dragDepth.current = 0;
    if (e.dataTransfer.files.length === 0) return;
    e.preventDefault();
    setDragging(false);
    if (!attachments) {
      setFilesNote(true);
      return;
    }
    const { files, folders } = filesOf(e.dataTransfer);
    addFiles(files, folders);
  };

  const hintShown = hintMode !== undefined && hintMode !== "none" && turnOpen;
  // The one note: the highest priority wins, the earlier of equals (the more specific first). Picked
  // here, in render: no state, no effect.
  const candidates: (Shown | undefined)[] = [
    shownError ? { kind: "error", text: shownError } : undefined,
    held !== undefined && heldShownFor === held ? { kind: "refusal", text: held } : undefined,
    filesNote ? { kind: "refusal", text: noFilesNote } : undefined,
    attachNote ? { kind: "refusal", text: attachNote } : undefined,
    slashNote,
    sentRefusal ? { kind: "refusal", text: sentRefusal } : undefined,
    noteFor?.(text),
    pendingLabel && pending > 0
      ? { kind: "hint", text: <span role="status">{pendingLabel}</span> }
      : undefined,
    note,
  ];
  let slotNote: Shown | undefined;
  for (const n of candidates)
    if (n && (!slotNote || NOTE_RANK[n.kind] < NOTE_RANK[slotNote.kind])) slotNote = n;
  const slotBody =
    slotNote === undefined ? undefined : slotNote.kind === "error" ? (
      <span role="alert" className="text-destructive">
        <CircleAlert
          aria-hidden="true"
          className="mr-1.5 mb-px inline size-3.5 align-text-bottom"
        />
        {slotNote.text}
        {slotNote.text === UNCONFIRMED && (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="h-5"
            onClick={() => void send()}
          >
            Retry
          </Button>
        )}
      </span>
    ) : slotNote.kind === "hint" ? (
      slotNote.text
    ) : (
      <span role="status">{slotNote.text}</span>
    );
  // Truncated text stays readable: the slot carries its plain text (a refusal's reason is why Send holds).
  const slotTitle = typeof slotNote?.text === "string" ? slotNote.text : undefined;
  const describedBy = [hintId, phone && slotNote && lineId].filter(Boolean).join(" ") || undefined;
  // 2 → 6 lines or 35svh below md, 2 → 12 lines or 40svh from md; then it scrolls (U3 §13.1).
  const growth =
    "min-h-[calc(2lh_+_1rem)] max-h-[min(calc(6lh_+_1rem),35svh)] md:max-h-[min(calc(12lh_+_1rem),40svh)] overflow-y-auto";

  return (
    <form
      ref={formRef}
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
          onDragEnter={onDragEnter}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
          className="relative rounded-lg border border-input bg-card transition-[box-shadow,border-color] duration-150 focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/20" // ui-contract:allow the frame shows focus-within; the textarea inside has no ring of its own
        >
          {dragging && (
            // The drop target's edge in ink while a file is over it, with no animation (Q43).
            <span
              data-drop-edge
              aria-hidden="true"
              className="pointer-events-none absolute -inset-px rounded-lg border border-foreground"
            />
          )}
          {recipients && (
            <Recipients
              primaryName={recipientsTo}
              recipients={recipients}
              selected={chipSelected}
              onRemove={removeRecipient}
            />
          )}
          {attachments && <AttachmentChips store={attachments} />}
          {view === "write" ? (
            <div className="relative isolate flex min-w-0 items-start">
              {tag.highlighter ? <TagHighlighter {...tag.highlighter} /> : null}
              <Textarea
                ref={setBox}
                id={boxId}
                value={shown}
                {...tag.bind}
                onChange={(e) => {
                  change(e);
                  setError(undefined);
                  setFilesNote(false);
                  setAttachNote(undefined);
                  setChipSelected(false);
                  onEdit?.();
                  setHeldShownFor(undefined);
                  setSentRefusal(undefined);
                }}
                onSelect={
                  sources.length || tag.enabled
                    ? (e) => {
                        select(e.currentTarget);
                      }
                    : undefined
                }
                // A multiline combobox while it has caret menus (U3 §13.4); CaretMenu adds aria-controls
                // and aria-activedescendant while one is open.
                {...combobox}
                onFocus={draft.bind.onFocus}
                onBlur={() => {
                  draft.bind.onBlur();
                  setChipSelected(false);
                }}
                onKeyDown={onKeyDown}
                onPaste={onPaste}
                placeholder={phone && turnOpen && turnPlaceholder ? turnPlaceholder : placeholder}
                rows={2}
                aria-describedby={describedBy}
                className={`${growth} min-w-0 flex-1 resize-none rounded-none border-0 bg-transparent shadow-none focus-visible:outline-none dark:bg-transparent`} // ui-contract:allow the frame shows focus-within
              />
            </div>
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
              note={menuNote}
              onPick={pick}
              onClose={closeMenu}
            />
          ) : null}
          <div
            data-composer-toolbar
            // One 32px line; when the controls don't fit (200% text in a narrow column) Stop and Send
            // wrap together to a line of their own, inside the frame (evidence D1). Stop's slot keeps
            // its width across turn edges, so where it wraps never changes with a turn.
            className="mx-1 mb-1 flex min-h-8 flex-wrap items-center gap-x-2 gap-y-1 pointer-coarse:min-h-9"
          >
            {slash?.label ? (
              // Starts a command in an empty box (the `/` menu opens only for a whole-box token).
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={slash.label}
                disabled={!empty || view !== "write"}
                className={cn("shrink-0 text-muted-foreground", phone && PHONE_ICON)}
                onClick={() => insertTrigger("/")}
              >
                <Slash aria-hidden="true" />
              </Button>
            ) : null}
            {at?.label ? (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={at.label}
                className={cn("shrink-0 text-muted-foreground", phone && PHONE_ICON)}
                onClick={() => insertTrigger("@")}
              >
                <AtSign aria-hidden="true" />
              </Button>
            ) : null}
            {attachments && (
              <>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="Attach files"
                  aria-disabled={attachBlocked !== undefined || undefined}
                  className={cn("shrink-0 text-muted-foreground", phone && PHONE_ICON)}
                  onClick={() =>
                    attachBlocked !== undefined
                      ? setAttachNote(attachBlocked)
                      : fileInput.current?.click()
                  }
                >
                  <Paperclip aria-hidden="true" />
                </Button>
                <input
                  ref={fileInput}
                  type="file"
                  multiple
                  hidden
                  tabIndex={-1}
                  onChange={(e) => {
                    addFiles(Array.from(e.currentTarget.files ?? []));
                    e.currentTarget.value = ""; // the same file can be picked again
                  }}
                />
              </>
            )}
            {preview && !phone && (
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
            {phone ? (
              // No slot in the toolbar on a phone: the note has its own line under the frame, and the
              // turn hint stays the box's description.
              <>
                <span className="min-w-0 flex-1 basis-0" />
                <p id={hintId} data-composer-hint className="sr-only">
                  {hintShown ? <Hint mode={hintMode} compacting={compacting} /> : null}
                </p>
              </>
            ) : (
              // The note slot: a fixed height whether or not it has text (a minimum would let the key
              // caps grow it), so a note never moves the composer (DESIGN §9.3).
              <p
                id={hintId}
                data-composer-hint
                aria-live="polite"
                title={slotTitle}
                className={cn(
                  "h-5 flex-1 basis-0 truncate px-1.5 text-[0.8125rem] leading-5 text-muted-foreground",
                  // A reason is why Send holds: it is the last thing the toolbar cuts.
                  slotNote && slotNote.kind !== "hint" ? "min-w-[12rem]" : "min-w-0",
                )}
              >
                {slotBody ?? (hintShown ? <Hint mode={hintMode} compacting={compacting} /> : null)}
              </p>
            )}
            <div data-composer-actions className="ml-auto flex shrink-0 items-center gap-2">
              {onStop && (
                // Stop's slot keeps its width with no turn open, so a turn edge never re-wraps the toolbar.
                <div data-stop-slot className={cn("grid shrink-0", phone && PHONE_ICON)}>
                  {phone ? (
                    <span
                      data-stop-stand-in
                      aria-hidden="true"
                      className={cn(
                        buttonVariants({ variant: "outline", size: "icon" }),
                        "invisible [grid-area:1/1]",
                        PHONE_ICON,
                      )}
                    />
                  ) : (
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
                      <span className="grid @max-[24rem]:hidden">
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
                  )}
                  {stopVisible && stopEpoch !== undefined && (
                    <StopButton
                      ref={stopRef}
                      onStop={onStop}
                      turnOpen={stopVisible}
                      turnEpoch={stopEpoch}
                      compacting={compacting}
                      onError={onStopError}
                      icon={phone}
                      className={cn("[grid-area:1/1]", phone && PHONE_ICON)}
                    />
                  )}
                </div>
              )}
              {/* Primary at once when there is text: a keyboard action, so no transition. */}
              {/* Held by its files: aria-disabled (focusable; `send` refuses), its reason the line below. */}
              <Button
                type="submit"
                size={phone ? "icon" : "default"}
                aria-label={phone ? "Send" : undefined}
                disabled={held === undefined && (empty || waiting)}
                aria-disabled={held !== undefined || undefined}
                aria-describedby={
                  held
                    ? held === slashRefusal
                      ? phone
                        ? lineId
                        : hintId
                      : sendReasonId
                    : undefined
                }
                className={cn("transition-none", phone && PHONE_ICON)}
              >
                {phone ? <ArrowUp aria-hidden="true" /> : "Send"}
              </Button>
            </div>
          </div>
        </div>
        {phone && (reserveNote || slotBody !== undefined) ? (
          // Below md the slot is one line reserved under the frame (DESIGN §9.3).
          <p
            id={lineId}
            title={slotTitle}
            data-composer-note-line
            aria-live="polite"
            className="mt-1 h-[1.125rem] truncate text-[0.8125rem] leading-[1.125rem] text-muted-foreground"
          >
            {slotBody}
          </p>
        ) : null}
        {held !== undefined && held !== slashRefusal && (
          <span id={sendReasonId} data-send-reason className="sr-only">
            {held}
          </span>
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
