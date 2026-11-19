import { Link } from "@tanstack/react-router";
import { ArrowRight, CircleAlert } from "lucide-react";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { formatInboxTime } from "@/features/session/format";
import { type InboxItem, useInbox } from "./api";

const PREVIEW_MAX = 280;
const previewOf = (s: string) => (s.length > PREVIEW_MAX ? `${s.slice(0, PREVIEW_MAX)}…` : s);

/** "Factory about ops" for factory items, "dev" for agents; `@` added by the callers. */
function Sender({ item }: { item: InboxItem }) {
  if (item.from.kind === "factory")
    return (
      <>
        <span className="text-foreground">Factory</span>
        {item.about && (
          <span className="text-muted-foreground">
            {" "}
            about <span className="font-mono">@{item.about}</span>
          </span>
        )}
      </>
    );
  return <span className="font-mono text-foreground">@{item.from.name}</span>;
}

function Row({ item, now }: { item: InboxItem; now: Date }) {
  const at = new Date(item.createdAt);
  const time = formatInboxTime(at, now);
  const who =
    item.from.kind === "factory"
      ? `Factory${item.about ? ` about @${item.about}` : ""}`
      : `@${item.from.name}`;
  const label = `From ${who} to ${item.to}${item.urgent ? ", urgent" : ""}, ${time}`;
  const previewId = `inbox-preview-${item.id}`;
  const search = item.link.seq === undefined ? undefined : { event: item.link.seq };
  return (
    <li className="border-b border-border last:border-b-0">
      <Link
        to="/agents/$slug"
        params={{ slug: item.link.agentSlug }}
        search={search}
        data-inbox-id={item.id}
        aria-label={label}
        aria-describedby={previewId}
        className="flex min-h-14 flex-col justify-center gap-0.5 px-2 py-2 text-sm hover:bg-sidebar-accent focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        <span className="flex items-center gap-x-2 text-[0.8125rem] leading-[1.125rem]">
          <span className="flex min-w-0 flex-wrap items-center gap-x-1.5">
            <Sender item={item} />
            <ArrowRight aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="font-mono text-muted-foreground">{item.to}</span>
            {item.urgent && (
              <span className="rounded-sm border border-border px-1.5 text-foreground">Urgent</span>
            )}
          </span>
          <time
            dateTime={item.createdAt}
            title={at.toLocaleString()}
            className="ml-auto shrink-0 text-muted-foreground"
          >
            {time}
          </time>
        </span>
        <span
          id={previewId}
          className="line-clamp-2 text-muted-foreground md:line-clamp-1 [overflow-wrap:anywhere]"
        >
          {previewOf(item.preview)}
        </span>
      </Link>
    </li>
  );
}

const ErrorLine = ({
  text,
  onRetry,
  autoFocus,
}: {
  text: string;
  onRetry(): void;
  autoFocus?: boolean;
}) => (
  <div className="flex items-center gap-2 text-sm">
    <CircleAlert aria-hidden="true" className="size-4 shrink-0 text-destructive" />
    <span className="min-w-0 text-destructive">{text}</span>
    <Button variant="ghost" size="sm" onClick={onRetry} autoFocus={autoFocus}>
      Retry
    </Button>
  </div>
);

/** The Inbox: a plain list of links, one per message sent to the humans (and factory items), newest
 *  first. Arrow keys also move between rows; Tab reaches every row link as usual. */
export function InboxList() {
  const q = useInbox();
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
  const onKeyDown = (e: KeyboardEvent<HTMLUListElement>) => {
    const keys = ["ArrowDown", "ArrowUp", "Home", "End"];
    if (!keys.includes(e.key) || !(e.target instanceof HTMLAnchorElement)) return;
    const links = [...e.currentTarget.querySelectorAll<HTMLElement>("a")];
    const i = links.indexOf(e.target);
    const next =
      e.key === "Home"
        ? 0
        : e.key === "End"
          ? links.length - 1
          : Math.min(links.length - 1, Math.max(0, i + (e.key === "ArrowDown" ? 1 : -1)));
    e.preventDefault();
    links[next]?.focus();
  };
  const now = new Date();
  return (
    <div className="grid gap-4">
      <ul
        ref={list}
        aria-label="Inbox"
        onKeyDown={onKeyDown}
        className="border-y border-border [overflow-anchor:auto]"
      >
        {items.map((item) => (
          <Row key={item.id} item={item} now={now} />
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
