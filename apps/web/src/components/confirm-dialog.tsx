import { ApiError } from "@open-factory/shared";
import { Loader2 } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
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

/** For destructive, irreversible actions only. The action is named in the title and on the button. */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  body,
  detail,
  confirmLabel,
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
  onConfirm(): Promise<void> | void;
  /** Where focus goes on close, when there is no trigger to return to (opened from a menu). */
  onCloseAutoFocus?: (e: Event) => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  // The error belongs to one opening of the dialog.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on every open/close
  useEffect(() => setError(undefined), [open]);
  async function confirm(e: { preventDefault(): void }) {
    // Radix closes on Action click; hold it open until the work resolves.
    e.preventDefault();
    if (pending) return;
    setPending(true);
    setError(undefined);
    try {
      await onConfirm();
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Try again.");
    } finally {
      setPending(false);
    }
  }
  // While pending, Escape, outside click and Cancel are ignored: the request cannot be
  // abandoned, so the dialog says so by staying put and showing the action's pending label.
  // The action uses aria-disabled (not disabled) so focus stays on it instead of falling to <body>.
  return (
    <AlertDialog open={open} onOpenChange={(o) => !pending && onOpenChange(o)}>
      <AlertDialogContent onCloseAutoFocus={onCloseAutoFocus}>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{body}</AlertDialogDescription>
        </AlertDialogHeader>
        {detail}
        <div
          role="alert"
          className="text-[0.8125rem] leading-[1.125rem] text-destructive empty:hidden"
        >
          {error}
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel
            autoFocus
            aria-disabled={pending || undefined}
            onClick={(e) => pending && e.preventDefault()}
          >
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            aria-disabled={pending || undefined}
            onClick={confirm}
          >
            {pending && <Loader2 aria-hidden="true" className="animate-spin" />}
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
