import type { LinkInput } from "@open-factory/shared";
import { Plus, X } from "lucide-react";
import { type FocusEvent, useRef } from "react";
import { FieldNote, noteDescribedBy } from "@/components/field-note";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export type LinkRow = { id: string; kind: LinkInput["kind"]; target: string; title: string };

let n = 0;
export const newLinkRow = (o: Partial<LinkRow> = {}): LinkRow => ({
  id: `link-${++n}`,
  kind: "url",
  target: "",
  title: "",
  ...o,
});

const KINDS: [LinkInput["kind"], string][] = [
  ["url", "URL"],
  ["pr", "PR"],
  ["file", "File"],
  ["agent", "Agent"],
];

const isHttp = (s: string) => {
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
};

/** UI design §8.3's per-row checks. Blank rows are dropped (nothing to check). `knownSlugs` are the agents that exist. */
export function checkLink(
  row: LinkRow,
  knownSlugs: ReadonlySet<string> | undefined,
): string | undefined {
  const target = row.target.trim();
  if (!target) return undefined;
  if (row.kind === "url" || row.kind === "pr")
    return isHttp(target) && target.length <= 2000 ? undefined : "Links must be http(s) URLs.";
  if (row.kind === "file")
    return /[\r\n]/.test(target) || target.length > 500 ? "Keep the path on one line." : undefined;
  const slug = target.replace(/^@/, "");
  return knownSlugs && !knownSlugs.has(slug) ? `No agent @${slug}.` : undefined;
}

export const rowsToInput = (rows: LinkRow[]): LinkInput[] =>
  rows
    .filter((r) => r.target.trim())
    .map((r) => ({
      kind: r.kind,
      target: r.target.trim(),
      ...(r.title.trim() ? { title: r.title.trim() } : {}),
    })) as LinkInput[];

/**
 * Row notes (spec §8.3): while `links` is flagged, a checked row (blurred, or present at the last submit) shows its own
 * message. A links error no row explains (the server's) goes to the first row's note.
 */
export function linkRowErrors(
  rows: LinkRow[],
  knownSlugs: ReadonlySet<string> | undefined,
  checkedRows: ReadonlySet<string>,
  linksError: string | undefined,
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  if (!linksError) return out;
  let own = false;
  for (const r of rows) {
    const m = checkLink(r, knownSlugs);
    if (m) own = true;
    if (checkedRows.has(r.id)) out[r.id] = m;
  }
  if (!own && rows[0]) out[rows[0].id] = linksError;
  return out;
}

/** Rows of [kind] [target] [title] [Remove link], and "Add link". Nothing is saved until the caller saves. */
export function LinkEditor({
  rows,
  onChange,
  errors,
  onBlurRow,
}: {
  rows: LinkRow[];
  onChange(rows: LinkRow[]): void;
  /** Error sentence by row id. */
  errors: Record<string, string | undefined>;
  /** The event's `relatedTarget` tells the form whether focus left for a `data-skip-validate` control. */
  onBlurRow(id: string, e: FocusEvent): void;
}) {
  // Opening the kind list moves focus into it; that is not leaving the field, so no check until it closes.
  const kindOpen = useRef(false);
  const patch = (id: string, p: Partial<LinkRow>) =>
    onChange(rows.map((r) => (r.id === id ? { ...r, ...p } : r)));
  return (
    <fieldset className="grid min-w-0 gap-2">
      <legend className="mb-1 text-[0.8125rem] font-medium">Links</legend>
      {rows.map((r, i) => {
        const err = errors[r.id];
        return (
          <div
            key={r.id}
            className="grid grid-cols-[6rem_minmax(0,1fr)_auto] gap-x-2 [grid-template-areas:'kind_target_remove''note_note_note''title_title_title'] md:grid-cols-[6rem_minmax(0,1fr)_12rem_auto] md:[grid-template-areas:'kind_target_title_remove''note_note_note_note']"
          >
            <Select
              value={r.kind}
              onValueChange={(v) => patch(r.id, { kind: v as LinkRow["kind"] })}
              onOpenChange={(open) => {
                kindOpen.current = open;
              }}
            >
              <SelectTrigger
                aria-label={`Link ${i + 1} kind`}
                onBlur={(e) => kindOpen.current || onBlurRow(r.id, e)}
                className="w-24 shrink-0 [grid-area:kind]"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {KINDS.map(([v, l]) => (
                  <SelectItem key={v} value={v}>
                    {l}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              aria-label={`Link ${i + 1} target`}
              aria-invalid={err ? true : undefined}
              aria-describedby={noteDescribedBy(r.id, { error: err })}
              value={r.target}
              autoComplete="off"
              onChange={(e) => patch(r.id, { target: e.target.value })}
              onBlur={(e) => onBlurRow(r.id, e)}
              className="h-9 min-w-0 [grid-area:target]"
            />
            <div className="[grid-area:note]">
              <FieldNote id={r.id} error={err} />
            </div>
            <Input
              aria-label={`Link ${i + 1} title`}
              placeholder="Title (optional)"
              value={r.title}
              autoComplete="off"
              onChange={(e) => patch(r.id, { title: e.target.value })}
              className="h-9 [grid-area:title]"
            />
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove link ${i + 1}`}
                  onClick={() => onChange(rows.filter((x) => x.id !== r.id))}
                  className="[grid-area:remove]"
                >
                  <X aria-hidden="true" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Remove link</TooltipContent>
            </Tooltip>
          </div>
        );
      })}
      <div>
        <Button
          type="button"
          variant="ghost"
          data-skip-validate
          onClick={() => onChange([...rows, newLinkRow()])}
        >
          <Plus aria-hidden="true" data-icon="inline-start" />
          Add link
        </Button>
      </div>
    </fieldset>
  );
}
