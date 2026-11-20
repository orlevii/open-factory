import { ConfirmDialog } from "@/components/confirm-dialog";

/** S7 UI design §5.3: Unpin after the grace deletes the workspace within minutes, so it confirms. */
export function UnpinDialog({
  slug,
  open,
  onOpenChange,
  onConfirm,
}: {
  slug: string;
  open: boolean;
  onOpenChange(o: boolean): void;
  onConfirm(): Promise<void>;
}) {
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Unpin and delete @${slug}'s workspace?`}
      body="Its files and Claude config are removed within 10 minutes; its session history stays."
      confirmLabel="Delete workspace"
      onConfirm={onConfirm}
    />
  );
}
