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
  deleteTagAt,
  fromClipboard,
  hydrate,
  insertTag,
  insertTagged,
  rebase,
  serialise,
  snapCaret,
  snapSelection,
  type Tagged,
  type TagRange,
  toClipboard,
} from "./tag-ranges";
import { type Snapshot, UndoStack } from "./tag-undo";

/** What a tag shows while its principal is still unknown to the cache. */
const PENDING = "…";
const PENDING_LABEL = `@${PENDING}`;
const HANDLE_TAIL = /^[A-Za-z0-9-]*/;
const NO_RANGES: readonly TagRange[] = [];
type Box = HTMLTextAreaElement | HTMLInputElement;
type Sel = readonly [number, number];

export type TagFieldOptions = {
  /** The stored text: tags as `<@ref>`. */
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
  t: Tagged,
  handleOf: (ref: string) => string | undefined,
): { tagged: Tagged; map(pos: number): number } | undefined {
  const cuts: [at: number, delta: number][] = [];
  let text = "";
  let last = 0;
  const ranges: TagRange[] = [];
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
  return { tagged: { text: text + t.text.slice(last), ranges }, map };
}

/**
 * The one owner of tag-field behaviour for a textarea or input: atomic `@handle` ranges over plain text.
 * It keeps the ranges (`tagged`) beside the stored `value`, snaps the caret and selections around tags, deletes a
 * whole tag, copies and pastes tags, inserts a picked one, and owns undo (`UndoStack`; never the browser's).
 * The caller wires `bind` and the `change` / `select` / `keyDown` / `paste` handlers to its field and renders
 * `highlighter` behind it.
 */
export function useTagField({
  value,
  setValue,
  enabled,
  handleOf,
  subscribe,
  onRestore,
}: TagFieldOptions) {
  const live = useRef({ handleOf, setValue, onRestore });
  live.current = { handleOf, setValue, onRestore };
  const known = useCallback((ref: string) => live.current.handleOf?.(ref), []);
  const pendingOr = useCallback((ref: string) => known(ref) ?? PENDING, [known]);
  const [tagged, setTagged] = useState<Tagged>(() =>
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
  let cur = tagged;
  if (!enabled) cur = { text: value, ranges: NO_RANGES };
  else if (value !== serialise(tagged)) {
    cur = hydrate(value, pendingOr);
    setTagged(cur);
    undo.current.clear();
  }
  const latest = useRef(cur);
  latest.current = cur;

  const snapshot = (sel: Sel = selection.current): Snapshot => ({
    text: latest.current.text,
    ranges: latest.current.ranges,
    selection: sel,
  });
  const commit = useCallback((next: Tagged, sel: Sel) => {
    goTo.current = sel;
    selection.current = sel;
    latest.current = next;
    setTagged(next);
    live.current.setValue(serialise(next));
  }, []);
  const restore = (s: Snapshot | undefined) => {
    if (!s) return;
    const fresh = relabel({ text: s.text, ranges: s.ranges }, known);
    commit(fresh?.tagged ?? { text: s.text, ranges: s.ranges }, s.selection);
    live.current.onRestore?.(s.text, s.selection[0]);
  };
  const doUndo = () => restore(undo.current.undo(snapshot()));
  const doRedo = () => restore(undo.current.redo(snapshot()));

  // The caret a change asked for goes in once it has rendered.
  useLayoutEffect(() => {
    const sel = goTo.current;
    if (!sel || !box.current) return;
    goTo.current = undefined;
    box.current.setSelectionRange(sel[0], sel[1]);
  });

  // A tag whose principal was pending takes its handle when the cache learns it.
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
    setTagged(fresh.tagged);
  }, [enabled, version, known, tagged]);

  const bindBox = useCallback((el: Box | null) => {
    box.current = el;
    if (!el) return;
    // The browser's own undo is never used: its stack knows nothing of tags.
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
    const grew = el.value.length > latest.current.text.length;
    const kind = (e.nativeEvent as InputEvent).inputType ?? "";
    const before = snapshot();
    if (/Paste|Cut|Drop|Replacement/.test(kind)) undo.current.step(before);
    else undo.current.type(before, grew ? el.value.slice(caret - 1, caret) : "");
    commit(rebase(latest.current, el.value, caret), [caret, caret]);
  };

  /** The selection or caret moved: it snaps around tags, after the browser's move. */
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

  /** Undo, redo and whole-tag deletes; true when it took the key. */
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
      const r = deleteTagAt(latest.current, el.selectionStart ?? 0, e.key);
      if (!r) return false;
      e.preventDefault();
      undo.current.step(snapshot([el.selectionStart ?? 0, el.selectionStart ?? 0]));
      commit(r.tagged, [r.caret, r.caret]);
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
    const r = insertTagged(latest.current, a, b, { text: "", ranges: NO_RANGES });
    commit(r.tagged, [r.caret, r.caret]);
  };

  /** A paste holding tags goes in as tags; true when it did (anything else is the browser's). */
  const paste = (e: ClipboardEvent<Box>): boolean => {
    if (!enabled) return false;
    const el = e.currentTarget;
    const html = e.clipboardData.getData("text/html");
    const fragment = fromClipboard(
      { text: e.clipboardData.getData("text/plain"), ...(html ? { html } : {}) },
      pendingOr,
    );
    if (!fragment.ranges.length) return false;
    e.preventDefault();
    const [a, b] = selOf(el);
    undo.current.step(snapshot([a, b]));
    const r = insertTagged(latest.current, a, b, fragment);
    commit(r.tagged, [r.caret, r.caret]);
    return true;
  };

  /** A picked tag replaces the typed `@query` (through the end of the handle, and a space after it). */
  const pickTag = (from: number, caret: number, ref: string, handle: string) => {
    const t = latest.current;
    let to = caret + (HANDLE_TAIL.exec(t.text.slice(caret))?.[0].length ?? 0);
    if (t.text[to] === " ") to++;
    undo.current.step(snapshot([caret, caret]));
    const r = insertTag(t, from, to, ref, handle);
    commit(r.tagged, [r.caret, r.caret]);
  };

  /** A programmatic edit to the shown text (the toolbar's `@`): its own undo step, tags kept. */
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
      // A composition that begins inside a tag turns it back into plain text.
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

  /** Whether a menu for the token `[from, caret]` would sit on a tag (a caret in or at the end of one). */
  const onTag = (from: number, caret: number) =>
    latest.current.ranges.some((r) => from === r.start || (caret > r.start && caret <= r.end));

  return {
    enabled,
    /** The ref callback for the field: it listens for the browser's own undo. */
    ref: bindBox,
    /** Handlers to spread on the field. */
    bind,
    /** The text and ranges the field shows. */
    tagged: cur,
    serialised: value,
    change,
    select,
    keyDown,
    paste,
    pickTag,
    edit,
    onTag,
    /** Props for `TagHighlighter`, behind the field; none while there is no tag to paint. */
    highlighter: cur.ranges.length ? { text: cur.text, ranges: cur.ranges, box } : undefined,
  };
}
