import { createFileRoute } from "@tanstack/react-router";
import { EmptyState } from "@/components/empty-state";

export const Route = createFileRoute("/_app/settings")({
  component: () => (
    <section>
      <h1 className="mb-4 text-xl font-semibold">Settings</h1>
      <EmptyState text="Nothing to configure yet." />
    </section>
  ),
});
