import { createFileRoute } from "@tanstack/react-router";
import { EmptyState } from "@/components/empty-state";
import { PageBody, PageHeader } from "@/components/page-header";

export const Route = createFileRoute("/_app/schedules")({
  component: () => (
    <>
      <PageHeader title="Schedules" />
      <PageBody>
        <EmptyState text="No schedules yet." />
      </PageBody>
    </>
  ),
});
