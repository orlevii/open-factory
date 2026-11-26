import { ConfirmDialog } from "@/components/confirm-dialog";

export const TERMINATE_BODY =
  "It stops now, ending any work in progress, and its session can't continue. Messages waiting for it are dropped. Its workspace is deleted 3 days later unless you pin it; worktrees it made in projects stay.";

/** S7 UI design §5.2: names what is lost; the button names the action. A failure keeps it open
 *  with the error in ConfirmDialog's own alert line. */
export function TerminateDialog({
  handle,
  open,
  onOpenChange,
  onConfirm,
  onCloseAutoFocus,
}: {
  handle: string;
  open: boolean;
  onOpenChange(o: boolean): void;
  onConfirm(): Promise<void>;
  onCloseAutoFocus(e: Event): void;
}) {
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Terminate @${handle}?`}
      body={TERMINATE_BODY}
      confirmLabel={`Terminate @${handle}`}
      pendingLabel="Terminating…"
      onConfirm={onConfirm}
      onCloseAutoFocus={onCloseAutoFocus}
    />
  );
}
