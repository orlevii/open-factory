import { setDiagnostics } from "@codemirror/lint";
import { EditorSelection, EditorState, StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { forwardRef, useId, useImperativeHandle, useLayoutEffect, useRef } from "react";
import { useIsMobile } from "@/hooks/use-mobile";
import {
  attrsFor,
  attrsSlot,
  type Diag,
  extensionsFor,
  type Lang,
  languageFor,
  languageSlot,
  markerSlot,
  markersFor,
  toDiagnostics,
} from "./code-editor-setup";

export type CodeEditorHandle = { focusLine(line: number): void };

type Props = {
  value: string;
  onChange(v: string): void;
  onBlur?(): void;
  onSave?(): void;
  id: string;
  labelledBy: string;
  /** Ids of the field's other descriptions; the keyboard hint is appended. */
  describedBy?: string;
  language: Lang;
  /** Template + file: the key of this file's state in `states`. */
  fileKey: string;
  /** Owned by the template editor, so a remounted tab gets its undo history back. */
  states: Map<string, EditorState>;
  /** Compared by contents, so an inline `filter` doesn't re-send them per keystroke; memoizing at the
   *  call site still saves the comparison. */
  diagnostics: readonly Diag[];
};

type Configured = {
  language: Lang;
  mobile: boolean;
  id: string;
  labelledBy: string;
  describedBy: string;
};

function sameDiags(a: readonly Diag[], b: readonly Diag[]) {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((d, i) => {
    const e = b[i];
    return (
      d.line === e?.line &&
      d.column === e.column &&
      d.message === e.message &&
      d.severity === e.severity
    );
  });
}

/** A CodeMirror 6 editor for one template file at a time, controlled the CodeMirror way: edits flow
 *  out through onChange; a `value` that isn't what it last emitted (a reload, a conflict's "Use theirs")
 *  replaces the file's state with a fresh one, so the reload can't be undone and earlier edits can't
 *  be replayed onto it.
 *  One EditorView per mount; nothing a render changes rebuilds it. */
const CodeEditor = forwardRef<CodeEditorHandle, Props>(function CodeEditor(props, ref) {
  const { value, language, fileKey, diagnostics, describedBy } = props;
  const mobile = useIsMobile();
  const hintId = `${useId()}-hint`;
  const allDescribedBy = [describedBy, hintId].filter(Boolean).join(" ");

  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView>(null);
  // Latest props, read by the view's handlers and by the effects that build a state. Written in a
  // layout effect declared before the others, so each of them reads this render's props.
  const latest = useRef({ props, mobile, allDescribedBy });
  useLayoutEffect(() => {
    latest.current = { props, mobile, allDescribedBy };
  });
  // The doc as last reported through onChange: a `value` equal to it is the parent catching up.
  const emitted = useRef<string>(undefined);
  // What the current state was configured with, so a reconfigure is only dispatched on a change.
  const configured = useRef<Configured>(undefined);
  // The file the view is showing: the key every transaction's state is saved under.
  const shownKey = useRef(fileKey);
  // The diagnostics last sent, and for which file and layout, so an equal list isn't re-sent.
  const sent = useRef<{ key: string; mobile: boolean; diags: readonly Diag[] }>(undefined);

  // A restored state is reconfigured with this mount's extensions: the saved one holds the previous
  // mount's handlers and ids. History, lint and diagnostic marks are module-level fields, so they survive.
  function stateFor(key: string): EditorState {
    const { props: p, mobile: m, allDescribedBy: d } = latest.current;
    const extensions = extensionsFor(p.language, {
      onChange: (doc) => {
        emitted.current = doc;
        latest.current.props.onChange(doc);
      },
      onSave: () => latest.current.props.onSave?.(),
      onBlur: () => latest.current.props.onBlur?.(),
      ids: { id: p.id, labelledBy: p.labelledBy, describedBy: d },
      mobile: m,
    });
    configured.current = {
      language: p.language,
      mobile: m,
      id: p.id,
      labelledBy: p.labelledBy,
      describedBy: d,
    };
    const saved = p.states.get(key);
    return saved
      ? saved.update({ effects: StateEffect.reconfigure.of(extensions) }).state
      : EditorState.create({ doc: p.value, extensions });
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: one view per mount; later props arrive through the effects below
  useLayoutEffect(() => {
    const parent = host.current;
    if (!parent) return;
    const key = latest.current.props.fileKey;
    shownKey.current = key;
    sent.current = undefined; // a new view (StrictMode re-runs this) has no diagnostics yet
    const view = new EditorView({
      parent,
      state: stateFor(key),
      dispatchTransactions(trs, v) {
        v.update(trs);
        latest.current.props.states.set(shownKey.current, v.state);
      },
    });
    viewRef.current = view;
    latest.current.props.states.set(key, view.state);
    return () => {
      viewRef.current = null;
      view.destroy();
    };
  }, []);

  // Another file in the same mount: swap in its state (or a fresh one), never sharing history.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the file only
  useLayoutEffect(() => {
    const view = viewRef.current;
    if (!view || shownKey.current === fileKey) return;
    shownKey.current = fileKey;
    emitted.current = undefined;
    view.setState(stateFor(fileKey));
    latest.current.props.states.set(fileKey, view.state);
  }, [fileKey]);

  // Runs after the file swap, so a reload and a tab change in one render land on the right state.
  // An outside value starts the file over: a fresh state from `value`, with no history to undo into.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a swapped-in state is checked against `value` too
  useLayoutEffect(() => {
    const view = viewRef.current;
    if (!view || value === emitted.current) return;
    const doc = view.state.doc;
    if (doc.length === value.length && doc.toString() === value) return;
    const key = shownKey.current;
    const { states: map } = latest.current.props;
    map.delete(key);
    emitted.current = undefined;
    view.setState(stateFor(key));
    map.set(key, view.state);
    sent.current = undefined; // the fresh state has no diagnostics; the effect below re-sends them
  }, [value, fileKey]);

  const { id, labelledBy } = props;
  useLayoutEffect(() => {
    const view = viewRef.current;
    const c = configured.current;
    if (!view || !c) return;
    const effects: StateEffect<unknown>[] = [];
    if (c.language !== language) effects.push(languageSlot.reconfigure(languageFor(language)));
    if (c.mobile !== mobile) effects.push(markerSlot.reconfigure(markersFor(mobile)));
    if (c.id !== id || c.labelledBy !== labelledBy || c.describedBy !== allDescribedBy)
      effects.push(
        attrsSlot.reconfigure(attrsFor({ id, labelledBy, describedBy: allDescribedBy })),
      );
    if (!effects.length) return;
    configured.current = { language, mobile, id, labelledBy, describedBy: allDescribedBy };
    view.dispatch({ effects });
  }, [language, mobile, id, labelledBy, allDescribedBy]);

  // After the effects above: a swapped-in, restarted or re-laid-out state (a breakpoint flip recreates
  // the gutter's marks empty) gets this file's diagnostics again; an equal list on the same state doesn't.
  // biome-ignore lint/correctness/useExhaustiveDependencies: value and fileKey only mark when the state may have been replaced
  useLayoutEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const key = shownKey.current;
    const s = sent.current;
    if (s && s.key === key && s.mobile === mobile && sameDiags(s.diags, diagnostics)) return;
    sent.current = { key, mobile, diags: diagnostics };
    view.dispatch(setDiagnostics(view.state, toDiagnostics(view.state.doc, diagnostics)));
  }, [diagnostics, fileKey, mobile, value]);

  useImperativeHandle(
    ref,
    () => ({
      focusLine(line: number) {
        const view = viewRef.current;
        if (!view) return;
        const doc = view.state.doc;
        const at = doc.line(Math.min(Math.max(1, line), doc.lines)).from;
        view.dispatch({
          selection: EditorSelection.cursor(at),
          effects: EditorView.scrollIntoView(at, { y: "center" }),
        });
        view.focus();
      },
    }),
    [],
  );

  return (
    <div className="group grid gap-1.5">
      <div
        ref={host}
        className="overflow-hidden rounded-lg border border-code-border bg-code transition-[box-shadow,border-color] duration-150 focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/20 pointer-coarse:[&_.cm-content]:text-[16px]! pointer-coarse:[&_.cm-content]:leading-6!" // ui-contract:allow the frame shows focus-within; CodeMirror's content has no ring of its own
      />
      {/* Always in the DOM so aria-describedby resolves; shown while the editor has focus. */}
      <p
        id={hintId}
        className="sr-only text-xs text-muted-foreground group-focus-within:not-sr-only"
      >
        Esc then Tab to leave the editor
      </p>
    </div>
  );
});

export default CodeEditor;
