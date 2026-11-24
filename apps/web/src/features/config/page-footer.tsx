import { useCallback, useId } from "react";
import { FormOutcome, type Outcome, showsNotice } from "@/components/forms/form-outcome";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { CONFIG_PAGE_COPY } from "./messages";

/**
 * The footer of a page with one save (DESIGN.md → Page forms; spec §12.4 R6): the I4 outcome line above Discard (ghost)
 * and Save changes (primary), side by side at every width. It is sticky at the bottom of the page column only while
 * `sticky` (the form is dirty, or an outcome shows), and otherwise sits in the flow at the end of the form. A plate
 * with a top rule, no blur. Save keeps its shape while it can't run: `aria-disabled`, described by the outcome's notice.
 * `onHeight` hears the footer's height, for an editor's bottom scroll margin; it must be stable.
 */
export function PageFooter({
  outcome,
  sticky,
  pending,
  canSave,
  canDiscard,
  onSave,
  onDiscard,
  onHeight,
  saveId,
}: {
  outcome: Outcome;
  sticky: boolean;
  pending: boolean;
  canSave: boolean;
  canDiscard: boolean;
  onSave(): void;
  onDiscard(): void;
  onHeight?: (px: number) => void;
  /** Save's id, for a page that moves focus to it (after a Reload). */
  saveId?: string;
}) {
  const noticeId = useId();
  // A ref callback with a cleanup (React 19): the observer lives exactly as long as the element.
  const measure = useCallback(
    (el: HTMLDivElement | null) => {
      if (!el) return;
      // The sticky bar's height is the bottom scroll margin of the controls beside it (styles.css), so one scrolled into
      // view or focused clears the bar (WCAG 2.4.11). Custom properties inherit, so the root carries it.
      const root = document.documentElement.style;
      const report = () => {
        root.setProperty("--page-footer-height", `${el.offsetHeight}px`);
        onHeight?.(el.offsetHeight);
      };
      report();
      const ro = new ResizeObserver(report);
      ro.observe(el);
      return () => {
        ro.disconnect();
        root.removeProperty("--page-footer-height");
      };
    },
    [onHeight],
  );
  const saveBlocked = pending || !canSave;
  return (
    <div
      ref={measure}
      data-slot="page-footer"
      data-sticky={sticky ? "" : undefined}
      className={cn(
        "z-10 grid grid-cols-[minmax(0,1fr)] gap-2 border-t border-border bg-card py-3",
        sticky && "sticky bottom-0",
      )}
    >
      <FormOutcome
        outcome={outcome}
        pending={pending ? CONFIG_PAGE_COPY.saving : undefined}
        noticeId={noticeId}
      />
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          aria-disabled={!canDiscard || undefined}
          onClick={() => canDiscard && onDiscard()}
        >
          {CONFIG_PAGE_COPY.discard}
        </Button>
        <Button
          id={saveId}
          type="button"
          aria-disabled={saveBlocked || undefined}
          aria-describedby={showsNotice(outcome) ? noticeId : undefined}
          className="min-w-32"
          onClick={onSave}
        >
          {pending && <Spinner />}
          {pending ? CONFIG_PAGE_COPY.saving : CONFIG_PAGE_COPY.save}
        </Button>
      </div>
    </div>
  );
}
