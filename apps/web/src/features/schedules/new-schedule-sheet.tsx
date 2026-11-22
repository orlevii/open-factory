import { ApiError } from "@open-factory/shared";
import { useQueryClient } from "@tanstack/react-query";
import { notify } from "@/components/ui/toaster";
import { clearDraft, clearDraftIf, draftGeneration, peekDraft } from "@/features/sheets/drafts";
import type { BodyProps } from "@/features/sheets/sheet-bodies";
import { closeSheet, getSheetState, openSheet } from "@/features/sheets/sheet-store";
import { type CreateScheduleBody, createSchedule, schedulesQueryKey } from "./api";
import { ScheduleForm } from "./schedule-form";

type Spec = { kind: "new-schedule"; target?: string };

/**
 * The New schedule sheet body (§9.1). A result that arrives after the sheet was dismissed toasts instead of closing it.
 * A late success clears the draft only if it still holds the submitted values; a New schedule reopened on those
 * untouched values closes, so the held "Created" toast shows and the schedule can't be created twice. Edits made since
 * are kept. Nothing is written back after a sign-out (the draft generation changed).
 */
export default function NewScheduleSheet({ spec, sheetId, close }: BodyProps<Spec>) {
  const qc = useQueryClient();
  const stillOpen = () => getSheetState().parent?.id === sheetId;
  return (
    <ScheduleForm
      presetTarget={spec.target}
      onSubmit={async (body) => {
        const snapshot = peekDraft("new-schedule");
        const generation = draftGeneration();
        let key: string;
        try {
          key = (await createSchedule(body as CreateScheduleBody)).key;
        } catch (err) {
          if (stillOpen()) throw err;
          if (draftGeneration() !== generation) return;
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
        if (draftGeneration() !== generation) return;
        void qc.invalidateQueries({ queryKey: schedulesQueryKey });
        if (stillOpen()) {
          clearDraft("new-schedule");
          close();
        } else if (
          clearDraftIf("new-schedule", snapshot) &&
          getSheetState().parent?.kind === "new-schedule"
        )
          closeSheet();
        notify({
          text: `Created ${key}.`,
          action: { label: "Open", run: () => openSheet({ kind: "edit-schedule", key }) },
        });
      }}
    />
  );
}
