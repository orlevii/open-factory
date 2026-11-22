import { ApiError } from "@open-factory/shared";
import { useQueryClient } from "@tanstack/react-query";
import { notify } from "@/components/ui/toaster";
import { clearDraft } from "@/features/sheets/drafts";
import type { BodyProps } from "@/features/sheets/sheet-bodies";
import { getSheetState, openSheet } from "@/features/sheets/sheet-store";
import { type CreateScheduleBody, createSchedule, schedulesQueryKey } from "./api";
import { ScheduleForm } from "./schedule-form";

type Spec = { kind: "new-schedule"; target?: string };

/** The New schedule sheet body (§9.1). A result that arrives after the sheet was dismissed toasts instead of closing it. */
export default function NewScheduleSheet({ spec, sheetId, close }: BodyProps<Spec>) {
  const qc = useQueryClient();
  const stillOpen = () => getSheetState().parent?.id === sheetId;
  return (
    <ScheduleForm
      inSheet
      draftKey="new-schedule"
      presetTarget={spec.target}
      onSubmit={async (body) => {
        let key: string;
        try {
          key = (await createSchedule(body as CreateScheduleBody)).key;
        } catch (err) {
          if (stillOpen()) throw err;
          notify({
            text:
              err instanceof ApiError
                ? err.message
                : "Couldn't create the schedule: can't reach the server.",
            action: {
              label: "Open form",
              run: () => openSheet({ kind: "new-schedule" }),
            },
          });
          return;
        }
        // A late success must not wipe a draft the user restored by reopening New schedule while this was in flight.
        if (getSheetState().parent?.kind !== "new-schedule" || stillOpen())
          clearDraft("new-schedule");
        void qc.invalidateQueries({ queryKey: schedulesQueryKey });
        if (stillOpen()) close();
        notify({
          text: `Created ${key}.`,
          action: { label: "Open", run: () => openSheet({ kind: "edit-schedule", key }) },
        });
      }}
    />
  );
}
