import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { useRef, useState } from "react";
import { z } from "zod";
import { PageBody, PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { closeInstantly } from "@/components/ui/sheet";
import type { TaskFilters } from "@/features/tasks/api";
import { TaskFiltersBar } from "@/features/tasks/task-filters";
import { TaskList, type TaskPeekControl } from "@/features/tasks/task-list";
import { TaskPeek } from "@/features/tasks/task-peek";

const FOCUSABLE =
  "a[href],button:not([disabled]),input,textarea,select,[tabindex]:not([tabindex='-1'])";

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
  const filters: TaskFilters = {
    status: search.status ?? "open_in_progress",
    assignee: search.assignee,
    unassigned: search.unassigned,
    creator: search.creator,
  };
  // One peek per page (spec §5.2), not in the URL (D11).
  const [peekKey, setPeekKey] = useState<string | null>(null);
  const peekContent = useRef<HTMLDivElement>(null);
  const peek: TaskPeekControl = {
    key: peekKey,
    show: setPeekKey,
    close: () => closeInstantly(peekContent.current, () => setPeekKey(null)),
    focus: () => {
      const el = peekContent.current;
      (el?.querySelector<HTMLElement>(FOCUSABLE) ?? el)?.focus();
    },
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
          <Button variant="ghost" asChild>
            <Link /* ui-contract:allow the visible label collapses to sr-only below md; the title names the icon-only link, and repeats the visible text above it */
              to="/tasks/new"
              title="New task"
            >
              <Plus aria-hidden="true" data-icon="inline-start" />
              <span className="max-md:sr-only">New task</span>
            </Link>
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
        returnFocus={(key) =>
          document.querySelector<HTMLElement>(`ul[aria-label="Tasks"] a[data-task-key="${key}"]`)
        }
      />
    </>
  );
}
