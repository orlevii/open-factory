import { ChevronRight } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { IN_FORM } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * A disclosure for a form's rarely needed fields. `open` is the parent's (derived) state. The chevron turns only
 * when its own button is clicked (DESIGN.md); when `open` becomes true from outside it is set `data-instant`, so
 * nothing animates. `reason` says why it opened itself.
 */
export function MoreOptions({
  open,
  onOpenChange,
  reason,
  children,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  reason?: ReactNode;
  children: ReactNode;
}) {
  const id = useId();
  const [clicked, setClicked] = useState(false);
  return (
    <div className="grid gap-4">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 text-[0.8125rem]">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={open ? id : undefined}
          onClick={() => {
            setClicked(true);
            onOpenChange(!open);
          }}
          className={cn(
            "inline-flex h-7 items-center gap-1 rounded-md px-1 font-medium text-foreground hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring",
            IN_FORM,
          )}
        >
          <ChevronRight
            aria-hidden="true"
            data-slot="more-options-chevron"
            data-instant={open && !clicked ? "" : undefined}
            className={cn(
              "size-4",
              clicked && "transition-transform duration-150",
              open && "rotate-90",
            )}
          />
          More options
        </button>
        {reason && <span className="text-muted-foreground">{reason}</span>}
      </div>
      {open && (
        <div id={id} className="grid gap-5">
          {children}
        </div>
      )}
    </div>
  );
}
