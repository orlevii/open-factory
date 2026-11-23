import { ApiError } from "@open-factory/shared";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { FormOutcome, useOutcome } from "@/components/forms/form-outcome";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Drawer,
  DrawerBody,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { Spinner } from "@/components/ui/spinner";
import { useLatchedMobile } from "@/hooks/use-latched-mobile";

/** A button that carries a name wraps to two lines; it is never truncated (DESIGN.md → Overlays).
 *  `shrink min-w-0 max-w-full` undo Button's `shrink-0`, which held the max-content width in the flex footer;
 *  the touch-height override keeps `pointer-coarse:h-9` from pinning a wrapped label to one line. */
const ACTION_CLASS =
  "shrink min-w-0 max-w-full whitespace-normal h-auto min-h-8 pointer-coarse:h-auto pointer-coarse:min-h-9 py-1.5 text-center [overflow-wrap:anywhere]";
/** Body and detail stacked; the outcome line lives in the footer band. */
const MIDDLE_CLASS = "flex flex-col gap-3";

/** For destructive, irreversible actions only. The action is named in the title and on the button.
 *  A centered dialog on desktop, a bottom drawer on phones (decided per opening). */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  body,
  detail,
  confirmLabel,
  pendingLabel,
  onConfirm,
  onCloseAutoFocus,
}: {
  open: boolean;
  onOpenChange(o: boolean): void;
  title: string;
  body: ReactNode;
  /** A muted line under the body, outside the description (e.g. the error that led here). */
  detail?: ReactNode;
  confirmLabel: string;
  /** The action button's text while the request is out ("Terminating…"), next to a spinner. */
  pendingLabel: string;
  onConfirm(): Promise<void> | void;
  /** Where focus goes on close, when there is no trigger to return to (opened from a menu). */
  onCloseAutoFocus?: (e: Event) => void;
}) {
  const mobile = useLatchedMobile(open);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [pending, setPending] = useState(false);
  const o = useOutcome();
  // The error belongs to one opening of the dialog.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on every open/close
  useEffect(() => o.clear(), [open]);
  async function confirm(e: { preventDefault(): void }) {
    // Radix closes on Action click; hold it open until the work resolves.
    e.preventDefault();
    if (pending) return;
    setPending(true);
    o.clear();
    try {
      await onConfirm();
      onOpenChange(false);
    } catch (err) {
      o.fail(err instanceof ApiError ? err.message : "Something went wrong. Try again.");
    } finally {
      setPending(false);
    }
  }
  // While pending, Escape, outside click, drag and Cancel are ignored: the request cannot be
  // abandoned, so the dialog says so by staying put and showing the action's pending label.
  // The action uses aria-disabled (not disabled) so focus stays on it instead of falling to <body>.
  const action = (
    <Button
      variant="destructive"
      className={ACTION_CLASS}
      aria-busy={pending || undefined}
      aria-disabled={pending || undefined}
      onClick={confirm}
    >
      {pending && <Spinner />}
      {pending ? pendingLabel : confirmLabel}
    </Button>
  );
  const outcomeLine = <FormOutcome outcome={o.outcome} className="basis-full" />;

  if (mobile) {
    return (
      <Drawer
        open={open}
        onOpenChange={(next) => !pending && onOpenChange(next)}
        dismissible={!pending}
      >
        <DrawerContent
          role="alertdialog"
          aria-modal="true"
          onPointerDownOutside={(e) => pending && e.preventDefault()}
          onEscapeKeyDown={(e) => pending && e.preventDefault()}
          onCloseAutoFocus={onCloseAutoFocus}
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            cancelRef.current?.focus();
          }}
        >
          <DrawerHeader>
            <DrawerTitle className="line-clamp-none">{title}</DrawerTitle>
          </DrawerHeader>
          <DrawerBody className={MIDDLE_CLASS}>
            <DrawerDescription className="[overflow-wrap:anywhere]">{body}</DrawerDescription>
            {detail}
          </DrawerBody>
          <DrawerFooter className="pt-2">
            {outcomeLine}
            {action}
            <Button
              ref={cancelRef}
              variant="outline"
              aria-disabled={pending || undefined}
              onClick={() => !pending && onOpenChange(false)}
            >
              Cancel
            </Button>
          </DrawerFooter>
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <AlertDialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <AlertDialogContent
        className="sm:max-w-md max-h-[calc(100svh-2rem)] grid-rows-[auto_minmax(0,1fr)_auto]"
        onCloseAutoFocus={onCloseAutoFocus}
      >
        <AlertDialogHeader>
          <AlertDialogTitle className="[overflow-wrap:anywhere]">{title}</AlertDialogTitle>
        </AlertDialogHeader>
        <div className={`min-h-0 overflow-y-auto ${MIDDLE_CLASS}`}>
          <AlertDialogDescription className="[overflow-wrap:anywhere]">
            {body}
          </AlertDialogDescription>
          {detail}
        </div>
        <AlertDialogFooter className="flex-wrap pt-2">
          {outcomeLine}
          <AlertDialogCancel
            autoFocus
            aria-disabled={pending || undefined}
            onClick={(e) => pending && e.preventDefault()}
          >
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction asChild>{action}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
