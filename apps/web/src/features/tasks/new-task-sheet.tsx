import { ApiError } from "@open-factory/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { SheetDescription } from "@/components/ui/sheet";
import { notify } from "@/components/ui/toaster";
import { useAgent, useIsLiveAgent } from "@/features/agents/use-agent-index";
import {
  clearDraft,
  clearDraftIf,
  draftGeneration,
  hasDraft,
  peekDraft,
} from "@/features/sheets/drafts";
import type { BodyProps } from "@/features/sheets/sheet-bodies";
import { closeSheet, getSheetState, openSheet } from "@/features/sheets/sheet-store";
import { createTask, tasksQueryKey } from "./api";
import { TaskForm } from "./task-form";

type Spec = { kind: "new-task"; assignee?: string };

/** "For Ada" under the title when the sheet was opened for an agent; not once the prefill proves stale. */
function ForAgent({ slug }: { slug: string }) {
  const agent = useAgent(slug);
  const live = useIsLiveAgent(slug);
  if (live === false) return null;
  return (
    <SheetDescription className="px-4 pt-3">
      For {agent?.displayName || `@${slug}`}
    </SheetDescription>
  );
}

/**
 * The New task sheet body (§8). A result that arrives after the sheet was dismissed toasts instead of closing it. A late
 * success clears the draft only if it still holds the submitted values; a New task reopened on those untouched values
 * closes, so the held "Created" toast shows and the same task can't be created twice. Edits made since are kept.
 * Nothing is written back after a sign-out (the draft generation changed).
 */
export default function NewTaskSheet({ spec, sheetId, close }: BodyProps<Spec>) {
  const qc = useQueryClient();
  const router = useRouter();
  const stillOpen = () => getSheetState().parent?.id === sheetId;
  // The prefill applies only to an empty draft, so "For X" describes only an open that started empty.
  // After Discard the prefill is back, so "For X" is too.
  const [fresh, setFresh] = useState(() => !hasDraft("new-task"));
  return (
    <>
      {spec.assignee && fresh && <ForAgent slug={spec.assignee} />}
      <TaskForm
        draftKey="new-task"
        prefill={spec.assignee ? { assignee: spec.assignee } : undefined}
        onDiscard={() => setFresh(true)}
        onSubmit={async (body) => {
          const snapshot = peekDraft("new-task");
          const generation = draftGeneration();
          let key: string;
          try {
            key = (await createTask(body)).task.key;
          } catch (err) {
            if (stillOpen()) throw err;
            if (draftGeneration() !== generation) return;
            notify({
              text:
                err instanceof ApiError
                  ? err.message
                  : "Couldn't create the task: can't reach the server.",
              action: { label: "Open form", run: () => openSheet({ kind: "new-task" }) },
            });
            return;
          }
          if (draftGeneration() !== generation) return;
          void qc.invalidateQueries({ queryKey: tasksQueryKey });
          if (stillOpen()) {
            clearDraft("new-task");
            close();
          } else if (
            clearDraftIf("new-task", snapshot) &&
            getSheetState().parent?.kind === "new-task"
          )
            closeSheet();
          notify({
            text: `Created ${key}.`,
            action: {
              label: "Open",
              run: () => void router.navigate({ to: "/tasks/$key", params: { key }, search: {} }),
            },
          });
        }}
      />
    </>
  );
}
