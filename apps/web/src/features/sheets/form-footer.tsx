import { type ReactNode, useId } from "react";
import { Button } from "@/components/ui/button";
import { SheetClose, SheetFooter } from "@/components/ui/sheet";
import { Spinner } from "@/components/ui/spinner";

/** Submit only sets `aria-disabled` while pending (it stays focusable), so the body's submit handler must itself
 *  ignore a second submit while `pending`. Close keeps the draft (never "Cancel"). A restored draft is announced quietly, with Discard beside it. */
export function SheetFormFooter({
  submitLabel,
  pendingLabel,
  pending,
  restored,
  onDiscard,
  left,
  note,
  submitClassName,
  above,
}: {
  submitLabel: string;
  pendingLabel: string;
  pending: boolean;
  restored: boolean;
  onDiscard(): void;
  left?: ReactNode;
  note?: ReactNode;
  /** e.g. a min width that fits the pending label, so the button doesn't change width while pending. */
  submitClassName?: string;
  /** A muted line on its own row above the buttons (Edit agent's restart notice). It describes the submit button, so
   *  it is heard there. */
  above?: ReactNode;
}) {
  const aboveId = useId();
  return (
    <SheetFooter>
      {above && (
        <p
          id={aboveId}
          className="w-full text-[0.8125rem] leading-[1.125rem] text-muted-foreground"
        >
          {above}
        </p>
      )}
      {(left || note || restored) && (
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 text-[0.8125rem] text-muted-foreground @sm:mr-auto">
          {left}
          {note}
          {restored && (
            <span className="inline-flex items-center">
              Draft restored ·
              <Button type="button" variant="ghost" size="sm" onClick={onDiscard}>
                Discard
              </Button>
            </span>
          )}
        </div>
      )}
      <SheetClose asChild>
        <Button type="button" variant="ghost">
          Close
        </Button>
      </SheetClose>
      <Button
        type="submit"
        aria-disabled={pending || undefined}
        aria-describedby={above ? aboveId : undefined}
        className={submitClassName}
      >
        {pending && <Spinner />}
        {pending ? pendingLabel : submitLabel}
      </Button>
    </SheetFooter>
  );
}
