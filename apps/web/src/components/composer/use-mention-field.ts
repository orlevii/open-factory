import {
  type ChangeEvent,
  type ClipboardEvent,
  type CompositionEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
} from "react";
import {
  deleteMentionAt,
  fromClipboard,
  hydrate,
  insertMention,
  insertMentioned,
  type Mentioned,
  type MentionRange,
  rebase,
  serialise,
  snapCaret,
  snapSelection,
  toClipboard,
} from "./mention-ranges";
import { type Snapshot, UndoStack } from "./mention-undo";

/** What a mention shows while its principal is still unknown to the cache. */
const PENDING = "…";
const PENDING_LABEL = `@${PENDING}`;
const HANDLE_TAIL = /^[A-Za-z0-9-]*/;
const NO_RANGES: readonly MentionRange[] = [];
type Box = HTMLTextAreaElement | HTMLInputElement;
type Sel = readonly [number, number];

export type MentionFieldOptions = {
  /** The stored text: mentions as `<@ref>`. */
  value: string;
  setValue(next: string): void;
  /** Off, the field is plain: no ranges, nothing intercepted. */
  enabled: boolean;
  /** A principal's handle by ref; undefined while it is pending. */
  handleOf?(ref: string): string | undefined;
  /** Calls back when `handleOf` may answer differently (the cache changed). Returns the unsubscribe. */
  subscribe?(onChange: () => void): () => void;
  /** Undo or redo put this text and caret back: a menu for it stays closed. */
  onRestore?(text: string, caret: number): void;
};

/** Replaces each still-pending label with its handle once known; `map` carries a position through. */
function relabel(
  t: Mentioned,
  handleOf: (ref: string) => string | undefined,
): { mentioned: Mentioned; map(pos: number): number } | undefined {
  const cuts: [at: number, delta: number][] = [];
  let text = "";
  let last = 0;
  const ranges: MentionRange[] = [];
  for (const r of t.ranges) {
    text += t.text.slice(last, r.start);
    const old = t.text.slice(r.start, r.end);
    const handle = old === PENDING_LABEL ? handleOf(r.ref) : undefined;
    const label = handle ? `@${handle}` : old;
    if (handle) cuts.push([r.end, label.length - old.length]);
    ranges.push({ ...r, start: text.length, end: text.length + label.length });
    text += label;
    last = r.end;
  }
  if (!cuts.length) return undefined;
  const map = (pos: number) => cuts.reduce((p, [at, d]) => (at <= pos ? p + d : p), pos);
  return { mentioned: { text: text + t.text.slice(last), ranges }, map };
}

/**
 * The one owner of mention-field behaviour for a textarea or input: atomic `@handle` ranges over plain text.
 * It keeps the ranges (`mentioned`) beside the stored `value`, snaps the caret and selections around mentions, deletes a
 * whole mention, copies and pastes mentions, inserts a picked one, and owns undo (`UndoStack`; never the browser's).
 * The caller wires `bind` and the `change` / `select` / `keyDown` / `paste` handlers to its field and renders
 * `highlighter` behind it.
 */
