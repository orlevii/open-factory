import { setDiagnostics } from "@codemirror/lint";
import { EditorSelection, EditorState, StateEffect, Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { forwardRef, useId, useImperativeHandle, useLayoutEffect, useRef } from "react";
import { useIsMobile } from "@/hooks/use-mobile";
import {
  type Diag,
  extensionsFor,
  external,
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
  diagnostics: readonly Diag[];
};

/** A CodeMirror 6 editor for one template file at a time, controlled the CodeMirror way: edits flow
 *  out through onChange, a `value` that isn't what it last emitted replaces the doc outside history.
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
  const configured = useRef<{ language: Lang; mobile: boolean }>(undefined);

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
    configured.current = { language: p.language, mobile: m };
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
    const view = new EditorView({
      parent,
      state: stateFor(key),
      dispatchTransactions(trs, v) {
        v.update(trs);
        latest.current.props.states.set(latest.current.props.fileKey, v.state);
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
  const shownKey = useRef(fileKey);
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
  // biome-ignore lint/correctness/useExhaustiveDependencies: a swapped-in state is checked against `value` too
  useLayoutEffect(() => {
    const view = viewRef.current;
    if (!view || value === emitted.current) return;
    const doc = view.state.doc;
    if (doc.length === value.length && doc.toString() === value) return;
    view.dispatch({
      changes: { from: 0, to: doc.length, insert: value },
      annotations: [external.of(true), Transaction.addToHistory.of(false)],
    });
  }, [value, fileKey]);

  useLayoutEffect(() => {
    const view = viewRef.current;
    const c = configured.current;
    if (!view || !c) return;
    const effects: StateEffect<unknown>[] = [];
    if (c.language !== language) effects.push(languageSlot.reconfigure(languageFor(language)));
    if (c.mobile !== mobile) effects.push(markerSlot.reconfigure(markersFor(mobile)));
    if (!effects.length) return;
    configured.current = { language, mobile };
    view.dispatch({ effects });
  }, [language, mobile]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a swapped-in state gets this file's diagnostics
  useLayoutEffect(() => {
    const view = viewRef.current;
    if (view) view.dispatch(setDiagnostics(view.state, toDiagnostics(view.state.doc, diagnostics)));
  }, [diagnostics, fileKey]);

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
