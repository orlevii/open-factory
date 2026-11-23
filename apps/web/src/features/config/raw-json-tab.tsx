import type { EditorState } from "@codemirror/state";
import type { TemplateIssue } from "@open-factory/shared";
import { type Ref, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/segmented-control";
import type { CodeEditorHandle } from "@/features/templates/code-editor";
import type { Diag } from "@/features/templates/code-editor-setup";
import { CodeSurface } from "@/features/templates/code-surface";
import { jsonPathToLine } from "./json-path-line";
import { CONFIG_FIELD_MSG, CONFIG_PAGE_COPY, CONFIG_PAGE_MSG } from "./messages";

export type RawView = "agent" | "combined";
/** Where JSON.parse gave up, 1-based. */
export type ParseError = { line: number; column?: number };

export const RAW_EDITOR_ID = "raw-json-editor";
const NO_DIAGS: Diag[] = [];
const VIEWS = [
  { value: "agent" as const, label: CONFIG_PAGE_COPY.viewAgent },
  { value: "combined" as const, label: CONFIG_PAGE_COPY.viewCombined },
];

/** The fileKey of a raw editor's state in the page's map: `agent:<slug>`, and its read-only Combined view. */
export const rawFileKey = (slug: string, view: RawView) =>
  view === "agent" ? `agent:${slug}` : `agent:${slug}:combined`;

/**
 * The Raw JSON tab (spec §12.4): this agent's overlay as JSON in the shared code surface, or the read-only Combined
 * view (template plus overlay, references only). The text, its parse state and the editor states belong to the page,
 * so they outlive this tab. Markers come from the server's issues (by path), rebase conflicts and the parse error.
 * Values only ever appear in the editor: every marker message is a constant.
 */
export function RawJsonTab(p: {
  slug: string;
  labelledBy: string;
  text: string;
  onTextChange(v: string): void;
  parseError: ParseError | null;
  issues: readonly TemplateIssue[];
  conflicts: readonly string[];
  view: RawView;
  onViewChange(v: RawView): void;
  /** Null while the template is broken: there is nothing to combine with. */
  combinedText: string | null;
  states: Map<string, EditorState>;
  editorRef: Ref<CodeEditorHandle>;
  textareaRef: Ref<HTMLTextAreaElement>;
  /** Refused switches since the JSON broke: from the first, the note says why, and each one is announced again. */
  refusals: number;
  onRevert(): void;
  onSave(): void;
  scrollMarginBottom: number;
}) {
  const { text, issues, conflicts, parseError, view } = p;
  const diagnostics = useMemo((): Diag[] => {
    if (view === "combined") return NO_DIAGS;
    const out: Diag[] = [];
    for (const i of issues)
      out.push({
        line: (i.path ? jsonPathToLine(text, i.path) : undefined) ?? 1,
        message: i.message,
        severity: i.severity,
      });
    for (const path of conflicts)
      out.push({
        line: jsonPathToLine(text, path) ?? 1,
        message: CONFIG_FIELD_MSG.alsoChanged,
        severity: "warning",
      });
    if (parseError)
      out.push({
        line: parseError.line,
        column: parseError.column,
        message: CONFIG_PAGE_MSG.invalidJson,
        severity: "error",
      });
    return out.length ? out.sort((a, b) => a.line - b.line) : NO_DIAGS;
  }, [text, issues, conflicts, parseError, view]);

  const combined = view === "combined";
  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3">
      <SegmentedControl
        legend={CONFIG_PAGE_COPY.viewLegend}
        name="raw-view"
        size="sm"
        value={view}
        options={VIEWS}
        onChange={p.onViewChange}
      />
      {parseError ? (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.8125rem] leading-[1.125rem]">
          {/* Always mounted while the JSON is broken, so each refused switch is announced. */}
          <p role="status" aria-live="polite" className="text-destructive">
            {p.refusals > 0 ? (
              <span key={p.refusals}>{CONFIG_PAGE_MSG.fixJsonToSwitch}</span>
            ) : null}
          </p>
          <Button type="button" variant="ghost" size="xs" onClick={p.onRevert}>
            {CONFIG_PAGE_COPY.revertRaw}
          </Button>
        </div>
      ) : null}
      {combined && p.combinedText === null ? (
        <p className="text-sm text-muted-foreground">{CONFIG_PAGE_COPY.noCombined}</p>
      ) : (
        <CodeSurface
          id={RAW_EDITOR_ID}
          label={CONFIG_PAGE_COPY.tabRaw}
          labelledBy={p.labelledBy}
          language="json"
          value={combined ? (p.combinedText ?? "") : text}
          onChange={combined ? ignore : p.onTextChange}
          onSave={p.onSave}
          fileKey={rawFileKey(p.slug, view)}
          states={p.states}
          diagnostics={diagnostics}
          readOnly={combined}
          scrollMarginBottom={p.scrollMarginBottom}
          editorRef={p.editorRef}
          textareaRef={p.textareaRef}
        />
      )}
    </div>
  );
}

const ignore = () => {};

const LINE_COLUMN = /line (\d+) column (\d+)/;
const POSITION = /position (\d+)/;

/** Where `JSON.parse` stopped, from its error (V8 names a position, newer versions a line and column too); the end
 *  of the text when it names neither ("Unexpected end of JSON input"). The message itself is never shown. */
export function parseErrorAt(text: string, e: unknown): ParseError {
  const message = e instanceof Error ? e.message : "";
  const lc = LINE_COLUMN.exec(message);
  if (lc) return { line: Number(lc[1]), column: Number(lc[2]) };
  const pos = POSITION.exec(message);
  const at = pos ? Math.min(Number(pos[1]), text.length) : text.length;
  let line = 1;
  let column = 1;
  for (let i = 0; i < at; i++) {
    if (text[i] === "\n") {
      line++;
      column = 1;
    } else column++;
  }
  return { line, column };
}
