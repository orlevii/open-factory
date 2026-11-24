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
import {
  type Diagnostic,
  lintGutter,
  nextDiagnostic,
  previousDiagnostic,
  setDiagnosticsEffect,
} from "@codemirror/lint";
import {
  Compartment,
  EditorState,
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

/** Swapped without rebuilding the editor. Module-level: a compartment is an identity token, and
 *  one per mount would make a restored state's compartments unreachable from the next mount. */
export const languageSlot = new Compartment();
export const markerSlot = new Compartment();
export const attrsSlot = new Compartment();
export const readOnlySlot = new Compartment();
export const marginSlot = new Compartment();

/** A read-only view (the Configuration page's Combined JSON): no edits, still focusable, selectable and announced as
 *  read-only. Reconfigured in place, never a remount, so the view keeps its scroll and selection. */
export function readOnlyFor(readOnly: boolean): Extension {
  return readOnly
    ? [EditorState.readOnly.of(true), EditorView.contentAttributes.of({ "aria-readonly": "true" })]
    : [];
}

/** Keeps the cursor clear of a sticky footer over the editor's bottom edge (`scrollMargins.bottom`). */
export function marginsFor(bottom: number): Extension {
  return bottom > 0 ? EditorView.scrollMargins.of(() => ({ bottom })) : [];
}

type EditorIds = { id: string; labelledBy: string; describedBy: string };

/** The content element's id and ARIA wiring; in a compartment, so a description that arrives after
 *  mount (the template editor's warm hint) reaches the screen reader. */
export function attrsFor(ids: EditorIds): Extension {
  return EditorView.contentAttributes.of({
    id: ids.id,
    "aria-labelledby": ids.labelledBy,
    "aria-describedby": ids.describedBy,
    "aria-multiline": "true",
    spellcheck: "false",
  });
}

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

const mask = (shape: string) =>
  `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40">${shape}</svg>`)}")`;
const circleMask = mask('<circle cx="20" cy="20" r="16"/>');
const triangleMask = mask('<path d="M20 4L38 36L2 36Z"/>');
const squareMask = mask('<path d="M6 6H34V34H6Z"/>');

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
  // @codemirror/lint's own colours (orange warnings, light-only fills) replaced with tokens. Its gutter
  // marks are data-URI SVGs, which can't read CSS variables, so the shapes become masks over a token fill.
  ".cm-lintRange, .cm-lintRange-error, .cm-lintRange-warning, .cm-lintRange-info, .cm-lintRange-hint":
    {
      backgroundImage: "none",
      paddingBottom: "0",
      textDecorationLine: "underline",
      textDecorationStyle: "wavy",
      textDecorationThickness: "1px",
      textUnderlineOffset: "3px",
      textDecorationSkipInk: "none",
    },
  ".cm-lintRange-error": { textDecorationColor: "var(--destructive)" },
  ".cm-lintRange-warning": { textDecorationColor: "var(--warning)" },
  ".cm-lintRange-info, .cm-lintRange-hint": { textDecorationColor: "var(--muted-foreground)" },
  ".cm-lintRange-active": {
    backgroundColor: "color-mix(in oklch, var(--muted-foreground) 18%, transparent)",
  },
  ".cm-lintPoint:after": { borderBottomColor: "var(--destructive)" },
  ".cm-lintPoint-warning:after": { borderBottomColor: "var(--warning)" },
  ".cm-lintPoint-info:after, .cm-lintPoint-hint:after": {
    borderBottomColor: "var(--muted-foreground)",
  },
  ".cm-diagnostic": { fontFamily: "var(--font-sans)", fontSize: "13px", lineHeight: "18px" },
  ".cm-diagnostic-error": { borderLeft: "3px solid var(--destructive)" },
  ".cm-diagnostic-warning": { borderLeft: "3px solid var(--warning)" },
  ".cm-diagnostic-info, .cm-diagnostic-hint": { borderLeft: "3px solid var(--muted-foreground)" },
  ".cm-lint-marker, .cm-lint-marker-error, .cm-lint-marker-warning, .cm-lint-marker-info": {
    content: "normal",
    maskRepeat: "no-repeat",
    maskPosition: "center",
    maskSize: "contain",
    WebkitMaskRepeat: "no-repeat",
    WebkitMaskPosition: "center",
    WebkitMaskSize: "contain",
  },
  // Shape as well as colour: an error is a circle, a warning a triangle, anything else a square.
  ".cm-lint-marker-error": {
    backgroundColor: "var(--destructive)",
    maskImage: circleMask,
    WebkitMaskImage: circleMask,
  },
  ".cm-lint-marker-warning": {
    backgroundColor: "var(--warning)",
    maskImage: triangleMask,
    WebkitMaskImage: triangleMask,
  },
  ".cm-lint-marker-info": {
    backgroundColor: "var(--muted-foreground)",
    maskImage: squareMask,
    WebkitMaskImage: squareMask,
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
  ids: EditorIds;
  mobile: boolean;
  readOnly: boolean;
  scrollMarginBottom: number;
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
      // Only next/previous diagnostic: lint's panel (Mod-Shift-m) isn't themed or wanted here.
      { key: "F8", run: nextDiagnostic, shift: previousDiagnostic },
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
    attrsSlot.of(attrsFor(o.ids)),
    readOnlySlot.of(readOnlyFor(o.readOnly)),
    marginSlot.of(marginsFor(o.scrollMarginBottom)),
    EditorView.updateListener.of((u) => {
      if (u.docChanged) o.onChange(u.state.doc.toString());
    }),
    EditorView.domEventHandlers({
      blur: () => {
        o.onBlur();
      },
    }),
    theme,
  ];
}
