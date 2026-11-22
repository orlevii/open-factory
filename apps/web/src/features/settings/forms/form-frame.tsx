import type { FormEvent, ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { SheetBody, SheetFooter } from "@/components/ui/sheet";
import { Spinner } from "@/components/ui/spinner";
import { InlineForm, smallClass } from "@/features/settings/shared";

export type FormFrameKind = "inline" | "sheet";

/**
 * The one chrome the Settings add forms share: `inline` is Settings' own `InlineForm`; `sheet` is the body of a
 * `Sheet` (fields, then a footer with the primary submit and a ghost Close that calls `onCancel`). Submit only sets
 * `aria-disabled` while pending, so `onSubmit` is ignored here while `pending`.
 */
export function FormFrame({
  frame,
  label,
  onSubmit,
  onCancel,
  submitLabel,
  pendingLabel,
  pending,
  formError,
  autoFocusId,
  reveal,
  left,
  children,
}: {
  frame: FormFrameKind;
  label: string;
  onSubmit(): void;
  onCancel(): void;
  submitLabel: string;
  pendingLabel: string;
  pending: boolean;
  formError?: string;
  autoFocusId?: string;
  reveal?: boolean;
  /** Sheet frame only: a quiet note at the footer's left ("Draft restored · Discard"). */
  left?: ReactNode;
  children: ReactNode;
}) {
  if (frame === "inline") {
    return (
      <InlineForm
        label={label}
        onSubmit={onSubmit}
        onCancel={onCancel}
        submitLabel={submitLabel}
        pendingLabel={pendingLabel}
        pending={pending}
        formError={formError}
        autoFocusId={autoFocusId}
        reveal={reveal}
      >
        {children}
      </InlineForm>
    );
  }
  return (
    <form
      aria-label={label}
      noValidate
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        if (!pending) onSubmit();
      }}
      className="flex min-h-0 flex-1 flex-col"
    >
      <SheetBody className="grid content-start gap-4">
        {children}
        <div role="alert" className={`${smallClass} text-destructive empty:hidden`}>
          {formError}
        </div>
        <span role="status" className="sr-only">
          {pending ? pendingLabel : ""}
        </span>
      </SheetBody>
      <SheetFooter>
        {left && (
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 text-[0.8125rem] text-muted-foreground @sm:mr-auto">
            {left}
          </div>
        )}
        <Button type="button" variant="ghost" onClick={onCancel}>
          Close
        </Button>
        <Button type="submit" aria-disabled={pending || undefined}>
          {pending && <Spinner />}
          {pending ? pendingLabel : submitLabel}
        </Button>
      </SheetFooter>
    </form>
  );
}
