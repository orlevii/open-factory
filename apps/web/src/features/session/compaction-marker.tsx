import type { AnyEvent } from "@open-factory/shared";
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
    <details>
      <summary {...rowProps} className="cursor-pointer list-none">
        {line}
      </summary>
      <CodePlate>{event.summary}</CodePlate>
    </details>
  );
}
