import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { PageBody, PageHeader } from "@/components/page-header";
import { createTask, tasksQueryKey } from "@/features/tasks/api";
import { TaskForm } from "@/features/tasks/task-form";

export const Route = createFileRoute("/_app/tasks/new")({ component: NewTask });

function NewTask() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  return (
    <>
      <PageHeader title="New task" />
      <PageBody>
        <TaskForm
          onSubmit={async (body) => {
            const { task } = await createTask(body);
            await qc.invalidateQueries({ queryKey: tasksQueryKey });
            await navigate({ to: "/tasks/$key", params: { key: task.key }, search: {} });
          }}
        />
      </PageBody>
    </>
  );
}
