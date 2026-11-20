import { createFileRoute } from "@tanstack/react-router";
import { EmptyState } from "@/components/empty-state";
import { PageBody, PageHeader } from "@/components/page-header";

export const Route = createFileRoute("/_app/tasks/")({
  component: () => (
    <>
      <PageHeader title="Tasks" />
      <PageBody>
        <EmptyState text="No tasks yet." />
      </PageBody>
    </>
  ),
});
