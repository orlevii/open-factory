import { ApiError } from "@open-factory/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { SheetDescription } from "@/components/ui/sheet";
import { notify } from "@/components/ui/toaster";
import { useAgent } from "@/features/agents/use-agent-index";
import { clearDraft } from "@/features/sheets/drafts";
import type { BodyProps } from "@/features/sheets/sheet-bodies";
import { getSheetState, openSheet } from "@/features/sheets/sheet-store";
import { createTask, tasksQueryKey } from "./api";
import { TaskForm } from "./task-form";

type Spec = { kind: "new-task"; assignee?: string };

/** "For Ada" under the title when the sheet was opened for an agent. */
function ForAgent({ slug }: { slug: string }) {
  const agent = useAgent(slug);
  return (
    <SheetDescription className="px-4 pt-3">
      For {agent?.displayName || `@${slug}`}
    </SheetDescription>
  );
}

/** The New task sheet body (§8). A result that arrives after the sheet was dismissed toasts instead of closing it. */
export default function NewTaskSheet({ spec, sheetId, close }: BodyProps<Spec>) {
  const qc = useQueryClient();
  const router = useRouter();
  const stillOpen = () => getSheetState().parent?.id === sheetId;
  return (
    <>
      {spec.assignee && <ForAgent slug={spec.assignee} />}
      <TaskForm
        draftKey="new-task"
        prefill={spec.assignee ? { assignee: spec.assignee } : undefined}
        onSubmit={async (body) => {
          let key: string;
          try {
            key = (await createTask(body)).task.key;
          } catch (err) {
            if (stillOpen()) throw err;
            notify({
              text:
                err instanceof ApiError
                  ? err.message
                  : "Couldn't create the task: can't reach the server.",
              action: { label: "Open form", run: () => openSheet({ kind: "new-task" }) },
            });
            return;
          }
          clearDraft("new-task");
          void qc.invalidateQueries({ queryKey: tasksQueryKey });
          if (stillOpen()) close();
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
