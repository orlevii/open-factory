import type { AnyEvent } from "@open-factory/shared";
import { ChevronRight } from "lucide-react";
import { formatTokens } from "./format";
import { CodePlate } from "./quiet-line";

/** A full-width rule with a centred label; expandable to the summary when there is one. */
export function CompactionMarker({
  event,
  rowProps,
}: {
  event: Extract<AnyEvent, { type: "compacted" }>;
  rowProps: Record<string, unknown>;
}) {
  const label = `Compacted (${event.trigger}) · ${formatTokens(event.preTokens)} → ${formatTokens(event.postTokens)} tokens`;
  const line = (
    <span className="flex items-center gap-3 text-[0.8125rem] leading-[1.125rem] text-muted-foreground">
      <span aria-hidden="true" className="h-px flex-1 bg-border" />
      {label}
      <span aria-hidden="true" className="h-px flex-1 bg-border" />
    </span>
  );
  if (!event.summary) return <div {...rowProps}>{line}</div>;
  return (
    <details className="group">
      <summary {...rowProps} className="flex cursor-pointer list-none items-center gap-1.5">
        <ChevronRight
          aria-hidden="true"
          className="size-3.5 text-muted-foreground shrink-0 transition-transform duration-150 ease-(--ease-out) group-open:rotate-90 motion-reduce:transition-none"
        />
        <span className="min-w-0 flex-1">{line}</span>
      </summary>
      <CodePlate>{event.summary}</CodePlate>
    </details>
  );
}
