import { createFileRoute } from "@tanstack/react-router";
import { PageBody, PageHeader } from "@/components/page-header";
import { inboxQueryOptions } from "@/features/inbox/api";
import { InboxList } from "@/features/inbox/inbox-list";

export const Route = createFileRoute("/_app/inbox")({
  // Only so the first load shows the route's pending mark; a failure is the list's own error line.
  loader: async ({ context }) => {
    await context.queryClient.ensureInfiniteQueryData(inboxQueryOptions).catch(() => undefined);
  },
  component: () => (
    <>
      <PageHeader title="Inbox" />
      <PageBody>
        <InboxList />
      </PageBody>
    </>
  ),
});
