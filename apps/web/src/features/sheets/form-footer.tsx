import { type ReactNode, useId } from "react";
import { FormOutcome, type Outcome, showsNotice } from "@/components/forms/form-outcome";
import { Button } from "@/components/ui/button";
import { SheetClose, SheetFooter, useSheetMobile } from "@/components/ui/sheet";
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
  submitClassName,
  outcome,
}: {
  submitLabel: string;
  pendingLabel: string;
  pending: boolean;
  restored: boolean;
  onDiscard(): void;
  left?: ReactNode;
  /** e.g. a min width that fits the pending label, so the button doesn't change width while pending. */
  submitClassName?: string;
  /** The reserved line above the buttons: errors, success and a muted notice that describes the submit button. */
  outcome: Outcome;
}) {
  const noticeId = useId();
  const mobile = useSheetMobile();
  const aside = (left || restored) && (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 text-[0.8125rem] text-muted-foreground sm:mr-auto">
      {left}
      {restored && (
        <span className="inline-flex items-center gap-2">
          Draft restored <span>·</span>{" "}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            inForm
            className="-ml-1 px-1"
            data-skip-validate
            onClick={onDiscard}
          >
            Discard
          </Button>
        </span>
      )}
    </div>
  );
  const line = (
    <FormOutcome
      outcome={outcome}
      pending={pending ? pendingLabel : undefined}
      noticeId={noticeId}
      className="basis-full -mb-1"
    />
  );
  const close = (
    <SheetClose asChild>
      {/* Closing doesn't count as leaving a field (DESIGN.md Validation). */}
      <Button type="button" variant="ghost" data-skip-validate>
        Close
      </Button>
    </SheetClose>
  );
  const submit = (
    <Button
      type="submit"
      aria-disabled={pending || undefined}
      aria-describedby={showsNotice(outcome) ? noticeId : undefined}
      className={submitClassName}
    >
      {pending && <Spinner />}
      {pending ? pendingLabel : submitLabel}
    </Button>
  );
  // A phone drawer stacks full width: the action first, Close last at the bottom (DESIGN.md Overlays). DOM order
  // follows, so Tab order matches what is seen.
  return mobile ? (
    <SheetFooter className="pt-2">
      {line}
      {submit}
      {aside}
      {close}
    </SheetFooter>
  ) : (
    <SheetFooter className="pt-2">
      {line}
      {aside}
      {close}
      {submit}
    </SheetFooter>
  );
}
