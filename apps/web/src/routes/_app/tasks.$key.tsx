import { ApiError } from "@open-factory/shared";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { z } from "zod";
import { PageBody } from "@/components/page-header";
import { ResourceNotFound } from "@/components/route-states";
import { taskDetailOptions } from "@/features/tasks/api";
import { TaskDetailHeader, TaskDetailView } from "@/features/tasks/task-detail";

export const Route = createFileRoute("/_app/tasks/$key")({
  validateSearch: z.object({ comment: z.string().min(1).optional().catch(undefined) }),
  // Only so the first load shows the pending mark and an unknown key the not-found state.
  loader: async ({ context, params, preload }) => {
    const opts = taskDetailOptions(params.key);
    try {
      // A hover warms the cache once; the click within 5s reuses it (pr76 R2).
      await (preload
        ? context.queryClient.ensureQueryData(opts)
        : context.queryClient.fetchQuery({ ...opts, staleTime: 5_000 }));
    } catch (e) {
      if (e instanceof ApiError && e.code === "task_not_found") throw notFound();
      // Anything else: the page shows the error line.
    }
  },
  notFoundComponent: function TaskNotFound() {
    const { key } = Route.useParams();
    return (
      <ResourceNotFound
        title="Task not found."
        detail={`No task ${key}.`}
        backTo="/tasks"
        backLabel="Back to tasks"
      />
    );
  },
  component: TaskPage,
});

function TaskPage() {
  const { key } = Route.useParams();
  const { comment } = Route.useSearch();
  const { data, isError } = useQuery(taskDetailOptions(key));
  return (
    <>
      <TaskDetailHeader taskKey={key} title={data?.title} />
      {data ? (
        // Keyed by task: editors and the draft are per task, and survive refetches of it.
        <TaskDetailView key={key} taskKey={key} commentId={comment} />
      ) : (
        isError && (
          <PageBody>
            <p role="alert" className="text-sm text-muted-foreground">
              Couldn't load this task.
            </p>
          </PageBody>
        )
      )}
    </>
  );
}
