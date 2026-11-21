import type { LinkInput } from "@open-factory/shared";
import { CircleAlert, Plus, X } from "lucide-react";
import { useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

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
  onBlurRow(id: string): void;
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
        const errId = `${r.id}-error`;
        return (
          <div key={r.id} className="grid gap-1">
            <div className="flex flex-wrap items-center gap-2 md:flex-nowrap">
              <Select
                value={r.kind}
                onValueChange={(v) => patch(r.id, { kind: v as LinkRow["kind"] })}
                onOpenChange={(open) => {
                  kindOpen.current = open;
                }}
              >
                <SelectTrigger
                  aria-label={`Link ${i + 1} kind`}
                  onBlur={() => kindOpen.current || onBlurRow(r.id)}
                  className="w-24 shrink-0"
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
                aria-describedby={err ? errId : undefined}
                value={r.target}
                autoComplete="off"
                onChange={(e) => patch(r.id, { target: e.target.value })}
                onBlur={() => onBlurRow(r.id)}
                className="h-9 min-w-0 flex-1"
              />
              <Input
                aria-label={`Link ${i + 1} title`}
                placeholder="Title (optional)"
                value={r.title}
                autoComplete="off"
                onChange={(e) => patch(r.id, { title: e.target.value })}
                className="h-9 w-full md:w-48 max-md:order-last"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={`Remove link ${i + 1}`}
                title="Remove link"
                onClick={() => onChange(rows.filter((x) => x.id !== r.id))}
              >
                <X aria-hidden="true" />
              </Button>
            </div>
            {err && (
              <p
                id={errId}
                className="flex items-start gap-1.5 text-[0.8125rem] leading-[1.125rem] text-destructive"
              >
                <CircleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
                {err}
              </p>
            )}
          </div>
        );
      })}
      <div>
        <Button type="button" variant="outline" onClick={() => onChange([...rows, newLinkRow()])}>
          <Plus aria-hidden="true" data-icon="inline-start" />
          Add link
        </Button>
      </div>
    </fieldset>
  );
}
