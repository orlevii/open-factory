import { ApiError } from "@open-factory/shared";
import { AtSign, CircleAlert, CircleStop, Paperclip, Slash } from "lucide-react";
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
  useSyncExternalStore,
} from "react";
import { Markdown } from "@/components/markdown/markdown";
import { Button, buttonVariants } from "@/components/ui/button";
import { isMac, Kbd } from "@/components/ui/kbd";
import { Textarea } from "@/components/ui/textarea";
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
  exact?: boolean;
  /** An agent row's face (16px). */
  avatar?: { slug: string; template?: string; avatarVersion?: string | null };
  /** A `/` row: `label` is `/name` in mono, `hint` the argument hint, `detail` the description. */
  kind?: "command";
  /** "alias: cost": the alias the query matched, on the canonical row. */
  alias?: string;
};
/** Command mode (U3 §13.3): the box holds the arguments of `name`, with a "Command" chip at its left. */
export type CommandMode = { name: string; placeholder: string };
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
  ): { text: string; caret: number; command?: CommandMode };
  /** Enter accepts only a row marked `exact` (the `/` menu's name matches); otherwise it sends. Tab
   *  accepts any row. Without it Enter accepts any row (`@`). */
  enterNeedsExact?: boolean;
  /** A line in the open menu, given how many rows it has: with none, the menu still opens for it (an
   *  empty state); undefined closes a menu with no rows. */
  menuNote?(rows: number): string | undefined;
  /** Under the box while a token of this source matches no row (`/foo` sends as text). */
  missNote?(): string | undefined;
  /** Under the box for the whole text, at any time (`//x`); cheap, it runs on every render. */
  textNote?(text: string): string | undefined;
  /** A typed text that enters command mode by itself (an exact name and a space). */
  commandFor?(text: string): CommandMode | undefined;
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
  /** Command mode's Enter (U3 §13.3): the chosen command's own name and the arguments, never sent as
   *  text. Reject with a `SubmitError` to show the reason and come back in command mode. */
  onCommand?(name: string, args: string, o: { clientMessageId: string }): Promise<void>;
  turnOpen?: boolean;
  compacting?: boolean;
  /** Stop resets on every change (a turn edge, an unconfirmed stop). Stop shows with `onStop`. */
  stopEpoch?: number;
  onStop?(): Promise<unknown>;
  completions?: { slash?: CompletionSource; at?: CompletionSource };
  /** A Write/Preview toggle in the toolbar (task comments). */
  preview?: boolean;
  /** Files can be attached (the session: its per-agent upload store, a stable object); elsewhere a
   *  pasted or dropped file gets `FILES_NOTE`. */
  attachments?: AttachmentStore;
  /** ↑ in an empty box with the caret at 0: the text to fill it with (U3 §13.2), if any. */
  recall?(): string | undefined;
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
  validate?(text: string, files: number): string | undefined;
  /** The `clientMessageId`s that showed up: an aborted send among them counts as sent. */
  landed?: ReadonlySet<string>;
  /** The form's id and classes (the session's composer is `#composer`, its own bordered strip). */
  id?: string;
  className?: string;
  ref?: Ref<ComposerHandle>;
};

