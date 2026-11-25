import { CircleAlert } from "lucide-react";
import { ROW_GRID } from "@/components/row-grid";
import { Button } from "@/components/ui/button";

/** S6's crimson one-line failure with a Retry button (inbox, tasks). `inRows`: on the inbox rows' grid,
 *  the icon in the dot column and the text aligned with the rows' text. */
export function ErrorLine({
  text,
  onRetry,
  autoFocus,
  inRows,
}: {
  text: string;
  onRetry(): void;
  autoFocus?: boolean;
  inRows?: boolean;
}) {
  const retry = (
    <Button variant="ghost" size="sm" onClick={onRetry} autoFocus={autoFocus}>
      Retry
    </Button>
  );
  if (inRows)
    return (
      <div className={`grid ${ROW_GRID} items-center text-sm`}>
        <CircleAlert
          aria-hidden="true"
          className="size-3.5 shrink-0 justify-self-center text-destructive"
        />
        <div className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 text-destructive">{text}</span>
          {retry}
        </div>
      </div>
    );
  return (
    <div className="flex items-center gap-2 text-sm">
      <CircleAlert aria-hidden="true" className="size-4 shrink-0 text-destructive" />
      <span className="min-w-0 text-destructive">{text}</span>
      {retry}
    </div>
  );
}
