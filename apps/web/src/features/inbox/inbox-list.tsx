import { useEffect, useRef, useState } from "react";
import { EmptyState } from "@/components/empty-state";
import { ErrorLine } from "@/components/error-line";
import { Button } from "@/components/ui/button";
import { onRowKeyDown } from "@/lib/row-nav";
import { useInbox, useOpenItem } from "./api";
import { InboxRow } from "./inbox-row";

/** The Inbox: a plain list of links, one per message sent to the humans (and factory items), newest
 *  first. Arrow keys also move between rows; Tab reaches every row link as usual. */
export function InboxList() {
  const q = useInbox();
  const open = useOpenItem();
  const items = q.data;
  const list = useRef<HTMLUListElement>(null);
  // Pending focus, set only once a fetch has settled successfully: the control that was pressed may
  // have unmounted. A row id means "the row after it" (the last row when nothing new arrived);
  // "first" is the first row. Never armed by an error, so a later refetch can't steal focus.
  const [focusAfter, setFocusAfter] = useState<string | "first" | null>(null);
  useEffect(() => {
    if (focusAfter === null) return;
    setFocusAfter(null);
    const links = [...(list.current?.querySelectorAll<HTMLElement>("a") ?? [])];
    const i =
      focusAfter === "first" ? 0 : links.findIndex((l) => l.dataset.inboxId === focusAfter) + 1;
    (links[i] ?? links.at(-1))?.focus();
  }, [focusAfter]);

  if (!items)
    return q.isError ? (
      <ErrorLine
        text="Couldn't load the inbox."
        onRetry={() =>
          void q.refetch().then((r) => {
            if (r.isSuccess) setFocusAfter("first");
          })
        }
      />
    ) : null;
  if (items.length === 0) return <EmptyState text="Nothing in your inbox." />;

  const loadEarlier = () => {
    const last = items.at(-1)?.id;
    void q.fetchNextPage().then((r) => {
      if (r.isSuccess && last !== undefined) setFocusAfter(last);
    });
  };
  const now = new Date();
  return (
    <div className="grid gap-4">
      <ul
        ref={list}
        aria-label="Inbox"
        onKeyDown={onRowKeyDown}
        className="border-y border-border [overflow-anchor:auto]"
      >
        {items.map((item) => (
          <InboxRow key={item.id} item={item} now={now} onOpen={open} />
        ))}
      </ul>
      {q.isFetchNextPageError ? (
        <ErrorLine text="Couldn't load earlier messages." onRetry={loadEarlier} autoFocus />
      ) : (
        q.hasNextPage && (
          <div>
            <Button variant="ghost" onClick={loadEarlier} disabled={q.isFetchingNextPage}>
              Load earlier
            </Button>
          </div>
        )
      )}
    </div>
  );
}