/** A draft stored in command mode: `/name args` on one line (U3 §13.3). */
const STORED_COMMAND = /^\/(\S+) ([^\n]*)$/;
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
  label,
  onSubmit,
  onCommand,
  turnOpen = false,
  compacting = false,
  stopEpoch,
  onStop,
  preview = false,
  attachments,
  recall,
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
  // Command mode as last set (state may not have committed): the draft stores `/name args` while it is
  // on, so a restored draft shows what it is and never sends the args as a message (U3 §13.3).
  const commandRef = useRef<CommandMode | undefined>(undefined);
  const storedText = useCallback(
    (t: string) => (commandRef.current ? `/${commandRef.current.name} ${t}` : t),
    [],
  );
  const [text, setText, draft] = useDraft(draftKey, storedText);
  const [error, setError] = useState<string | undefined>();
  const [filesNote, setFilesNote] = useState(false);
  // Files (U3 §13.5): the counts Send reads; a progress tick never changes them.
  const uploads = useSyncExternalStore(
    attachments?.subscribe ?? noSubscribe,
    attachments?.summary ?? noUploads,
  );
  const [attachNote, setAttachNote] = useState<string | undefined>();
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  // dragenter/dragleave pairs over the frame and its children: the edge goes when the last one leaves.
  const dragDepth = useRef(0);
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
  const boxRef = useRef<HTMLTextAreaElement>(null);
  const uid = useId();
  const boxId = `${uid}-box`;
  const hintId = `${uid}-hint`;
  const noteId = `${uid}-note`;
  const sendReasonId = `${uid}-send-reason`;

  // Caret menus (U3 §13.3, §13.4). `items` runs only while one is open (review note M3).
  const slash = completions?.slash;
  const at = completions?.at;
  const sources = useMemo(
    () => (slash || at ? [slash, at].filter((c) => c !== undefined) : NO_SOURCES),
    [slash, at],
  );
  // Command mode (U3 §13.3): the box holds the arguments; the `/` menu doesn't open inside them.
  const [command, setCommandState] = useState<CommandMode | undefined>();
  /** Set before the text, so the draft write that follows stores the right form. */
  const setCommand = useCallback((m: CommandMode | undefined) => {
    commandRef.current = m;
    setCommandState(m);
  }, []);
  // A stored `/name args` comes back in command mode when the list knows the name (one look, at
  // mount); otherwise it stays plain text.
  // After a reload the list usually isn't loaded at mount: the restore waits for it (the source's
  // `watch`) while the box still holds exactly the stored text; typing gives up on it (evidence D2).
  const pendingRestore = useRef(STORED_COMMAND.test(text) ? text : undefined);
  const textNow = useRef(text);
  useLayoutEffect(() => {
    textNow.current = text;
  });
  useLayoutEffect(() => {
    if (pendingRestore.current === undefined) return;
    let stop: (() => void) | undefined;
    const tryRestore = () => {
      const stored = pendingRestore.current;
      if (stored === undefined || textNow.current !== stored) {
        pendingRestore.current = undefined;
        stop?.();
        return;
      }
      const m = STORED_COMMAND.exec(stored);
      const mode = m ? slash?.commandFor?.(`/${m[1]} `) : undefined;
      if (!m || !mode) return;
      pendingRestore.current = undefined;
      stop?.();
      setCommand(mode);
      setText(m[2] ?? "");
    };
    tryRestore();
    if (pendingRestore.current === undefined || !slash?.watch) return;
    stop = slash.watch(tryRestore);
    return stop;
  }, [slash, setCommand, setText]);
  const menuSources = useMemo(
    () => (command ? sources.filter((c) => c.trigger !== "/") : sources),
    [command, sources],
  );
  // A paste never opens a menu (U3 §13.3): the change it makes is skipped, and so is the text it left
  // until something is typed.
  const pasted = useRef(false);
  const pastedText = useRef<string | undefined>(undefined);
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
  const menuNote = useMemo(() => menu?.source.menuNote?.(items.length), [menu, items]);
  const menuOpen = items.length > 0 || menuNote !== undefined;
  const menuRef = useRef<CaretMenuHandle>(null);
  // The trigger whose menu Esc closed: typing on in that token doesn't bring it back.
  const dismissedAt = useRef<number | undefined>(undefined);
  // After an accept or the `@` button, where the caret goes and whether to look for a menu there.
  const pendingCaret = useRef<{ at: number; look: boolean } | undefined>(undefined);

  /** Opens, updates or closes the menu for the box's text and caret. */
  const lookForMenu = (box: HTMLTextAreaElement) => {
    if (box.value === pastedText.current) {
      if (menuState) setMenu(undefined);
      return;
    }
    const caret = box.selectionStart === box.selectionEnd ? box.selectionStart : null;
    for (const source of caret === null ? NO_SOURCES : menuSources) {
      const hit = source.opensAt(box.value, caret as number);
      if (!hit) continue;
      if (dismissedAt.current === hit.from) break;
      dismissedAt.current = undefined;
      if (menu?.source === source && menu.from === hit.from) {
        if (menu.query !== hit.query) setMenu({ ...menu, query: hit.query });
      } else setMenu({ source, ...hit, anchor: caretAnchor(box, hit.from) });
      return;
    }
    if (caret !== null && !menuSources.some((c) => c.opensAt(box.value, caret))) {
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
      if (r.command) setCommand(r.command);
      setText(r.text);
      pendingCaret.current = { at: r.caret, look: false };
      box.focus();
    },
    [menu, setText, setCommand],
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
  // A command carries no files, so they never hold it.
  const blocked = command ? undefined : sendBlockedBy(uploads);
  // Why Send holds while there are files (U3 §13.5), shown under the box: Send stays focusable
  // (aria-disabled), so the reason is reachable by keyboard too.
  const held = blocked ?? (uploads.count > 0 && empty && !command ? ADD_A_MESSAGE : undefined);
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

  /** Leaves command mode: the name goes back in front of what was typed, as text (Esc, Backspace). */
  const leaveCommand = (look: boolean) => {
    if (!command) return;
    const t = text ? `/${command.name} ${text}` : `/${command.name}`;
    setCommand(undefined);
    setText(t);
    // Esc leaves the menu closed on the name it put back (only typing opens it again; evidence D12).
    if (!look) dismissedAt.current = 0;
    pendingCaret.current = { at: t.length, look };
  };

  /** Command mode's Enter: the command's name and the arguments go to `onCommand`, never as text. On a
   *  refusal the box comes back in command mode with the arguments (unless it was used since). */
  async function runCommand() {
    if (!command || !onCommand || waiting) return;
    const mode = command;
    const sent = text;
    const full = `/${mode.name} ${sent}`;
    setError(undefined);
    setFilesNote(false);
    draft.hold(full);
    setCommand(undefined);
    setText("");
    setMenu(undefined);
    setPending((n) => n + 1);
    let run: Promise<void>;
    try {
      run = onCommand(mode.name, sent.trim(), { clientMessageId: crypto.randomUUID() });
    } catch (e) {
      run = Promise.reject(e);
    }
    boxRef.current?.focus();
    try {
      await run;
      draft.clearSent(full);
    } catch (e) {
      draft.release(full);
      let cur = "";
      setText((c) => {
        cur = c;
        return c;
      });
      if (commandRef.current) {
        // Another command was started meanwhile: it stays; the error says what happened to this one.
      } else if (cur.trim() === "") {
        setCommand(mode);
        setText(sent);
      } else {
        // The box was used since: the command goes after it as text, never lost (and never run).
        setText(`${cur}\n${full}`);
      }
      draft.persist();
      setError(e instanceof Error && e.message ? e.message : NETWORK_ERROR);
    } finally {
      setPending((n) => n - 1);
    }
  }

  async function send(urgent = false) {
    if (command) return runCommand();
    if (empty || waiting || blocked) return;
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
    // The finished files leave the composer with the text (back on a failure).
    const taken = attachments?.take();
    // Optimistic: the box empties at once; the stored draft keeps the text until the server takes it.
    draft.hold(sent);
    setText("");
    setMenu(undefined); // ⌥Enter or ⌘Enter sends as typed, with a menu open: it goes with the text
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

  // U3 §6.2 and §13.3, in order: IME guard, the caret menu, Esc (menu, command mode, peek, stop),
  // ⌥Enter, Enter. Recall joins later.
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    pasted.current = false; // a key before the change: what follows is typed (⌘V's paste comes after)
    if (menuOpen && menu) {
      const plain = !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey;
      if (plain && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
        e.preventDefault();
        menuRef.current?.move(e.key === "ArrowDown" ? 1 : -1);
        return;
      }
      // Tab commits too (Q43). In the `/` menu Enter takes only a name match; otherwise it sends the
      // text as typed (below), and with no row Tab moves on.
      if (plain && (e.key === "Enter" || e.key === "Tab")) {
        const exactOnly = e.key === "Enter" && menu.source.enterNeedsExact === true;
        if (menuRef.current?.accept(exactOnly)) {
          e.preventDefault();
          return;
        }
        if (e.key === "Tab") return;
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
      if (command) {
        e.preventDefault();
        e.stopPropagation();
        leaveCommand(false);
        return;
      }
      if (!stopRef.current?.stop()) return;
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    // Backspace in an empty command mode takes the name back as text, its menu open again.
    if (command && e.key === "Backspace" && text === "") {
      e.preventDefault();
      leaveCommand(true);
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
      !command &&
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
    // ⌥Enter acts as Enter in command mode: a command is never an urgent message.
    void (command ? runCommand() : send(urgent));
  };

  /** Files from a paste, a drop or the picker (U3 §13.5); past the limit the rest are left out. */
  const addFiles = (files: File[], folders = 0) => {
    if (!attachments) return;
    const took = files.length ? attachments.add(files) : 0;
    setAttachNote(folders > 0 ? NO_FOLDERS : took < files.length ? TOO_MANY : undefined);
  };
  // A paste with text inserts the text and ignores its files (a spreadsheet's cells carry a PNG of
  // them); files attach only when they are all there is. Where files can't go, they get a note (Q38).
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const fileOnly =
      e.clipboardData.files.length > 0 && e.clipboardData.getData("text/plain") === "";
    if (!fileOnly) {
      pasted.current = true;
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

  // `/foo` matching nothing, or `//x`: it goes as text, and the box says so (U3 §13.3).
  const slashNote =
    (menu && !menuOpen ? menu.source.missNote?.() : undefined) ??
    (command ? undefined : slash?.textNote?.(text));
  const hintShown = hintMode !== undefined && hintMode !== "none" && turnOpen;
  const commandId = `${uid}-command`;
  const describedBy =
    [command && commandId, note && noteId, hintShown && hintId].filter(Boolean).join(" ") ||
    undefined;
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
          {attachments && <AttachmentChips store={attachments} />}
          {view === "write" ? (
            // Always this wrapper, so entering command mode never remounts the textarea (focus stays).
            <div className="flex min-w-0 items-start">
              {command && (
                <span
                  id={commandId}
                  data-command-chip
                  className="mt-2 ml-2 flex max-w-[50%] shrink-0 items-center gap-1.5 rounded-sm border border-border px-1.5 text-[0.8125rem] leading-5"
                >
                  <span className="text-muted-foreground">Command</span>
                  <span className="truncate font-mono">/{command.name}</span>
                </span>
              )}
              <Textarea
                ref={boxRef}
                id={boxId}
                value={text}
                onChange={(e) => {
                  const value = e.target.value;
                  setText(value);
                  setError(undefined);
                  setFilesNote(false);
                  setAttachNote(undefined);
                  if (pasted.current) {
                    pasted.current = false;
                    pastedText.current = value;
                    if (menuState) setMenu(undefined);
                    return;
                  }
                  pastedText.current = undefined;
                  // An exact name and a space, typed: command mode (U3 §13.3).
                  const mode = command ? undefined : slash?.commandFor?.(value);
                  if (mode) {
                    setCommand(mode);
                    setText("");
                    setMenu(undefined);
                    return;
                  }
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
                placeholder={command ? command.placeholder : placeholder}
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
                disabled={!empty || command !== undefined || view !== "write"}
                className="shrink-0 text-muted-foreground"
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
                className="shrink-0 text-muted-foreground"
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
                  className="shrink-0 text-muted-foreground"
                  onClick={() => fileInput.current?.click()}
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
              <span className="min-w-0 flex-1 basis-0" />
            ) : (
              // A fixed height whether or not it has text (a minimum would let the key caps grow it).
              <p
                id={hintId}
                data-composer-hint
                className="h-5 min-w-0 flex-1 basis-0 truncate px-1.5 text-[0.8125rem] leading-5 text-muted-foreground"
              >
                {hintShown ? <Hint mode={hintMode} compacting={compacting} /> : null}
              </p>
            )}
            <div data-composer-actions className="ml-auto flex shrink-0 items-center gap-2">
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
              {/* Held by its files: aria-disabled (focusable; `send` refuses), its reason the line below. */}
              <Button
                type="submit"
                disabled={held === undefined && ((empty && !command) || waiting)}
                aria-disabled={held !== undefined || undefined}
                aria-describedby={held ? sendReasonId : undefined}
                className="transition-none"
              >
                Send
              </Button>
            </div>
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
        {/* Live regions mounted with the box, so a note that appears is announced. */}
        <p
          aria-live="polite"
          data-slash-note
          className="mt-2 text-[0.8125rem] leading-[1.125rem] text-muted-foreground empty:mt-0"
        >
          {slashNote}
        </p>
        <p aria-live="polite" className="sr-only">
          {command ? `Command mode: /${command.name}. Esc to leave.` : ""}
        </p>
        {held && (
          <p
            id={sendReasonId}
            role="status"
            data-send-reason
            className="mt-2 text-[0.8125rem] leading-[1.125rem] text-muted-foreground"
          >
            {held}
          </p>
        )}
        {attachNote && (
          <p
            role="status"
            className="mt-2 text-[0.8125rem] leading-[1.125rem] text-muted-foreground"
          >
            {attachNote}
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
