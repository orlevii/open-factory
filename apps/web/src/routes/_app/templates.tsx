import { createFileRoute } from "@tanstack/react-router";
import { EmptyState } from "@/components/empty-state";

export const Route = createFileRoute("/_app/templates")({
  component: () => (
    <section>
      <h1 className="mb-4 text-xl font-semibold">Templates</h1>
      <EmptyState text="No templates yet." />
    </section>
  ),
});
