import { TEMPLATE_FILES, type TemplateIssue } from "@open-factory/shared";
import { CircleAlert, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/utils";

const EDITABLE = new Set<string>(TEMPLATE_FILES);

/** Errors first, then warnings, each group in the order the server returned them. */
export const sortIssues = (issues: TemplateIssue[]) => [
  ...issues.filter((i) => i.severity === "error"),
  ...issues.filter((i) => i.severity === "warning"),
];

export function IssueIcon({ severity }: { severity: TemplateIssue["severity"] }) {
  return severity === "error" ? (
    <CircleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-destructive" />
  ) : (
    <TriangleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-warning" />
  );
}

/** One line per issue: icon, file, line:col, message. An issue in an editable file with a line
 *  is a button that jumps to it; everything else is plain text. `showFile` is off under an
 *  editor, where the file is already the context. */
export function IssueList({
  issues,
  onJump,
  showFile = true,
}: {
  issues: TemplateIssue[];
  onJump?(file: TemplateIssue["file"], line: number): void;
  showFile?: boolean;
}) {
  if (issues.length === 0) return null;
  return (
    <ul className="grid gap-1">
      {sortIssues(issues).map((i, n) => {
        const pos = i.line ? `${i.line}:${i.column ?? 1}` : undefined;
        const body = (
          <>
            <IssueIcon severity={i.severity} />
            <span className="sr-only">{i.severity === "error" ? "Error" : "Warning"}</span>
            {showFile && <span className="font-mono text-[0.8125rem]">{i.file}</span>}
            {pos && <span className="font-mono text-[0.8125rem] text-muted-foreground">{pos}</span>}
            <span>{i.message}</span>
          </>
        );
        const row = "flex flex-wrap items-start gap-x-2 text-left text-sm leading-5";
        const jumpable = EDITABLE.has(i.file) && i.line !== undefined && onJump;
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: a list that is replaced as a whole
          <li key={n}>
            {jumpable ? (
              <button
                type="button"
                // The name is "<file> <line>:<col> <message>" even when the file is hidden.
                aria-label={`${i.severity === "error" ? "Error" : "Warning"}: ${i.file} ${pos} ${i.message}`}
                onClick={() => onJump(i.file, i.line as number)}
                className={cn(
                  row,
                  "-mx-1.5 w-[calc(100%+0.75rem)] rounded-md px-1.5 py-0.5 hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
                )}
              >
                {body}
              </button>
            ) : (
              <div className={row}>{body}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
