import { createFileRoute } from "@tanstack/react-router";
import { useRef } from "react";
import { PageBody, PageHeader } from "@/components/page-header";
import { inboxQueryOptions } from "@/features/inbox/api";
import { InboxList } from "@/features/inbox/inbox-list";
import {
  MarkAllReadButton,
  MarkAllReadOutcome,
  useMarkAllRead,
} from "@/features/inbox/mark-all-read";

export const Route = createFileRoute("/_app/inbox")({
  // Only so the first load shows the route's pending mark; a failure is the list's own error line.
  loader: async ({ context }) => {
    await context.queryClient.ensureInfiniteQueryData(inboxQueryOptions).catch(() => undefined);
  },
  component: InboxPage,
});

function InboxPage() {
  const button = useRef<HTMLButtonElement>(null);
  const lastReadAt = useRef<string>(undefined);
  const state = useMarkAllRead(button);
  return (
    <>
      <PageHeader title="Inbox" actions={<MarkAllReadButton state={state} buttonRef={button} />} />
      <PageBody>
        <div className="grid gap-4">
          {/* One grid item: the line's two live regions shouldn't each take a gap. */}
          <div>
            <MarkAllReadOutcome state={state} lastReadAt={lastReadAt} />
          </div>
          <InboxList />
        </div>
      </PageBody>
    </>
  );
}
