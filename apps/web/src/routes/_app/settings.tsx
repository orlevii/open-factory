import { createFileRoute } from "@tanstack/react-router";
import { EmptyState } from "@/components/empty-state";
import { PageBody, PageHeader } from "@/components/page-header";

export const Route = createFileRoute("/_app/settings")({
  component: () => (
    <>
      <PageHeader title="Settings" />
      <PageBody>
        <EmptyState text="Nothing to configure yet." />
      </PageBody>
    </>
  ),
});
