import { createFileRoute, Link, useLocation, useNavigate } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { z } from "zod";
import { PageBody, PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import type { ScheduleFilters } from "@/features/schedules/api";
import { ScheduleFiltersBar } from "@/features/schedules/schedule-filters";
import { type PageOutcome, ScheduleList } from "@/features/schedules/schedule-list";

export const Route = createFileRoute("/_app/schedules/")({
  // Unknown values fall back to the defaults rather than an error page.
  validateSearch: z.object({
    target: z.string().min(1).max(64).optional().catch(undefined),
    done: z.literal(true).optional().catch(undefined),
  }),
  component: SchedulesPage,
});

function SchedulesPage() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  // One-shot router state from another page (Created S-8. / Deleted S-3.): read once, then cleared.
  const state = useLocation({ select: (l) => l.state }) as { outcome?: PageOutcome };
  const [initial] = useState(state.outcome);
  useEffect(() => {
    // Read once: clear it so a reload or Back doesn't show "Deleted S-3." / "Created S-8." again.
    if (state.outcome)
      void navigate({ to: "/schedules", search, replace: true, state: {} as never });
  }, [state.outcome, navigate, search]);
  const filters: ScheduleFilters = { target: search.target, done: search.done };
  const onChange = (next: ScheduleFilters) =>
    void navigate({
      to: "/schedules",
      search: {
        ...(next.target ? { target: next.target } : {}),
        ...(next.done ? { done: true as const } : {}),
      },
    });
  return (
    <>
      <PageHeader
        title="Schedules"
        actions={
          <Button variant="ghost" asChild>
            <Link
              to="/schedules/new"
              search={search.target ? { target: search.target } : {}}
              /* ui-contract:allow the visible label collapses to sr-only below md; the title names the icon-only link, and repeats the visible text above it */
              title="New schedule"
            >
              <Plus aria-hidden="true" data-icon="inline-start" />
              <span className="max-md:sr-only">New schedule</span>
            </Link>
          </Button>
        }
      />
      <PageBody>
        <div className="grid gap-4">
          <ScheduleFiltersBar value={filters} onChange={onChange} />
          <ScheduleList filters={filters} onChange={onChange} initial={initial} />
        </div>
      </PageBody>
    </>
  );
}
