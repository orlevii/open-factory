import { useQuery } from "@tanstack/react-query";
import { Link, Navigate } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { setupQueryOptions } from "@/features/setup/api";
import { chatRefOf, type InboxItem, isFullWidthNotice, useLoadedItem, usePaneItem } from "./api";
import { InboxPane } from "./inbox-pane";

const BACK = (
  <Button asChild variant="ghost" size="sm" className="-ml-2">
    <Link to="/inbox" search={{}}>
      <ArrowLeft aria-hidden="true" />
      Back
    </Link>
  </Button>
);

function BackBar() {
  return <div className="flex min-h-12 shrink-0 items-center border-b px-4 md:px-6">{BACK}</div>;
}

/** The item's own target: what its row opens below 1024px. */
function TargetNavigate({ link }: { link: InboxItem["link"] }) {
  switch (link.kind) {
    case "task":
      return (
        <Navigate
          to="/tasks/$key"
          params={{ key: link.key }}
          search={link.commentId ? { comment: link.commentId } : {}}
          replace
        />
      );
    case "session":
      return link.seq === undefined ? (
        <Navigate to="/agents/$ref/chat" params={{ ref: link.agentRef }} replace />
      ) : (
        <Navigate
          to="/agents/$ref/session"
          params={{ ref: link.agentRef }}
          search={{ event: link.seq }}
          replace
        />
      );
    case "credential":
      return <Navigate to="/settings/credentials" search={{ credential: link.name }} replace />;
    default: {
      const unhandled: never = link;
      return unhandled;
    }
  }
}

function Resolved({ id }: { id: string }) {
  const { item, gone, failed } = usePaneItem(id, useLoadedItem(id));
  const showSetup = useQuery({ ...setupQueryOptions, select: (s) => s.hasAgent }).data === false;
  if (item) {
    if (!isFullWidthNotice(item)) return <TargetNavigate link={item.link} />;
    return (
      <div className="flex h-svh min-h-0 flex-col">
        <BackBar />
        <InboxPane showSetup={showSetup} selectedId={id} item={item} />
      </div>
    );
  }
  return (
    <div className="flex h-svh min-h-0 flex-col">
      <BackBar />
      {gone || failed ? (
        <p className="px-4 py-6 text-sm text-muted-foreground md:px-6">
          {gone ? "This item no longer exists." : "Couldn't load this item."}
        </p>
      ) : (
        <div data-pane-skeleton aria-hidden="true" className="grid gap-4 px-4 py-4 md:px-6">
          {[0, 1, 2].map((n) => (
            <div key={n} className="h-3 w-full rounded-sm bg-muted" />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * `/inbox?item=<id>` below 1024px. A chat id goes to the Chat (no fetch); otherwise the item resolves
 * (the loaded pages, else by id) behind a skeleton, never the list; then a notice that lives only in the
 * Inbox opens its pane full-width, and any other kind replaces the URL with its own target.
 */
export function NarrowItem({ id }: { id: string }) {
  const chat = chatRefOf(id);
  if (chat) return <Navigate to="/agents/$ref/chat" params={{ ref: chat }} replace />;
  return <Resolved key={id} id={id} />;
}
