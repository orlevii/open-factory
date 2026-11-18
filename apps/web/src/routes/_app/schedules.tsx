import { createFileRoute } from "@tanstack/react-router";
import { EmptyState } from "@/components/empty-state";

export const Route = createFileRoute("/_app/schedules")({
  component: () => (
    <section>
      <h1 className="mb-4 text-xl font-semibold">Schedules</h1>
      <EmptyState text="No schedules yet." />
    </section>
  ),
});
