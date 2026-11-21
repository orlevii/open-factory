import { Link } from "@tanstack/react-router";
import { type MouseEvent, memo, useMemo } from "react";
import { AgentChip } from "@/components/agent-chip";
import { formatInboxTime } from "@/features/session/format";
import { StatusLabel } from "@/features/tasks/status-label";
import { TaskBadge } from "@/features/tasks/task-badge";
import type { InboxItem } from "./api";
import { plainPreview } from "./preview";

const PREVIEW_MAX = 280;
const previewOf = (markdown: string) => {
  const s = plainPreview(markdown);
  return s.length > PREVIEW_MAX ? `${s.slice(0, PREVIEW_MAX)}…` : s;
};

/** The agent as a 16px chip, "Factory" (about whom) or the human's name: the first thing on line one. */
function Sender({ item }: { item: InboxItem }) {
  if (item.from.kind === "factory")
    return (
      <>
        <span className="shrink-0">Factory</span>
        {item.about && (
          <span className="min-w-0 truncate text-muted-foreground">
            about <span className="font-mono">@{item.about}</span>
          </span>
        )}
      </>
    );
  if (item.from.kind === "agent") return <AgentChip slug={item.from.name} size={16} />;
  return <span className="truncate font-mono">@{item.from.name}</span>;
}

/** Line one, left of the time: the sender and the kind word (what happened). It never wraps. */
function SenderLine({ item }: { item: InboxItem }) {
  const muted = item.read ? "text-muted-foreground" : "text-foreground";
  if (item.kind === "mention")
    return (
      <>
        <Sender item={item} />
        <span className="shrink-0 text-muted-foreground">
          {item.to === "@humans" ? (
            <>
              mentioned <span className="font-mono">@humans</span>
            </>
          ) : (
            "mentioned you"
          )}
        </span>
      </>
    );
  if (item.kind === "task_event")
    return (
      <>
        <Sender item={item} />
        {item.fact && <StatusLabel status={item.fact} />}
      </>
    );
  return (
    <>
      <Sender item={item} />
      {item.urgent && (
        <span className={`shrink-0 rounded-sm border border-border px-1.5 ${muted}`}>Urgent</span>
      )}
    </>
  );
}

/** Line two: the task (`T-6 · title`) or, for a message, the recipient. Truncates. */
function ContextLine({ item }: { item: InboxItem }) {
  const tone = item.read ? "text-muted-foreground" : "text-foreground";
  if (item.task)
    return (
      <span className={`flex min-w-0 ${tone}`}>
        <TaskBadge taskKey={item.task.key} title={item.task.title} />
      </span>
    );
  if (item.kind === "message")
    return <span className={`min-w-0 truncate font-mono ${tone}`}>→ {item.to}</span>;
  return null;
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

const LINK_CLASS =
  "of-row flex min-h-[4.5rem] flex-col justify-center gap-0.5 py-2 pr-2 pl-0 text-sm";

/**
 * One inbox row (shared with Home's panel): a single link, two lines, an ink dot in a fixed slot when unread.
 * Opening it (click, Cmd/Ctrl-click, middle-click via `onAuxClick`, Enter) calls `onOpen` and then follows the link.
 */
export const InboxRow = memo(function InboxRow({
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
  const preview = useMemo(() => previewOf(item.preview), [item.preview]);
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
          <span
            className={`flex min-w-0 items-center gap-x-1.5 overflow-hidden whitespace-nowrap ${item.read ? "text-muted-foreground" : ""}`}
          >
            <SenderLine item={item} />
          </span>
          <time
            dateTime={item.createdAt}
            title={at.toLocaleString()}
            className="shrink-0 font-normal tabular-nums text-muted-foreground"
          >
            {time}
          </time>
        </span>
        <ContextLine item={item} />
        <span
          id={previewId}
          className={`truncate text-[0.8125rem] leading-[1.125rem] ${item.read ? "text-muted-foreground" : "text-foreground"}`}
        >
          {preview}
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
});
