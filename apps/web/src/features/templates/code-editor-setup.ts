import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { json } from "@codemirror/lang-json";
import { markdownLanguage } from "@codemirror/lang-markdown";
import { yaml } from "@codemirror/lang-yaml";
import {
  bracketMatching,
  HighlightStyle,
  indentOnInput,
  LanguageSupport,
  syntaxHighlighting,
} from "@codemirror/language";
import { type Diagnostic, lintGutter, lintKeymap, setDiagnosticsEffect } from "@codemirror/lint";
import {
  Annotation,
  type AnnotationType,
  Compartment,
  type Extension,
  RangeSet,
  StateField,
  type Text,
} from "@codemirror/state";
import {
  drawSelection,
  EditorView,
  GutterMarker,
  keymap,
  lineNumberMarkers,
  lineNumbers,
} from "@codemirror/view";
import { tags as t } from "@lezer/highlight";

export type Lang = "yaml" | "json" | "markdown";
export type Diag = {
  line: number;
  column?: number;
  message: string;
  severity: "error" | "warning";
};

/** Validator issues (1-based line, optional 1-based column) as CodeMirror diagnostics: from the column
 *  (or the line's start) to the line's end. Issues on lines the doc doesn't have are dropped. */
export function toDiagnostics(doc: Text, diags: readonly Diag[]): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const d of diags) {
    if (d.line < 1 || d.line > doc.lines) continue;
    const line = doc.line(d.line);
    const from = Math.min(line.from + Math.max(0, (d.column ?? 1) - 1), line.to);
    out.push({ from, to: line.to, message: d.message, severity: d.severity });
  }
  return out;
}

/** Marks a transaction that replaces the doc from outside (a reload, a conflict's "Use theirs"):
 *  the update listener doesn't report it as an edit. */
export const external: AnnotationType<boolean> = Annotation.define<boolean>();

/** Swapped without rebuilding the editor. Module-level: a compartment is an identity token, and
 *  one per mount would make a restored state's compartments unreachable from the next mount. */
export const languageSlot = new Compartment();
export const markerSlot = new Compartment();

export function languageFor(lang: Lang): Extension {
  if (lang === "yaml") return yaml();
  if (lang === "json") return json();
  // Not markdown(): it embeds HTML, CSS and JavaScript (≈65 kB gzip more, spec §12.1).
  return [new LanguageSupport(markdownLanguage), EditorView.lineWrapping];
}

class LineDiagMarker extends GutterMarker {
  constructor(readonly severity: "error" | "warning") {
    super();
    this.elementClass = `cm-lineDiag cm-lineDiag-${severity}`;
  }
  eq(other: GutterMarker) {
    return other instanceof LineDiagMarker && other.severity === this.severity;
  }
}
const errorMark = new LineDiagMarker("error");
const warningMark = new LineDiagMarker("warning");

/** Phones drop the lint gutter (~16px); a line with a diagnostic marks its line number instead.
 *  Markers carry only a class, so the number still renders. Module-level, so a restored state keeps it. */
const lineDiagField = StateField.define<RangeSet<GutterMarker>>({
  create: () => RangeSet.empty,
  update(marks, tr) {
    for (const e of tr.effects) {
      if (!e.is(setDiagnosticsEffect)) continue;
      const worst = new Map<number, "error" | "warning">();
      for (const d of e.value) {
        if (d.severity !== "error" && d.severity !== "warning") continue;
        const at = tr.newDoc.lineAt(d.from).from;
        if (worst.get(at) !== "error") worst.set(at, d.severity);
      }
      return RangeSet.of(
        [...worst].map(([at, s]) => (s === "error" ? errorMark : warningMark).range(at)),
        true,
      );
    }
    return tr.docChanged ? marks.map(tr.changes) : marks;
  },
});
const lineNumberDiagMarks: Extension = [lineDiagField, lineNumberMarkers.from(lineDiagField)];

export function markersFor(mobile: boolean): Extension {
  return mobile ? lineNumberDiagMarks : lintGutter({ hoverTime: 400 });
}

