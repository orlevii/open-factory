import { SlidersHorizontal } from "lucide-react";
import { useState } from "react";
import { InlineMentions } from "@/components/mention/inline-mentions";
import { ShowAll } from "./message-block";

/** More lines than this get a Show all: the clamp itself is CSS, so nothing is measured in JS. */
const SHOWN = 2;

/**
 * "Configuration changed by @orlevi · 3 changes" (I2 §7.3): the change lines are the secret-safe ones the server wrote
 * (names and kinds, never an env, MCP or header value). The list is two muted lines until Show all, whatever the
 * width, and breaks anywhere so one long name can't widen the row. Only the clamp class toggles.
 */
export function ConfigChangedLine({
  by,
  changes,
  rowProps,
}: {
  by: string;
  changes: string[];
  rowProps?: Record<string, unknown>;
}) {
  const [all, setAll] = useState(false);
  const n = changes.length;
  const clamped = !all && n > SHOWN;
  return (
    <div {...rowProps} className="text-[0.8125rem] leading-[1.125rem] text-muted-foreground">
      <p className="flex items-center gap-1.5 [&_svg]:size-3.5 [&_svg]:shrink-0">
        <SlidersHorizontal aria-hidden="true" />
        <span className="min-w-0 [overflow-wrap:anywhere]">
          Configuration changed by <InlineMentions text={by} /> · {n}{" "}
          {n === 1 ? "change" : "changes"}
        </span>
      </p>
      {n > 0 && (
        <ul
          data-changes
          className={`pl-5 [overflow-wrap:anywhere] ${clamped ? "line-clamp-2" : ""}`}
        >
          {changes.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
      )}
      {clamped && (
        <div className="pl-5">
          <ShowAll onShow={() => setAll(true)} />
        </div>
      )}
    </div>
  );
}
