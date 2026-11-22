import { createFileRoute, useNavigate, useRouter } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { useRef, useState } from "react";
import { z } from "zod";
import { PageBody, PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { closeInstantly } from "@/components/ui/sheet";
import { preloadSheet } from "@/features/sheets/sheet-bodies";
import { newTask } from "@/features/tasks/actions";
import type { TaskFilters } from "@/features/tasks/api";
import { TaskFiltersBar } from "@/features/tasks/task-filters";
import { findTaskRow, TaskList, type TaskPeekControl } from "@/features/tasks/task-list";
import { focusTaskPeek, TaskPeek } from "@/features/tasks/task-peek";

const STATUSES = ["open_in_progress", "open", "in_progress", "done", "cancelled", "all"] as const;

export const Route = createFileRoute("/_app/tasks/")({
  // Unknown values fall back to the defaults rather than an error page.
  validateSearch: z.object({
    status: z.enum(STATUSES).optional().catch(undefined),
    assignee: z.string().min(1).max(64).optional().catch(undefined),
    unassigned: z.literal(true).optional().catch(undefined),
    creator: z.string().min(1).max(65).optional().catch(undefined),
  }),
  component: TasksPage,
});

function TasksPage() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  const router = useRouter();
  const filters: TaskFilters = {
    status: search.status ?? "open_in_progress",
    assignee: search.assignee,
    unassigned: search.unassigned,
    creator: search.creator,
  };
  // One peek per page (spec §5.2), not in the URL (D11).
  const [peekKey, setPeekKey] = useState<string | null>(null);
  // New filters, a new list: the peek closes rather than show a task the list may no longer have.
  const filtersKey = JSON.stringify(filters);
  const [peekFilters, setPeekFilters] = useState(filtersKey);
  if (peekFilters !== filtersKey) {
    setPeekFilters(filtersKey);
    setPeekKey(null);
  }
  const peekContent = useRef<HTMLDivElement>(null);
  const peek: TaskPeekControl = {
    key: peekKey,
    show: setPeekKey,
    close: () => closeInstantly(peekContent.current, () => setPeekKey(null)),
    focus: () => focusTaskPeek(peekContent.current),
  };
  const onChange = (next: TaskFilters) =>
    void navigate({
      to: "/tasks",
      search: {
        ...(next.status !== "open_in_progress" ? { status: next.status } : {}),
        ...(next.assignee ? { assignee: next.assignee } : {}),
        ...(next.unassigned ? { unassigned: true as const } : {}),
        ...(next.creator ? { creator: next.creator } : {}),
      },
    });
  return (
    <>
      <PageHeader
        title="Tasks"
        actions={
          <Button
            variant="ghost"
            /* ui-contract:allow the visible label collapses to sr-only below md; the title names the icon-only button, and repeats the visible text above it */
            title="New task"
            onClick={() => newTask(router)}
            onPointerEnter={() => preloadSheet("new-task")}
            onFocus={() => preloadSheet("new-task")}
          >
            <Plus aria-hidden="true" data-icon="inline-start" />
            <span className="max-md:sr-only">New task</span>
          </Button>
        }
      />
      <PageBody>
        <div className="grid grid-cols-[minmax(0,1fr)] gap-4">
          <TaskFiltersBar value={filters} onChange={onChange} />
          <TaskList filters={filters} onChange={onChange} peek={peek} />
        </div>
      </PageBody>
      <TaskPeek
        taskKey={peekKey}
        onClose={() => setPeekKey(null)}
        contentRef={peekContent}
        returnFocus={findTaskRow}
      />
    </>
  );
}
