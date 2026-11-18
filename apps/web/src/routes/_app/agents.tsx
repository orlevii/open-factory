import { createFileRoute } from "@tanstack/react-router";
import { EmptyState } from "@/components/empty-state";
import { PageBody, PageHeader } from "@/components/page-header";

export const Route = createFileRoute("/_app/agents")({
  component: () => (
    <>
      <PageHeader title="Agents" />
      <PageBody>
        <EmptyState text="No agents yet." />
      </PageBody>
    </>
  ),
});
