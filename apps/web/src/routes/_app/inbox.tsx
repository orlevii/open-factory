import { useInfiniteQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useRef } from "react";
import { z } from "zod";
import { PageBody, PageHeader } from "@/components/page-header";
import { type InboxItem, inboxQueryOptions } from "@/features/inbox/api";
import { InboxList } from "@/features/inbox/inbox-list";
import { InboxPane } from "@/features/inbox/inbox-pane";
import {
  MarkAllReadButton,
  MarkAllReadOutcome,
  useMarkAllRead,
} from "@/features/inbox/mark-all-read";
import { useMedia, WIDE } from "@/lib/breakpoints";

export const Route = createFileRoute("/_app/inbox")({
  // `item` is the reading pane's selection (≥1024). No loaderDeps: selecting never re-runs the loader.
  validateSearch: z.object({ item: z.string().min(1).optional().catch(undefined) }),
  // Only so the first load shows the route's pending mark; a failure is the list's own error line.
  loader: async ({ context }) => {
    await context.queryClient.ensureInfiniteQueryData(inboxQueryOptions).catch(() => undefined);
  },
  component: InboxPage,
});

/** The selected row from the loaded pages; re-renders only when that row changes. */
function useLoadedItem(id: string | undefined): InboxItem | undefined {
  return useInfiniteQuery({
    ...inboxQueryOptions,
    select: useCallback(
      (d: { pages: { items: InboxItem[] }[] }) =>
        id === undefined ? undefined : d.pages.flatMap((p) => p.items).find((i) => i.id === id),
      [id],
    ),
  }).data;
}

function InboxPage() {
  const button = useRef<HTMLButtonElement>(null);
  const lastReadAt = useRef<string>(undefined);
  const state = useMarkAllRead(button);
  const wide = useMedia(WIDE);
  const itemId = Route.useSearch({ select: (s) => s.item });
  const navigate = Route.useNavigate();
  const item = useLoadedItem(wide ? itemId : undefined);

  // Below 1024 rows navigate as before; a `?item=` from a wider window is dropped.
  useEffect(() => {
    if (!wide && itemId !== undefined) void navigate({ search: {}, replace: true });
  }, [wide, itemId, navigate]);

  const onSelect = useCallback(
    (id: string, replace: boolean) => void navigate({ search: { item: id }, replace }),
    [navigate],
  );

  const header = (
    <PageHeader title="Inbox" actions={<MarkAllReadButton state={state} buttonRef={button} />} />
  );
  // One grid item: the line's two live regions shouldn't each take a gap.
  const outcome = (
    <div>
      <MarkAllReadOutcome state={state} lastReadAt={lastReadAt} />
    </div>
  );
  if (wide)
    return (
      <div className="flex h-svh min-h-0 flex-col">
        {header}
        <div className="flex min-h-0 flex-1">
          <div className="w-[23.75rem] shrink-0 overflow-y-auto border-r border-border">
            <div className="grid gap-4 py-4">
              <div className="px-4">{outcome}</div>
              <InboxList selectedId={itemId} onSelect={onSelect} />
            </div>
          </div>
          <InboxPane selectedId={itemId} item={item} />
        </div>
      </div>
    );
  return (
    <>
      {header}
      <PageBody>
        <div className="grid gap-4">
          {outcome}
          <InboxList />
        </div>
      </PageBody>
    </>
  );
}
