import { ApiError } from "@open-factory/shared";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { z } from "zod";
import { PageBody } from "@/components/page-header";
import { ResourceNotFound } from "@/components/route-states";
import { taskDetailOptions, taskSummaryFromList } from "@/features/tasks/api";
import { TaskDetailHeader, TaskDetailView, useTaskDetail } from "@/features/tasks/task-detail";

export const Route = createFileRoute("/_app/tasks/$key")({
  validateSearch: z.object({ comment: z.string().min(1).optional().catch(undefined) }),
  // When a list already holds the task's row the page renders from it at once and the detail loads
  // behind it (spec §11); only an uncached key waits here, so it can show the not-found state.
  loader: async ({ context, params, preload }) => {
    const qc = context.queryClient;
    const opts = taskDetailOptions(params.key);
    // A hover warms the cache once; the click within 5s reuses it (pr76 R2).
    const detail = preload
      ? qc.ensureQueryData(opts)
      : qc.fetchQuery({ ...opts, staleTime: 5_000 });
    if (taskSummaryFromList(qc, params.key)) {
      detail.catch(() => {}); // the page maps a failure itself
      return;
    }
    try {
      await detail;
    } catch (e) {
      if (e instanceof ApiError && e.code === "task_not_found") throw notFound();
      // Anything else: the page shows the error line.
    }
  },
  notFoundComponent: TaskNotFound,
  component: TaskPage,
});

function TaskNotFound() {
  const { key } = Route.useParams();
  return (
    <ResourceNotFound
      title="Task not found."
      detail={`No task ${key}.`}
      backTo="/tasks"
      backLabel="Back to tasks"
    />
  );
}

function TaskPage() {
  const { key } = Route.useParams();
  const { comment } = Route.useSearch();
  const { data, error } = useTaskDetail(key);
  // A task the cached list knew but the server doesn't (spec §11): the loader didn't wait for it.
  if (error instanceof ApiError && error.code === "task_not_found") return <TaskNotFound />;
  return (
    <>
      <TaskDetailHeader taskKey={key} title={data?.title} />
      {data ? (
        // Keyed by task: editors and the draft are per task, and survive refetches of it.
        <TaskDetailView key={key} taskKey={key} commentId={comment} />
      ) : (
        error && (
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
