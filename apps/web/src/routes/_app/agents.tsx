import { createFileRoute } from "@tanstack/react-router";
import { EmptyState } from "@/components/empty-state";

export const Route = createFileRoute("/_app/agents")({
  component: () => (
    <section>
      <h1 className="mb-4 text-xl font-semibold">Agents</h1>
      <EmptyState text="No agents yet." />
    </section>
  ),
});