const highlight = HighlightStyle.define([
  {
    tag: [t.keyword, t.bool, t.null, t.atom, t.operatorKeyword, t.modifier],
    color: "var(--syntax-keyword)",
  },
  { tag: [t.string, t.special(t.string), t.regexp], color: "var(--syntax-string)" },
  { tag: [t.number, t.integer, t.float], color: "var(--syntax-number)" },
  { tag: [t.comment, t.lineComment, t.blockComment, t.meta], color: "var(--syntax-comment)" },
  {
    tag: [t.propertyName, t.definition(t.propertyName), t.attributeName, t.labelName],
    color: "var(--syntax-property)",
  },
  {
    tag: [t.punctuation, t.separator, t.bracket, t.squareBracket, t.brace, t.processingInstruction],
    color: "var(--syntax-punctuation)",
  },
  { tag: t.heading, color: "var(--syntax-heading)", fontWeight: "600" },
  { tag: [t.link, t.url], color: "var(--syntax-link)", textDecoration: "underline" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strong, fontWeight: "600" },
  { tag: t.monospace, color: "var(--syntax-string)" },
  { tag: t.invalid, textDecoration: "underline wavy var(--destructive)" },
]);

const selection = "color-mix(in oklch, var(--signal) 26%, transparent)";

const theme = EditorView.theme({
  "&": { backgroundColor: "var(--code-bg)", color: "var(--foreground)", minHeight: "20rem" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--font-mono)" },
  ".cm-content": {
    fontFamily: "var(--font-mono)",
    fontSize: "13px",
    lineHeight: "20px",
    padding: "12px 0",
    caretColor: "var(--signal)",
  },
  ".cm-line": { padding: "0 12px 0 8px" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--signal)", borderLeftWidth: "2px" },
  ".cm-selectionBackground, ::selection": { backgroundColor: selection },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground": {
    backgroundColor: selection,
  },
  "&.cm-focused .cm-content ::selection": { backgroundColor: selection },
  ".cm-gutters": {
    backgroundColor: "var(--code-bg)",
    color: "var(--muted-foreground)",
    border: "none",
    borderRight: "1px solid var(--code-border)",
    fontFamily: "var(--font-mono)",
  },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 6px 0 10px" },
  ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": {
    backgroundColor: "transparent",
    outline: "1px solid var(--code-border)",
  },
  ".cm-nonmatchingBracket, &.cm-focused .cm-nonmatchingBracket": {
    backgroundColor: "transparent",
    outline: "1px solid var(--destructive)",
  },
  // Colour and shape: an error's number is bold with a solid underline, a warning's a dotted one.
  ".cm-lineDiag": { textDecorationThickness: "2px", textUnderlineOffset: "3px" },
  ".cm-lineDiag-error": {
    color: "var(--destructive)",
    fontWeight: "600",
    textDecorationLine: "underline",
    textDecorationStyle: "solid",
  },
  ".cm-lineDiag-warning": {
    color: "var(--warning)",
    textDecorationLine: "underline",
    textDecorationStyle: "dotted",
  },
  ".cm-tooltip": {
    backgroundColor: "var(--popover)",
    color: "var(--popover-foreground)",
    border: "1px solid var(--border)",
    borderRadius: "6px",
  },
});

type Options = {
  onSave(): void;
  onChange(doc: string): void;
  onBlur(): void;
  ids: { id: string; labelledBy: string; describedBy: string };
  mobile: boolean;
};

/** The whole editor configuration. The handlers are called as given, so callers pass stable functions
 *  that read their latest props (the view is never rebuilt for a new callback). */
export function extensionsFor(lang: Lang, o: Options): Extension[] {
  return [
    lineNumbers(),
    history(),
    drawSelection(),
    bracketMatching(),
    indentOnInput(),
    languageSlot.of(languageFor(lang)),
    syntaxHighlighting(highlight),
    keymap.of([
      ...defaultKeymap,
      ...historyKeymap,
      ...lintKeymap,
      indentWithTab,
      {
        key: "Mod-s",
        preventDefault: true,
        run: () => {
          o.onSave();
          return true;
        },
      },
    ]),
    markerSlot.of(markersFor(o.mobile)),
    EditorView.contentAttributes.of({
      id: o.ids.id,
      "aria-labelledby": o.ids.labelledBy,
      "aria-describedby": o.ids.describedBy,
      "aria-multiline": "true",
      spellcheck: "false",
    }),
    EditorView.updateListener.of((u) => {
      if (u.docChanged && !u.transactions.every((tr) => tr.annotation(external)))
        o.onChange(u.state.doc.toString());
    }),
    EditorView.domEventHandlers({
      blur: () => {
        o.onBlur();
      },
    }),
    theme,
  ];
}
