import { createFileRoute } from "@tanstack/react-router";
import { PageBody, PageHeader } from "@/components/page-header";
import { InboxList } from "@/features/inbox/inbox-list";

export const Route = createFileRoute("/_app/inbox")({
  component: () => (
    <>
      <PageHeader title="Inbox" />
      <PageBody>
        <InboxList />
      </PageBody>
    </>
  ),
});