export function useMentionField({
  value,
  setValue,
  enabled,
  handleOf,
  subscribe,
  onRestore,
}: MentionFieldOptions) {
  const live = useRef({ handleOf, setValue, onRestore });
  live.current = { handleOf, setValue, onRestore };
  const known = useCallback((ref: string) => live.current.handleOf?.(ref), []);
  const pendingOr = useCallback((ref: string) => known(ref) ?? PENDING, [known]);
  const [mentioned, setMentioned] = useState<Mentioned>(() =>
    enabled ? hydrate(value, pendingOr) : { text: value, ranges: NO_RANGES },
  );
  const undo = useRef(new UndoStack());
  const box = useRef<Box | null>(null);
  const selection = useRef<Sel>([0, 0]);
  const goTo = useRef<Sel | undefined>(undefined);
  const how = useRef<"click" | "left" | "right">("click");
  const composing = useRef(false);
  const [version, bump] = useReducer((n: number) => n + 1, 0);

  // The field shows the stored text; one that changed from outside (a draft, a send, Reply) is hydrated afresh.
  // `synced` is the last value this hook produced or hydrated: a stored `<@ref|label>` or uppercase ref doesn't
  // round-trip through `serialise`, so comparing against that would hydrate on every render.
  const synced = useRef(value);
  let cur = mentioned;
  if (!enabled) cur = { text: value, ranges: NO_RANGES };
  else if (value !== synced.current) {
    synced.current = value;
    cur = hydrate(value, pendingOr);
    setMentioned(cur);
    undo.current.clear();
  }
  const latest = useRef(cur);
  latest.current = cur;

  const snapshot = (sel: Sel = selection.current): Snapshot => ({
    text: latest.current.text,
    ranges: latest.current.ranges,
    selection: sel,
  });
  const commit = useCallback((next: Mentioned, sel: Sel) => {
    goTo.current = sel;
    selection.current = sel;
    latest.current = next;
    setMentioned(next);
    synced.current = serialise(next);
    live.current.setValue(synced.current);
  }, []);
  const restore = (s: Snapshot | undefined) => {
    if (!s) return;
    const fresh = relabel({ text: s.text, ranges: s.ranges }, known);
    commit(fresh?.mentioned ?? { text: s.text, ranges: s.ranges }, s.selection);
    live.current.onRestore?.(s.text, s.selection[0]);
  };
  const doUndo = () => restore(undo.current.undo(snapshot()));
  const doRedo = () => restore(undo.current.redo(snapshot()));

  // The caret a change asked for goes in once it has rendered.
  useLayoutEffect(() => {
    const sel = goTo.current;
    const el = box.current;
    if (!sel || !el || composing.current) return; // Safari cancels an IME composition on a selection write
    goTo.current = undefined;
    if (el.selectionStart !== sel[0] || el.selectionEnd !== sel[1])
      el.setSelectionRange(sel[0], sel[1]);
  });

  // A mention whose principal was pending takes its handle when the cache learns it. This stays an effect: it reads the
  // field's live selection (DOM) to carry the caret across the longer label, and the cache is external state that
  // only `version` signals, so there is nothing to derive in render or in a change handler.
  useEffect(() => (enabled ? subscribe?.(bump) : undefined), [enabled, subscribe]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` is the cache's change signal
  useEffect(() => {
    if (!enabled) return;
    const fresh = relabel(latest.current, known);
    if (!fresh) return;
    const el = box.current;
    if (el && document.activeElement === el) {
      const [a, b] = [fresh.map(el.selectionStart ?? 0), fresh.map(el.selectionEnd ?? 0)];
      goTo.current = [a, b];
    }
    setMentioned(fresh.mentioned);
  }, [enabled, version, known, mentioned]);

  const bindBox = useCallback((el: Box | null) => {
    box.current = el;
    if (!el) return;
    // The browser's own undo is never used: its stack knows nothing of mentions.
    const onBeforeInput = (e: Event) => {
      const type = (e as InputEvent).inputType;
      if (type !== "historyUndo" && type !== "historyRedo") return;
      e.preventDefault();
      if (type === "historyUndo") undoRef.current();
      else redoRef.current();
    };
    el.addEventListener("beforeinput", onBeforeInput);
    return () => el.removeEventListener("beforeinput", onBeforeInput);
  }, []);
  const undoRef = useRef(doUndo);
  const redoRef = useRef(doRedo);
  undoRef.current = doUndo;
  redoRef.current = doRedo;

  const selOf = (el: Box): Sel => {
    const [a, b] = snapSelection(
      latest.current.ranges,
      el.selectionStart ?? 0,
      el.selectionEnd ?? 0,
    );
    return [a, b];
  };

  /** The field's text changed (typed, deleted, or pasted natively). */
  const change = (e: ChangeEvent<Box>) => {
    const el = e.target;
    if (!enabled) {
      live.current.setValue(el.value);
      return;
    }
    const caret = el.selectionEnd ?? el.value.length;
    const kind = (e.nativeEvent as InputEvent).inputType ?? "";
    // Typing over a selection is an insertion too, though the text may not have grown.
    const typed =
      !kind.startsWith("delete") &&
      (kind.startsWith("insert") || el.value.length > latest.current.text.length);
    const before = snapshot();
    if (/Paste|Cut|Drop|Replacement/.test(kind)) undo.current.step(before);
    else undo.current.type(before, typed ? el.value.slice(caret - 1, caret) : "");
    commit(rebase(latest.current, el.value, caret), [caret, caret]);
  };

  /** The selection or caret moved: it snaps around mentions, after the browser's move. */
  const select = (el: Box) => {
    if (!enabled || composing.current || el.value !== latest.current.text) return;
    const { ranges } = latest.current;
    const s = el.selectionStart ?? 0;
    const e = el.selectionEnd ?? 0;
    let next: Sel = [s, e];
    if (s === e) {
      const at = snapCaret(ranges, s, how.current);
      next = [at, at];
    } else next = snapSelection(ranges, s, e);
    if (next[0] !== s || next[1] !== e) {
      el.setSelectionRange(next[0], next[1], el.selectionDirection ?? undefined);
    }
    selection.current = next;
  };

  /** Undo, redo and whole-mention deletes; true when it took the key. */
  const keyDown = (e: KeyboardEvent<Box>): boolean => {
    if (!enabled) return false;
    const key = e.key.toLowerCase();
    const mod = (e.metaKey || e.ctrlKey) && !e.altKey;
    if (mod && key === "z") {
      e.preventDefault();
      if (e.shiftKey) doRedo();
      else doUndo();
      return true;
    }
    if (e.ctrlKey && !e.metaKey && !e.altKey && key === "y") {
      e.preventDefault();
      doRedo();
      return true;
    }
    if (key === "arrowleft") how.current = "left";
    else if (key === "arrowright") how.current = "right";
    else how.current = "click";
    if ((e.key === "Backspace" || e.key === "Delete") && !mod && !e.shiftKey && !e.altKey) {
      const el = e.currentTarget;
      if (el.selectionStart !== el.selectionEnd) return false;
      const r = deleteMentionAt(latest.current, el.selectionStart ?? 0, e.key);
      if (!r) return false;
      e.preventDefault();
      undo.current.step(snapshot([el.selectionStart ?? 0, el.selectionStart ?? 0]));
      commit(r.mentioned, [r.caret, r.caret]);
      return true;
    }
    return false;
  };

  const copy = (e: ClipboardEvent<Box>, cut: boolean) => {
    if (!enabled) return;
    const el = e.currentTarget;
    const [a, b] = selOf(el);
    if (a === b || !latest.current.ranges.some((r) => r.start >= a && r.end <= b)) return;
    const data = toClipboard(latest.current, a, b);
    e.clipboardData.setData("text/plain", data.text);
    e.clipboardData.setData("text/html", data.html);
    e.preventDefault();
    if (!cut) return;
    undo.current.step(snapshot([a, b]));
    const r = insertMentioned(latest.current, a, b, { text: "", ranges: NO_RANGES });
    commit(r.mentioned, [r.caret, r.caret]);
  };

  /** A paste holding mentions goes in as mentions: the text it left. Undefined for anything else (the browser's paste). */
  const paste = (e: ClipboardEvent<Box>): string | undefined => {
    if (!enabled) return undefined;
    const el = e.currentTarget;
    const html = e.clipboardData.getData("text/html");
    const fragment = fromClipboard(
      { text: e.clipboardData.getData("text/plain"), ...(html ? { html } : {}) },
      pendingOr,
    );
    if (!fragment.ranges.length) return undefined;
    e.preventDefault();
    const [a, b] = selOf(el);
    undo.current.step(snapshot([a, b]));
    const r = insertMentioned(latest.current, a, b, fragment);
    commit(r.mentioned, [r.caret, r.caret]);
    return r.mentioned.text;
  };

  /** A picked mention replaces the typed `@query` (through the end of the handle, and a space after it). */
  const pickMention = (from: number, caret: number, ref: string, handle: string) => {
    const t = latest.current;
    let to = caret + (HANDLE_TAIL.exec(t.text.slice(caret))?.[0].length ?? 0);
    if (t.text[to] === " ") to++;
    undo.current.step(snapshot([caret, caret]));
    const r = insertMention(t, from, to, ref, handle);
    commit(r.mentioned, [r.caret, r.caret]);
  };

  /** A programmatic edit to the shown text (the toolbar's `@`): its own undo step, mentions kept. */
  const edit = (nextText: string, caret: number) => {
    if (!enabled) {
      live.current.setValue(nextText);
      goTo.current = [caret, caret];
      return;
    }
    undo.current.step(snapshot());
    commit(rebase(latest.current, nextText, caret), [caret, caret]);
  };

  const bind = {
    onMouseDown: () => {
      how.current = "click";
    },
    onCompositionStart: (e: CompositionEvent<Box>) => {
      composing.current = true;
      if (!enabled) return;
      // A composition that begins inside a mention turns it back into plain text.
      const at = e.currentTarget.selectionStart ?? 0;
      const { text, ranges } = latest.current;
      if (ranges.some((r) => r.start < at && at < r.end)) {
        commit({ text, ranges: ranges.filter((r) => !(r.start < at && at < r.end)) }, [at, at]);
      }
    },
    onCompositionEnd: () => {
      composing.current = false;
    },
    onCopy: (e: ClipboardEvent<Box>) => copy(e, false),
    onCut: (e: ClipboardEvent<Box>) => copy(e, true),
  };

  /** Whether a menu for the token `[from, caret]` would sit on a mention (a caret in or at the end of one). */
  const onMention = (from: number, caret: number) =>
    latest.current.ranges.some((r) => from === r.start || (caret > r.start && caret <= r.end));

  return {
    enabled,
    /** The ref callback for the field: it listens for the browser's own undo. */
    ref: bindBox,
    /** Handlers to spread on the field. */
    bind,
    /** The text and ranges the field shows. */
    mentioned: cur,
    serialised: value,
    change,
    select,
    keyDown,
    paste,
    pickMention,
    edit,
    onMention,
    /** Props for `MentionHighlighter`, behind the field; none while there is no mention to paint. */
    highlighter: cur.ranges.length ? { text: cur.text, ranges: cur.ranges, box } : undefined,
  };
}
