import { TriangleAlert } from "lucide-react";
import { contentKinds } from "./format";

type Summary = Parameters<typeof contentKinds>[0] & { needs: number };

/** How many kinds a list row shows before "+N more" (spec §10.2); a peek shows them all. */
const ROW_KINDS = 3;

/**
 * A plugin's contents as a list of items, one per kind, that wraps between kinds (spec §10.2). "Parts not shown" comes
 * first when the reader couldn't see some (a contents fact with a warning icon, not a row state). `all` is the peek's
 * form; a row keeps the first three kinds. `null` is a plugin whose contents aren't readable here.
 */
export function ContentsLine({
  summary,
  all = false,
  unreadable,
}: {
  summary: Summary | null;
  all?: boolean;
  /** What to say when there is no summary ("Contents not read yet"). */
  unreadable: string;
}) {
  if (!summary) return <span className="text-muted-foreground">{unreadable}</span>;
  const kinds = contentKinds(summary);
  const shown = all ? kinds : kinds.slice(0, ROW_KINDS);
  const more = kinds.length - shown.length;
  if (summary.unshown === 0 && kinds.length === 0)
    return <span className="text-muted-foreground">Nothing to show</span>;
  return (
    <ul className="flex min-w-0 flex-wrap gap-x-3 text-muted-foreground">
      {summary.unshown > 0 && (
        <li className="flex items-center gap-1 text-foreground">
          <TriangleAlert aria-hidden="true" className="size-3.5 shrink-0 text-warning" />
          Parts not shown
        </li>
      )}
      {shown.map((k) => (
        <li key={k}>{k}</li>
      ))}
      {more > 0 && <li>+{more} more</li>}
    </ul>
  );
}
