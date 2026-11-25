import {
  type FormEvent,
  type ReactNode,
  type Ref,
  useCallback,
  useEffect,
  useId,
  useRef,
} from "react";
import { FormOutcome, type Outcome, showsNotice } from "@/components/forms/form-outcome";
import { Button } from "@/components/ui/button";
import { SheetBody, SheetFooter } from "@/components/ui/sheet";
import { Spinner } from "@/components/ui/spinner";
import { InlineForm } from "@/features/settings/shared";
import { isMobileNow } from "@/hooks/use-mobile";

export type FormFrameKind = "inline" | "sheet";

/** What only the sheet frame has. The inline variant forbids them, so a caller can't pass one and have it ignored. */
type SheetOnly = {
  /** The primary is `aria-disabled` (it stays focusable) and a submit does nothing (Add at 0 picks, the 300 ms after a
   *  Find lands). */
  submitDisabled?: boolean;
  /** E.g. a min width and tabular numbers, so the primary doesn't change width with its label. */
  submitClassName?: string;
  /** Shown after the pending label (an elapsed clock). */
  pendingExtra?: ReactNode;
};
type InlineOnly = { [K in keyof SheetOnly]?: never };

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
  submitDisabled = false,
  submitClassName,
  pendingExtra,
  outcome,
  autoFocusId,
  autoFocus = true,
  reveal,
  left,
  ref,
  children,
}: {
  label: string;
  onSubmit(): void;
  onCancel(): void;
  submitLabel: string;
  pendingLabel: string;
  pending: boolean;
  outcome: Outcome;
  ref?: Ref<HTMLFormElement>;
  autoFocusId?: string;
  /** False: no focus on mount (a restored sign-in moves focus itself, spec §8.2). */
  autoFocus?: boolean;
  reveal?: boolean;
  /** Sheet frame only: a quiet note at the footer's left ("Draft restored · Discard"). */
  left?: ReactNode;
  children: ReactNode;
} & (({ frame: "inline" } & InlineOnly) | ({ frame: "sheet" } & SheetOnly))) {
  const noticeId = useId();
  // Sheet frame: focus on open is the body's job (the host prevents Radix's). Phones focus the drawer content, so the
  // keyboard doesn't rise mid-slide; desktop the field a prefilled form names, else its first field.
  // (`reveal` only scrolls an inline form into view, which a sheet doesn't need.)
  const form = useRef<HTMLFormElement | null>(null);
  // One ref callback sets the internal ref and the caller's, for the sheet's own <form> and (via InlineForm) the inline one.
  const setForm = useCallback(
    (el: HTMLFormElement | null) => {
      form.current = el;
      if (typeof ref === "function") return ref(el);
      if (ref) ref.current = el;
    },
    [ref],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: focus once, when the form opens
  useEffect(() => {
    if (frame !== "sheet" || !autoFocus) return;
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
        ref={setForm}
        autoFocusId={autoFocusId}
        autoFocus={autoFocus}
        reveal={reveal}
      >
        {children}
      </InlineForm>
    );
  }
  return (
    <form
      ref={setForm}
      aria-label={label}
      noValidate
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        if (!pending && !submitDisabled) onSubmit();
      }}
      className="flex min-h-0 flex-1 flex-col"
    >
      <SheetBody className="field-stack content-start">{children}</SheetBody>
      <SheetFooter className="pt-2">
        <FormOutcome
          outcome={outcome}
          noticeId={noticeId}
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
        <Button
          type="submit"
          aria-disabled={pending || submitDisabled || undefined}
          aria-describedby={submitDisabled && showsNotice(outcome) ? noticeId : undefined}
          className={submitClassName}
        >
          {pending && <Spinner />}
          {pending ? pendingLabel : submitLabel}
          {pending && pendingExtra}
        </Button>
      </SheetFooter>
    </form>
  );
}
