import type { ChatRow } from "@open-factory/shared";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useMemo, useRef, useState } from "react";
import { z } from "zod";
import { PageBody, PageHeader } from "@/components/page-header";
import { chatRefOf, inboxQueryOptions, useLoadedItem } from "@/features/inbox/api";
import { InboxList } from "@/features/inbox/inbox-list";
import { InboxPane } from "@/features/inbox/inbox-pane";
import {
  MarkAllReadButton,
  MarkAllReadOutcome,
  useMarkAllRead,
} from "@/features/inbox/mark-all-read";
import { NarrowItem } from "@/features/inbox/narrow-item";
import { agentDetailQueryOptions } from "@/features/session/api";
import { setupQueryOptions } from "@/features/setup/api";
import { useMedia, WIDE } from "@/lib/breakpoints";

export const Route = createFileRoute("/_app/inbox")({
  // `item` is the reading pane's selection at every width. No loaderDeps: selecting never re-runs the loader.
  validateSearch: z.object({ item: z.string().min(1).optional().catch(undefined) }),
  // Only so the first load shows the route's pending mark; a failure is the list's own error line.
  loader: async ({ context }) => {
    const noop = () => undefined;
    await Promise.all([
      context.queryClient.ensureInfiniteQueryData(inboxQueryOptions).catch(noop),
      context.queryClient.ensureQueryData(setupQueryOptions).catch(noop),
    ]);
  },
  component: InboxPage,
});

/** The selected chat as a read row, for a chat with nothing unread (a reload, Back, a deep link): the list keeps
 *  it in view. It sits at the top, from when it was selected. */
function useSelectedChat(agentRef: string | undefined): ChatRow | undefined {
  const agent = useQuery({
    ...agentDetailQueryOptions(agentRef ?? ""),
    enabled: agentRef !== undefined,
    refetchOnWindowFocus: false,
    select: (d) => d.agent,
  }).data;
  // Stamped once per selection (adjusted during render on a change), so the row doesn't move when the agent changes.
  const [stamped, setStamped] = useState<{ agentRef: string | undefined; at: string }>();
  if (stamped?.agentRef !== agentRef) setStamped({ agentRef, at: new Date().toISOString() });
  const stamp = stamped && stamped.agentRef === agentRef ? stamped.at : undefined;
  return useMemo(() => {
    if (!agent || !stamp) return undefined;
    return {
      agent: {
        ref: agent.ref,
        handle: agent.handle,
        displayName: agent.displayName,
        template: agent.template,
        avatarVersion: agent.avatarVersion,
        color: agent.color,
        kind: agent.kind,
        status: agent.status,
        archivedAt: agent.archivedAt,
      },
      unread: 0,
      firstUnreadId: "",
      latest: { messageId: "", preview: "", createdAt: stamp, urgent: false },
    };
  }, [agent, stamp]);
}

function InboxPage() {
  const button = useRef<HTMLButtonElement>(null);
  const lastReadAt = useRef<string>(undefined);
  const state = useMarkAllRead(button);
  const wide = useMedia(WIDE);
  const itemId = Route.useSearch({ select: (s) => s.item });
  const navigate = Route.useNavigate();
  const chatRef = wide ? chatRefOf(itemId) : undefined;
  const item = useLoadedItem(chatRef === undefined ? itemId : undefined);
  const selectedChat = useSelectedChat(chatRef);
  const showSetup = useQuery({ ...setupQueryOptions, select: (s) => s.hasAgent }).data === false;

  const onSelect = useCallback(
    (id: string, replace: boolean) => void navigate({ search: { item: id }, replace }),
    [navigate],
  );

  // Below 1024 rows navigate to their target; a notice that lives only in the Inbox opens full-width.
  if (!wide && itemId !== undefined) return <NarrowItem id={itemId} />;

  const header = (
    <PageHeader
      wrap
      title="Inbox"
      actions={<MarkAllReadButton state={state} buttonRef={button} />}
    />
  );
  // The live regions stay mounted (so the outcome is announced), but take room only with a line
  // in them: no empty strip above the list.
  const outcome = (
    <div className={state.outcome ? "pb-4" : undefined}>
      <MarkAllReadOutcome state={state} lastReadAt={lastReadAt} />
    </div>
  );
  if (wide)
    return (
      <div className="flex h-svh min-h-0 flex-col">
        {header}
        <div className="flex min-h-0 flex-1">
          <div className="w-[23.75rem] max-w-[45%] shrink-0 overflow-y-auto border-r border-border">
            <div className="py-4">
              {outcome}
              <InboxList
                showSetup={showSetup}
                selectedId={itemId}
                selectedChat={selectedChat}
                onSelect={onSelect}
              />
            </div>
          </div>
          <InboxPane showSetup={showSetup} selectedId={itemId} item={item} />
        </div>
      </div>
    );
  return (
    <>
      {header}
      <PageBody>
        {outcome}
        <InboxList showSetup={showSetup} />
      </PageBody>
    </>
  );
}
