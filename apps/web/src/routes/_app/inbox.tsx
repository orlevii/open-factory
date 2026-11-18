import { createFileRoute } from "@tanstack/react-router";
import { EmptyState } from "@/components/empty-state";

export const Route = createFileRoute("/_app/inbox")({
  component: () => (
    <section>
      <h1 className="mb-4 text-xl font-semibold">Inbox</h1>
      <EmptyState text="Nothing in your inbox." />
    </section>
  ),
});
