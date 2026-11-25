import { ROW_GRID } from "@/components/row-grid";

/** A muted line. `inRows`: on the inbox rows' grid, its text aligned with theirs. */
export function EmptyState({ text, inRows }: { text: string; inRows?: boolean }) {
  return inRows ? (
    <p className={`grid ${ROW_GRID} text-muted-foreground text-sm`}>
      <span className="col-start-2">{text}</span>
    </p>
  ) : (
    <p className="text-muted-foreground text-sm">{text}</p>
  );
}
