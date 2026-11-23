import {
  type FormEvent,
  type ReactNode,
  type Ref,
  useEffect,
  useImperativeHandle,
  useRef,
} from "react";
import { FormOutcome, type Outcome } from "@/components/forms/form-outcome";
import { Button } from "@/components/ui/button";
import { SheetBody, SheetFooter } from "@/components/ui/sheet";
import { Spinner } from "@/components/ui/spinner";
import { InlineForm } from "@/features/settings/shared";
import { isMobileNow } from "@/hooks/use-mobile";

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
  outcome,
  autoFocusId,
  reveal,
  left,
  ref,
  children,
}: {
  frame: FormFrameKind;
  label: string;
  onSubmit(): void;
  onCancel(): void;
  submitLabel: string;
  pendingLabel: string;
  pending: boolean;
  outcome: Outcome;
  ref?: Ref<HTMLFormElement>;
  autoFocusId?: string;
  reveal?: boolean;
  /** Sheet frame only: a quiet note at the footer's left ("Draft restored · Discard"). */
  left?: ReactNode;
  children: ReactNode;
}) {
  // Sheet frame: focus on open is the body's job (the host prevents Radix's). Phones focus the drawer content, so the
  // keyboard doesn't rise mid-slide; desktop the field a prefilled form names, else its first field.
  // (`reveal` only scrolls an inline form into view, which a sheet doesn't need.)
  const form = useRef<HTMLFormElement>(null);
  useImperativeHandle(ref, () => form.current as HTMLFormElement);
  // biome-ignore lint/correctness/useExhaustiveDependencies: focus once, when the form opens
  useEffect(() => {
    if (frame !== "sheet") return;
    const t = setTimeout(() => {
      const el = form.current;
      if (!el) return;
      if (isMobileNow()) {
        el.closest<HTMLElement>("[data-slot=drawer-content]")?.focus();
        return;
      }
      const target =
        (autoFocusId ? document.getElementById(autoFocusId) : null) ??
        el.querySelector<HTMLElement>("input:not([type=hidden]), textarea, [role=combobox]");
      target?.focus();
    }, 0);
    return () => clearTimeout(t);
  }, []);
  if (frame === "inline") {
    return (
      <InlineForm
        label={label}
        onSubmit={onSubmit}
        onCancel={onCancel}
        submitLabel={submitLabel}
        pendingLabel={pendingLabel}
        pending={pending}
        outcome={outcome}
        ref={ref}
        autoFocusId={autoFocusId}
        reveal={reveal}
      >
        {children}
      </InlineForm>
    );
  }
  return (
    <form
      ref={form}
      aria-label={label}
      noValidate
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        if (!pending) onSubmit();
      }}
      className="flex min-h-0 flex-1 flex-col"
    >
      <SheetBody className="grid content-start gap-4">{children}</SheetBody>
      <SheetFooter className="pt-2">
        <FormOutcome
          outcome={outcome}
          pending={pending ? pendingLabel : undefined}
          className="basis-full -mb-1"
        />
        {left && (
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 text-[0.8125rem] text-muted-foreground mr-auto">
            {left}
          </div>
        )}
        <Button type="button" variant="ghost" data-skip-validate onClick={onCancel}>
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
