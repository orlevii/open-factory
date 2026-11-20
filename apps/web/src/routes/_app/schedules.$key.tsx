import { ApiError } from "@open-factory/shared";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { ResourceNotFound } from "@/components/route-states";
import { scheduleDetailOptions } from "@/features/schedules/api";
import { ScheduleEdit } from "@/features/schedules/schedule-edit";

export const Route = createFileRoute("/_app/schedules/$key")({
  // Only so the first load shows the pending mark and an unknown key the not-found state.
  loader: async ({ context, params }) => {
    try {
      await context.queryClient.fetchQuery({ ...scheduleDetailOptions(params.key), staleTime: 0 });
    } catch (e) {
      if (e instanceof ApiError && e.code === "schedule_not_found") throw notFound();
      // Anything else: the page shows the error line.
    }
  },
  notFoundComponent: function ScheduleNotFound() {
    const { key } = Route.useParams();
    return (
      <ResourceNotFound
        title={`There is no schedule ${key}.`}
        detail="Check the key, or open the list."
        backTo="/schedules"
        backLabel="Back to schedules"
      />
    );
  },
  component: function SchedulePage() {
    const { key } = Route.useParams();
    return <ScheduleEdit scheduleKey={key} />;
  },
});
