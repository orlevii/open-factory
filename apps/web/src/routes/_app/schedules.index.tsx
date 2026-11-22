import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { z } from "zod";
import { PageBody, PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import type { ScheduleFilters } from "@/features/schedules/api";
import { ScheduleFiltersBar } from "@/features/schedules/schedule-filters";
import { ScheduleList } from "@/features/schedules/schedule-list";
import { preloadSheet } from "@/features/sheets/sheet-bodies";
import { openSheet } from "@/features/sheets/sheet-store";

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
          <Button
            variant="ghost"
            /* ui-contract:allow the visible label collapses to sr-only below md; the title names the icon-only button, and repeats the visible text above it */
            title="New schedule"
            onClick={() =>
              openSheet({
                kind: "new-schedule",
                ...(search.target ? { target: search.target } : {}),
              })
            }
            onPointerEnter={() => preloadSheet("new-schedule")}
            onFocus={() => preloadSheet("new-schedule")}
          >
            <Plus aria-hidden="true" data-icon="inline-start" />
            <span className="max-md:sr-only">New schedule</span>
          </Button>
        }
      />
      <PageBody>
        <div className="grid grid-cols-[minmax(0,1fr)] gap-4">
          <ScheduleFiltersBar value={filters} onChange={onChange} />
          <ScheduleList filters={filters} onChange={onChange} />
        </div>
      </PageBody>
    </>
  );
}
