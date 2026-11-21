import { Link } from "@tanstack/react-router";
import { AgentChip } from "@/components/agent-chip";
import { Button } from "@/components/ui/button";
import { formatInboxTime } from "@/features/session/format";
import type { InboxItem } from "./api";

/** The sender as the pane's header shows it: a 20px chip for an agent, otherwise the name. */
function Sender({ item }: { item: InboxItem }) {
  if (item.from.kind === "agent") return <AgentChip slug={item.from.name} size={20} />;
  if (item.from.kind === "factory")
    return (
      <span className="truncate">
        Factory
        {item.about && (
          <span className="text-muted-foreground">
            {" "}
            about <span className="font-mono">@{item.about}</span>
          </span>
        )}
      </span>
    );
  return <span className="truncate font-mono">@{item.from.name}</span>;
}

/** The exact target, as the row links it. */
function OpenLink({ item }: { item: InboxItem }) {
  const link = item.link;
  return (
    <Button asChild variant="outline" size="sm" className="shrink-0">
      {link.kind === "task" ? (
        <Link
          to="/tasks/$key"
          params={{ key: link.key }}
          search={link.commentId ? { comment: link.commentId } : {}}
        >
          Open task
        </Link>
      ) : (
        <Link
          to="/agents/$slug"
          params={{ slug: link.agentSlug }}
          search={link.seq === undefined ? undefined : { event: link.seq }}
        >
          Open in session
        </Link>
      )}
    </Button>
  );
}

/** Static plates at row heights while the body's data loads; never the previous item's body. */
function BodySkeleton() {
  return (
    <div data-pane-skeleton aria-hidden="true" className="grid gap-3 px-4 py-4 md:px-6">
      {[0, 1, 2].map((n) => (
        <div key={n} className="grid gap-1.5">
          <div className="h-3 w-24 rounded-sm bg-muted" />
          <div className="h-3 w-full rounded-sm bg-muted" />
          <div className="h-3 w-2/3 rounded-sm bg-muted" />
        </div>
      ))}
    </div>
  );
}

/**
 * The reading pane beside the list (≥1024). Its header comes from the list row, so it swaps at once; the
 * body is a skeleton here (its content arrives with the pane-content task).
 */
export function InboxPane({
  selectedId,
  item,
}: {
  selectedId: string | undefined;
  /** The selected row from the loaded pages, when it is there. */
  item: InboxItem | undefined;
}) {
  return (
    <section aria-label="Reading pane" className="flex min-h-0 min-w-0 flex-1 flex-col">
      {selectedId === undefined ? (
        <p className="px-4 py-6 text-sm text-muted-foreground md:px-6">No item selected.</p>
      ) : (
        <>
          <div className="flex h-12 shrink-0 items-center gap-2 border-b px-4 text-sm md:px-6">
            {item && (
              <>
                <span className="flex min-w-0 items-center gap-1.5">
                  <Sender item={item} />
                </span>
                <time
                  dateTime={item.createdAt}
                  className="shrink-0 tabular-nums text-muted-foreground"
                >
                  {formatInboxTime(new Date(item.createdAt), new Date())}
                </time>
                <span className="ml-auto" />
                <OpenLink item={item} />
              </>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <BodySkeleton />
          </div>
        </>
      )}
    </section>
  );
}
