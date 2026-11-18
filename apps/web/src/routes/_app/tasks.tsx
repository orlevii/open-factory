import { createFileRoute } from "@tanstack/react-router";
import { EmptyState } from "@/components/empty-state";

export const Route = createFileRoute("/_app/tasks")({
  component: () => (
    <section>
      <h1 className="mb-4 text-xl font-semibold">Tasks</h1>
      <EmptyState text="No tasks yet." />
    </section>
  ),
});
