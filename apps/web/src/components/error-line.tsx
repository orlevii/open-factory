import { CircleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";

/** S6's crimson one-line failure with a Retry button (inbox, tasks). */
export function ErrorLine({
  text,
  onRetry,
  autoFocus,
}: {
  text: string;
  onRetry(): void;
  autoFocus?: boolean;
}) {
  return (
    <div className="flex items-center gap-2 text-sm">
      <CircleAlert aria-hidden="true" className="size-4 shrink-0 text-destructive" />
      <span className="min-w-0 text-destructive">{text}</span>
      <Button variant="ghost" size="sm" onClick={onRetry} autoFocus={autoFocus}>
        Retry
      </Button>
    </div>
  );
}
