import {
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  useCallback,
  useEffect,
  useId,
  useRef,
} from "react";
import { COLLAPSE_EVENT, EMBEDDED_ATTR } from "@/components/forms/embedded";
import { FormOutcome, type Outcome, showsNotice } from "@/components/forms/form-outcome";
import { Button } from "@/components/ui/button";
import { SheetBody, SheetFooter } from "@/components/ui/sheet";
import { Spinner } from "@/components/ui/spinner";
import { InlineForm } from "@/features/settings/shared";
import { isMobileNow } from "@/hooks/use-mobile";

export type FormFrameKind = "inline" | "sheet" | "embedded";

/**
 * What an inline prerequisite (frame `embedded`) gets from its host: the group's id, a note the host raises ("Add the
 * credential or cancel it first."), a way to say whether the form holds input, and the values a closed sheet keeps
 * (names and methods, never a secret).
 */
export type EmbedProps = {
  id: string;
  /** False: restored open with a closed sheet's draft, so it does not take focus or scroll. */
  focusOnOpen: boolean;
  note?: string | undefined;
  onDirty(dirty: boolean): void;
  start: Record<string, string>;
  save(values: Record<string, string>): void;
};

/** Tells the host whether the form holds input, and that it holds none once it is gone. */
export function useEmbedDirty(embed: EmbedProps | undefined, dirty: boolean) {
  const report = embed?.onDirty;
  useEffect(() => {
    report?.(dirty);
  }, [report, dirty]);
  useEffect(() => () => report?.(false), [report]);
}

/** Keeps the host's draft current: `values` as they are now, written after every change. */
export function useEmbedDraft(embed: EmbedProps | undefined, values: Record<string, string>) {
  const save = embed?.save;
  const key = JSON.stringify(values);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` is `values`, as a primitive
  useEffect(() => {
    save?.(values);
  }, [save, key]);
}

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
  embed,
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
  ref?: Ref<HTMLElement>;
  autoFocusId?: string;
  /** False: no focus on mount (a restored sign-in moves focus itself, spec §8.2). */
  autoFocus?: boolean;
  reveal?: boolean;
  /** Sheet frame only: a quiet note at the footer's left ("Draft restored · Discard"). */
  left?: ReactNode;
  /** Embedded frame only. */
  embed?: EmbedProps;
  children: ReactNode;
} & (({ frame: "inline" | "embedded" } & InlineOnly) | ({ frame: "sheet" } & SheetOnly))) {
  const noticeId = useId();
  // Sheet frame: focus on open is the body's job (the host prevents Radix's). Phones focus the drawer content, so the
  // keyboard doesn't rise mid-slide; desktop the field a prefilled form names, else its first field.
  // (`reveal` only scrolls an inline form into view, which a sheet doesn't need.)
  const form = useRef<HTMLElement | null>(null);
  // One ref callback sets the internal ref and the caller's, for the sheet's own <form>, the embedded group and (via
  // InlineForm) the inline form.
  const setForm = useCallback(
    (el: HTMLElement | null) => {
      form.current = el;
      if (typeof ref === "function") return ref(el);
      if (ref) ref.current = el;
    },
    [ref],
  );
  // An embedded form opens on a click: the whole group comes into view, then Name has focus.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, when the form opens
  useEffect(() => {
    if (frame !== "embedded" || !autoFocus || embed?.focusOnOpen === false) return;
    const el = form.current;
    el?.scrollIntoView?.({ block: "nearest" });
    const first =
      (autoFocusId ? document.getElementById(autoFocusId) : null) ??
      el?.querySelector<HTMLElement>("input:not([type=hidden]), textarea");
    first?.focus({ preventScroll: true });
  }, []);
  // The overlay's Escape asks the group to collapse (see `collapseEmbeddedOnEscape`).
  // biome-ignore lint/correctness/useExhaustiveDependencies: the latest `onCancel` is read through the ref
  useEffect(() => {
    const el = form.current;
    if (frame !== "embedded" || !el) return;
    const collapse = () => cancelRef.current();
    el.addEventListener(COLLAPSE_EVENT, collapse);
    return () => el.removeEventListener(COLLAPSE_EVENT, collapse);
  }, []);
  const cancelRef = useRef(onCancel);
  cancelRef.current = onCancel;
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
  if (frame === "embedded") {
    // Enter on a field submits this form and nothing else: the enclosing <form> must not see it.
    const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
      const t = e.target as HTMLElement;
      if (
        e.key === "Enter" &&
        (t instanceof HTMLInputElement || t.getAttribute("role") === "radio")
      ) {
        e.stopPropagation();
        const handled = e.defaultPrevented;
        e.preventDefault();
        if (!handled && !pending) onSubmit();
      } else if (e.key === "Escape" && !e.defaultPrevented && !pending) {
        e.preventDefault();
        e.stopPropagation();
        onCancel();
      }
    };
    return (
      // biome-ignore lint/a11y/useSemanticElements: spec §4.9: a div, so no fieldset chrome and never a nested form
      <div
        ref={setForm}
        id={embed?.id}
        role="group"
        aria-label={label}
        aria-describedby={embed?.note ? `${embed.id}-note` : undefined}
        {...{ [EMBEDDED_ATTR]: "" }}
        data-busy={pending ? "" : undefined}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="field-stack mt-2 min-w-0 border-l border-border pl-3 outline-none" // ui-contract:allow the group takes focus only when the host calls attention to it
      >
        {children}
        {embed?.note ? (
          <p
            id={`${embed.id}-note`}
            role="status"
            className="text-[0.8125rem] leading-[1.125rem] text-foreground"
          >
            {embed.note}
          </p>
        ) : null}
        <FormOutcome
          outcome={outcome}
          pending={pending ? pendingLabel : undefined}
          className="-mt-2"
        />
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            inForm
            aria-disabled={pending || undefined}
            onClick={() => !pending && onSubmit()}
          >
            {pending && <Spinner />}
            {pending ? pendingLabel : submitLabel}
          </Button>
          <Button
            type="button"
            variant="ghost"
            inForm
            data-skip-validate
            aria-disabled={pending || undefined}
            onClick={() => !pending && onCancel()}
          >
            Cancel
          </Button>
        </div>
      </div>
    );
  }
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
        ref={setForm as (el: HTMLFormElement | null) => void}
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
