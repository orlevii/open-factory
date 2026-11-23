import { SlidersHorizontal } from "lucide-react";
import { useRef, useState } from "react";

/** More lines than this get a Show all: the clamp itself is CSS, so nothing is measured in JS. */
const SHOWN = 2;

/**
 * "Configuration changed by @orlevi · 3 changes" (I2 §7.3): the change lines are the secret-safe ones the server wrote
 * (names and kinds, never an env, MCP or header value). The list is two muted lines until Show all, whatever the
 * width, and breaks anywhere so one long name can't widen the row.
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
  const root = useRef<HTMLDivElement>(null);
  const n = changes.length;
  const clamped = !all && n > SHOWN;
  return (
    <div
      {...rowProps}
      ref={root}
      tabIndex={-1}
      className="text-[0.8125rem] leading-[1.125rem] text-muted-foreground"
    >
      <p className="flex items-center gap-1.5 [&_svg]:size-3.5 [&_svg]:shrink-0">
        <SlidersHorizontal aria-hidden="true" />
        <span className="min-w-0 [overflow-wrap:anywhere]">
          Configuration changed by {by} · {n} {n === 1 ? "change" : "changes"}
        </span>
      </p>
      {n > 0 &&
        (clamped ? (
          <p data-changes className="line-clamp-2 pl-5 [overflow-wrap:anywhere]">
            {changes.join(" · ")}
          </p>
        ) : (
          <ul data-changes className="pl-5 [overflow-wrap:anywhere]">
            {changes.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        ))}
      {clamped && (
        <button
          type="button"
          onClick={() => {
            root.current?.focus(); // the button is about to unmount
            setAll(true);
          }}
          className="mt-0.5 ml-5 text-muted-foreground underline-offset-4 hover:underline"
        >
          Show all
        </button>
      )}
    </div>
  );
}
