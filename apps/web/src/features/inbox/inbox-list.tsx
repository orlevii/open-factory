import { Link } from "@tanstack/react-router";
import { ArrowRight, CircleAlert } from "lucide-react";
import { type KeyboardEvent, useEffect, useRef } from "react";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { formatResetTime } from "@/features/session/format";
import { type InboxItem, useInbox } from "./api";

const PREVIEW_MAX = 280;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n: number) => String(n).padStart(2, "0");

/** Past time for a row (S6 UI design §4): `14:32` today, `Yesterday 14:32`, `27 Nov 09:10`, and
 *  `27 Nov 2025 09:10` for another year. Future times (clock skew) fall back to S5's format. */
export function formatInboxTime(at: Date, now: Date): string {
  const hhmm = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  const day = (d: Date) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  const days = Math.round((day(now) - day(at)) / 86_400_000);
  if (days < 0) return formatResetTime(at, now);
  if (days === 0) return hhmm;
  if (days === 1) return `Yesterday ${hhmm}`;
  const date = `${at.getDate()} ${MONTHS[at.getMonth()]}`;
  return at.getFullYear() === now.getFullYear()
    ? `${date} ${hhmm}`
    : `${date} ${at.getFullYear()} ${hhmm}`;
}

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
        aria-label={label}
        aria-describedby={previewId}
        className="flex min-h-14 flex-col justify-center gap-0.5 px-2 py-2 text-sm transition-colors duration-100 hover:bg-sidebar-accent"
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

const ErrorLine = ({ text, onRetry }: { text: string; onRetry(): void }) => (
  <div className="flex items-center gap-2 text-sm">
    <CircleAlert aria-hidden="true" className="size-4 shrink-0 text-destructive" />
    <span className="min-w-0">{text}</span>
    <Button variant="ghost" size="sm" onClick={onRetry}>
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
  // After a page loads, focus moves to its first new row: the button that was pressed may be gone.
  const focusFrom = useRef<number | null>(null);
  useEffect(() => {
    const from = focusFrom.current;
    if (from === null || !items || items.length <= from) return;
    focusFrom.current = null;
    list.current?.querySelectorAll<HTMLElement>("a")[from]?.focus();
  }, [items]);

  if (!items)
    return q.isError ? (
      <ErrorLine text="Couldn't load the inbox." onRetry={() => void q.refetch()} />
    ) : null;
  if (items.length === 0) return <EmptyState text="Nothing in your inbox." />;

  const loadEarlier = () => {
    focusFrom.current = items.length;
    void q.fetchNextPage();
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
        <ErrorLine text="Couldn't load earlier messages." onRetry={loadEarlier} />
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
