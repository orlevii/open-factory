import type { LiveCron } from "@open-factory/shared";
import { ConfirmDialog } from "@/components/confirm-dialog";

/** S9 UI design §4.2: names the crons lost; the button names the action. Failures stay in the dialog's alert line. */
export function StopCronsDialog({
  handle,
  crons,
  open,
  onOpenChange,
  onConfirm,
  onCloseAutoFocus,
}: {
  handle: string;
  crons: LiveCron[];
  open: boolean;
  onOpenChange(o: boolean): void;
  onConfirm(): Promise<void>;
  onCloseAutoFocus(e: Event): void;
}) {
  const label = `Stop ${crons.length} ${crons.length === 1 ? "cron" : "crons"}`;
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Stop @${handle}'s crons?`}
      body={
        <>
          These crons stop and can't be restored:
          <span className="mt-1 mb-1 block">
            {crons.map((c) => (
              <span key={c.cronId} className="block">
                {c.humanSchedule}
                {c.recurring ? "" : ", once"}
              </span>
            ))}
          </span>
          @{handle} hibernates now, or when its current work finishes, and is told you stopped them.
        </>
      }
      confirmLabel={label}
      pendingLabel="Stopping…"
      onConfirm={onConfirm}
      onCloseAutoFocus={onCloseAutoFocus}
    />
  );
}
