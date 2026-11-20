import { useQuery } from "@tanstack/react-query";
import { EmptyState } from "@/components/empty-state";
import { onRowKeyDown } from "@/lib/row-nav";
import { homeInboxQueryOptions, useOpenItem } from "./api";
import { InboxRow } from "./inbox-row";

/** Home's Inbox panel: the 5 newest unread items with the inbox row and its opening behaviour. */
export function HomeInbox() {
  const { data: items } = useQuery(homeInboxQueryOptions);
  const open = useOpenItem();
  if (!items) return null;
  if (items.length === 0) return <EmptyState text="Nothing unread." />;
  const now = new Date();
  return (
    <ul aria-label="Unread inbox" onKeyDown={onRowKeyDown} className="-mx-2 -my-2">
      {items.map((i) => (
        <InboxRow key={i.id} item={i} now={now} onOpen={open} />
      ))}
    </ul>
  );
}
