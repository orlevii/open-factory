import { ApiError } from "@open-factory/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { UntrustedCode, UntrustedProse } from "@/components/untrusted-text";
import type { skillFileQueryOptions } from "@/lib/library";

/** One file's text query: a skill's or a plugin's (the same `{ path, text }` shape). */
export type FileQuery = ReturnType<typeof skillFileQueryOptions>;

const CUT_BYTES = 256 * 1024;
/** The server cuts SKILL.md to 256 KB on a character boundary, so a text within 3 bytes of the cap was cut. */
const wasCut = (text: string) => new TextEncoder().encode(text).length > CUT_BYTES - 4;

/**
 * One file of a skill: its path, a "Runs code" mark for an executable, and one View file toggle. The toggle's label
 * flips to Hide file, so focus never moves. The text opens from its first line, in a plate with a rule, clamped at 40
 * lines. It is fetched only while open (`enabled: open`), warmed on pointer-enter or focus of the toggle, and drawn with
 * `UntrustedCode`, never an editor. `SKILL.md` is already in the detail (`inlineText`), so it never fetches.
 */
export function FileView({
  path,
  executable,
  options,
  inlineText,
}: {
  path: string;
  executable: boolean;
  /** The file's query: a pinned file's never refetches (its `staleTime`). */
  options: FileQuery;
  /** Text already in hand (`SKILL.md` is in the skill's detail), so the file never fetches. */
  inlineText?: string;
}) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const pathId = useId();
  const q = useQuery({ ...options, enabled: open && inlineText === undefined });
  const text = inlineText ?? q.data?.text;
  const warm = () => {
    if (inlineText === undefined) void qc.prefetchQuery(options);
  };
  return (
    <li className="py-1">
      <div className="flex min-h-7 items-center gap-2">
        <span
          id={pathId}
          className="min-w-0 flex-1 font-mono text-[0.8125rem] [overflow-wrap:anywhere]"
        >
          <UntrustedProse text={path} />
        </span>
        {executable && <span className="text-xs text-muted-foreground">Runs code</span>}
        <Button
          variant="ghost"
          size="xs"
          aria-expanded={open}
          aria-controls={open ? bodyId : undefined}
          aria-describedby={pathId}
          onClick={() => setOpen((o) => !o)}
          onPointerEnter={warm}
          onFocus={warm}
        >
          {open ? "Hide file" : "View file"}
        </Button>
      </div>
      {open && (
        <div id={bodyId} className="mt-1 rounded-md border border-border bg-card p-2">
          {text !== undefined ? (
            <>
              <UntrustedCode text={text} fromTop />
              {wasCut(text) && <p className="mt-1 text-xs text-muted-foreground">Cut at 256 KB.</p>}
            </>
          ) : q.isError ? (
            <p role="alert" className="text-[0.8125rem] text-destructive">
              {q.error instanceof ApiError ? q.error.message : "Couldn't load the file."}
            </p>
          ) : (
            <p className="text-[0.8125rem] text-muted-foreground">Loading…</p>
          )}
        </div>
      )}
    </li>
  );
}
