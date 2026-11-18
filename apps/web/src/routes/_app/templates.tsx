import { createFileRoute } from "@tanstack/react-router";
import { EmptyState } from "@/components/empty-state";
import { PageBody, PageHeader } from "@/components/page-header";

export const Route = createFileRoute("/_app/templates")({
  component: () => (
    <>
      <PageHeader title="Templates" />
      <PageBody>
        <EmptyState text="No templates yet." />
      </PageBody>
    </>
  ),
});
