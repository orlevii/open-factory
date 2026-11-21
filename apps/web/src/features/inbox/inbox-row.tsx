import { Link } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";
import type { MouseEvent, ReactNode } from "react";
import { formatInboxTime } from "@/features/session/format";
import { StatusLabel } from "@/features/tasks/status-label";
import { TaskBadge } from "@/features/tasks/task-badge";
import type { InboxItem } from "./api";

const PREVIEW_MAX = 280;
const previewOf = (s: string) => (s.length > PREVIEW_MAX ? `${s.slice(0, PREVIEW_MAX)}…` : s);

const Mono = ({ children }: { children: ReactNode }) => (
  <span className="font-mono text-foreground">{children}</span>
);

/** "Factory about ops" for factory items, "dev" for agents, `@alice` for humans. */
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
  return <Mono>@{item.from.name}</Mono>;
}

/** The part of the sender line before the badge, by kind (UI design §3). It never truncates. */
function SenderLine({ item }: { item: InboxItem }) {
  if (item.kind === "mention")
    return (
      <>
        <Sender item={item} />
        <span className="text-muted-foreground">
          {item.to === "@humans" ? (
            <>
              {" "}
              mentioned <span className="font-mono">@humans</span>
            </>
          ) : (
            " mentioned you"
          )}
        </span>
        {item.task && <TaskBadge taskKey={item.task.key} title={item.task.title} />}
      </>
    );
  if (item.kind === "task_event")
    return (
      <>
        <Sender item={item} />
        {item.fact && <StatusLabel status={item.fact} />}
        {item.task && <TaskBadge taskKey={item.task.key} title={item.task.title} />}
      </>
    );
  return (
    <>
      <Sender item={item} />
      <ArrowRight aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="font-mono text-muted-foreground">{item.to}</span>
      {item.urgent && (
        <span className="rounded-sm border border-border px-1.5 text-foreground">Urgent</span>
      )}
    </>
  );
}

function labelOf(item: InboxItem, time: string): string {
  const unread = item.read ? "" : "Unread, ";
  const task = item.task ? `${item.task.key} ${item.task.title}` : "";
  if (item.kind === "mention") {
    const what = item.to === "@humans" ? "mentioned @humans" : "mentioned you";
    return `${unread}@${item.from.name} ${what} on ${task}, ${time}`;
  }
  if (item.kind === "task_event")
    return `${unread}Factory, ${item.fact === "cancelled" ? "cancelled" : "done"}, ${task}, ${time}`;
  const who =
    item.from.kind === "factory"
      ? `Factory${item.about ? ` about @${item.about}` : ""}`
      : `@${item.from.name}`;
  return `${unread}From ${who} to ${item.to}${item.urgent ? ", urgent" : ""}, ${time}`;
}

const LINK_CLASS = "of-row flex min-h-14 flex-col justify-center gap-0.5 py-2 pr-2 pl-0 text-sm";

/**
 * One inbox row (shared with Home's panel): a single link, two lines, an ink dot in a fixed slot when unread.
 * Opening it (click, Cmd/Ctrl-click, middle-click via `onAuxClick`, Enter) calls `onOpen` and then follows the link.
 */
export function InboxRow({
  item,
  now,
  onOpen,
}: {
  item: InboxItem;
  now: Date;
  onOpen(item: InboxItem): void;
}) {
  const at = new Date(item.createdAt);
  const time = formatInboxTime(at, now);
  const previewId = `inbox-preview-${item.id}`;
  const common = {
    "data-inbox-id": item.id,
    "aria-label": labelOf(item, time),
    "aria-describedby": previewId,
    onClick: () => onOpen(item),
    // Middle-click only: Chrome fires auxclick for the right button too, and opening the context
    // menu must not mark the row read.
    onAuxClick: (e: MouseEvent) => {
      if (e.button === 1) onOpen(item);
    },
    className: `${LINK_CLASS} grid grid-cols-[0.75rem_minmax(0,1fr)] gap-x-2 px-2`,
  } as const;
  const body = (
    <>
      <span
        aria-hidden="true"
        className="flex items-center justify-center self-start pt-[0.4375rem]"
      >
        {!item.read && <span className="size-1.5 rounded-full bg-foreground" />}
      </span>
      <span className="grid min-w-0 gap-0.5">
        <span
          className={`grid grid-cols-[minmax(0,1fr)_auto] gap-2 text-[0.8125rem] leading-[1.125rem] ${item.read ? "" : "font-medium"}`}
        >
          <span className="flex min-w-0 flex-wrap items-center gap-x-1.5">
            <SenderLine item={item} />
          </span>
          <time
            dateTime={item.createdAt}
            title={at.toLocaleString()}
            className="shrink-0 font-normal text-muted-foreground"
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
      </span>
    </>
  );
  const link = item.link;
  return (
    <li className="border-b border-border last:border-b-0">
      {link.kind === "task" ? (
        <Link
          to="/tasks/$key"
          params={{ key: link.key }}
          search={link.commentId ? { comment: link.commentId } : {}}
          {...common}
        >
          {body}
        </Link>
      ) : (
        <Link
          to="/agents/$slug"
          params={{ slug: link.agentSlug }}
          search={link.seq === undefined ? undefined : { event: link.seq }}
          {...common}
        >
          {body}
        </Link>
      )}
    </li>
  );
}
