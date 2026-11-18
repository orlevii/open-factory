import { createFileRoute } from "@tanstack/react-router";
import { EmptyState } from "@/components/empty-state";
import { PageBody, PageHeader } from "@/components/page-header";

export const Route = createFileRoute("/_app/inbox")({
  component: () => (
    <>
      <PageHeader title="Inbox" />
      <PageBody>
        <EmptyState text="Nothing in your inbox." />
      </PageBody>
    </>
  ),
});
