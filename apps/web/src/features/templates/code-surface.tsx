import type { EditorState } from "@codemirror/state";
import {
  type ComponentPropsWithoutRef,
  type CSSProperties,
  forwardRef,
  lazy,
  type Ref,
  Suspense,
  useImperativeHandle,
  useRef,
} from "react";
import type { default as CodeEditorComponent, CodeEditorHandle } from "./code-editor";
import type { Diag, Lang } from "./code-editor-setup";
import { CodeTextarea } from "./code-textarea";

/**
 * The one way a page shows a code editor (the template editor's files, the Configuration page's Raw JSON): CodeMirror
 * in its own lazily loaded chunk, a textarea with the editor's text position until it arrives, and the same textarea
 * for good if the chunk can't load. Nothing here imports `code-editor.tsx` statically, so a page that uses this module
 * keeps CodeMirror out of its own chunk.
 */

function lineOffset(content: string, line: number) {
  const lines = content.split("\n");
  const n = Math.min(Math.max(line, 1), lines.length);
  return lines.slice(0, n - 1).reduce((sum, l) => sum + l.length + 1, 0);
}

/** Focus a textarea at a line's start and scroll it to the middle (the jump, without CodeMirror). */
export function focusTextareaLine(el: HTMLTextAreaElement, line: number) {
  const at = lineOffset(el.value, line);
  el.focus({ preventScroll: true });
  el.setSelectionRange(at, at);
  const lh = Number.parseFloat(getComputedStyle(el).lineHeight) || 20;
  el.scrollTop = Math.max(0, (line - 1) * lh - el.clientHeight / 2);
  el.scrollIntoView?.({ block: "nearest" });
}

type EditorProps = ComponentPropsWithoutRef<typeof CodeEditorComponent>;

/** Stands in for the editor when its chunk can't load (offline, a stale deploy's chunk): the file
 *  stays editable as text (or read-only, as the editor would be), with the same handle. */
export const TextareaEditor = forwardRef<CodeEditorHandle, EditorProps>(
  function TextareaEditor(p, ref) {
    const el = useRef<HTMLTextAreaElement>(null);
    useImperativeHandle(
      ref,
      () => ({
        focusLine(line) {
          if (el.current) focusTextareaLine(el.current, line);
        },
        restore({ anchor, head, focus }) {
          const t = el.current;
          if (!t) return;
          t.setSelectionRange(
            Math.min(anchor, head),
            Math.max(anchor, head),
            anchor > head ? "backward" : "forward",
          );
          if (focus) t.focus();
        },
      }),
      [],
    );
    return (
      <CodeTextarea
        id={p.id}
        aria-labelledby={p.labelledBy}
        describedBy={p.describedBy}
        value={p.value}
        onChange={p.onChange}
        onBlur={p.onBlur}
        onSave={p.onSave}
        readOnly={p.readOnly}
        textareaRef={el}
      />
    );
  },
);

// Set once the chunk has settled: from then on a fallback textarea is only ever detached by the
// swap itself, so that's the only detach whose selection is carried over.
let editorSettled = false;
export const isEditorSettled = () => editorSettled;

/** Its own chunk (CodeMirror), preloaded by a route's loader on a real visit (U4 spec §12.2). A failed
 *  load falls back to the textarea rather than taking the page down. */
export const LazyCodeEditor = lazy(() =>
  import("./code-editor").then(
    (m) => {
      editorSettled = true;
      return m;
    },
    () => {
      editorSettled = true;
      return { default: TextareaEditor };
    },
  ),
);

// The fallback's text starts where the editor's will, so the swap doesn't move it: the line-number
// gutter (16px padding plus one 14px-mono digit, 8.4px, per digit of the line count, CodeMirror's own
// sizing), its 1px border, the lint gutter (19.6px, from md) and the line's 8px inset. On touch the
// editor's lines are 24px, so the fallback's are too. Measured in Chromium and WebKit (Task 42).
const GUTTER_PAD =
  "pl-[calc(var(--gutter-digits)_*_8.4px_+_44.6px)] max-md:pl-[calc(var(--gutter-digits)_*_8.4px_+_25px)] pointer-coarse:leading-6";

/** The digits of the line count: CodeMirror's line-number gutter is as wide as the widest number. */
function gutterDigits(value: string) {
  let lines = 1;
  for (let i = value.indexOf("\n"); i !== -1; i = value.indexOf("\n", i + 1)) lines++;
  return String(lines).length;
}

export type CodeSurfaceProps = {
  /** The editing element's id: the jump target, and what a label's `for` names. */
  id: string;
  /** The fallback textarea's accessible name (the editor is named by `labelledBy`). */
  label: string;
  language: Lang;
  value: string;
  onChange(v: string): void;
  onBlur?(): void;
  onSave?(): void;
  describedBy?: string;
  labelledBy: string;
  fileKey: string;
  states: Map<string, EditorState>;
  diagnostics: readonly Diag[];
  readOnly?: boolean;
  scrollMarginBottom?: number;
  textareaRef?: Ref<HTMLTextAreaElement>;
  editorRef?: Ref<CodeEditorHandle>;
};

/** One file in CodeMirror. Until its chunk arrives, the textarea, with its text where the editor's
 *  will be; on the swap the selection, scroll and focus carry over (through the caller's refs). */
export function CodeSurface(p: CodeSurfaceProps) {
  return (
    <Suspense
      fallback={
        <CodeTextarea
          id={p.id}
          aria-label={p.label}
          describedBy={p.describedBy}
          value={p.value}
          onChange={p.onChange}
          onBlur={p.onBlur}
          onSave={p.onSave}
          readOnly={p.readOnly}
          textareaRef={p.textareaRef}
          className={GUTTER_PAD}
          style={{ "--gutter-digits": gutterDigits(p.value) } as CSSProperties}
        />
      }
    >
      <LazyCodeEditor
        ref={p.editorRef}
        id={p.id}
        labelledBy={p.labelledBy}
        describedBy={p.describedBy}
        value={p.value}
        onChange={p.onChange}
        onBlur={p.onBlur}
        onSave={p.onSave}
        language={p.language}
        fileKey={p.fileKey}
        states={p.states}
        diagnostics={p.diagnostics}
        readOnly={p.readOnly}
        scrollMarginBottom={p.scrollMarginBottom}
      />
    </Suspense>
  );
}
