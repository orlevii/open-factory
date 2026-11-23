import { plainPreview } from "@open-factory/shared";
import { Link } from "@tanstack/react-router";
import { CircleAlert } from "lucide-react";
import { type ComponentProps, type MouseEvent, memo, type ReactNode, useMemo } from "react";
import { AgentChip } from "@/components/agent-chip";
import { formatInboxTime } from "@/features/session/format";
import { StatusLabel } from "@/features/tasks/status-label";
import { TaskBadge } from "@/features/tasks/task-badge";
import { skipFocusPreload } from "@/lib/row-nav";
import type { InboxItem } from "./api";
import { aboutOf, credentialLine } from "./credential-notice";

const PREVIEW_MAX = 280;
const previewOf = (markdown: string) => {
  const s = plainPreview(markdown);
  return s.length > PREVIEW_MAX ? `${s.slice(0, PREVIEW_MAX)}…` : s;
};

/** The agent as a 16px chip, "Factory" (about whom) or the human's name: the first thing on line one. */
function Sender({ item }: { item: InboxItem }) {
  const about = aboutOf(item);
  if (item.from.kind === "factory")
    return (
      <>
        <span className="shrink-0">Factory</span>
        {about && (
          <span className="min-w-0 truncate text-muted-foreground">
            about <span className="font-mono">{about}</span>
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
        <span className="shrink-0 text-muted-foreground">mentioned you</span>
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
        // 16px of text inside the border: the badge fits line one's 18px.
        <span className={`shrink-0 rounded-sm border border-border px-1.5 leading-4 ${muted}`}>
          Urgent
        </span>
      )}
    </>
  );
}

const LINE_TONE = {
  muted: "text-muted-foreground",
  warning: "text-warning",
  crimson: "text-destructive",
} as const;

/** Line two: the task (`T-6 · title`) or, for a message, the recipient unless it is the viewer. Truncates. */
function ContextLine({
  item,
  now,
  viewer,
}: {
  item: InboxItem;
  now: number;
  viewer: string | undefined;
}) {
  const tone = item.read ? "text-muted-foreground" : "text-foreground";
  if (item.kind === "credential") {
    // Live from `expiresAt` and the `now` prop, like the Credentials row; never truncated.
    const line = credentialLine(item, new Date(now));
    return (
      <span className={`flex items-start gap-1.5 ${LINE_TONE[line.tone]}`}>
        {line.tone !== "muted" && (
          <CircleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
        )}
        <span>{line.text}</span>
      </span>
    );
  }
  if (item.task)
    return (
      <span className={`flex min-w-0 ${tone}`}>
        <TaskBadge taskKey={item.task.key} title={item.task.title} />
      </span>
    );
  if (item.kind === "notice" && !(viewer && item.to === `@${viewer}`))
    return <span className={`min-w-0 truncate font-mono ${tone}`}>→ {item.to}</span>;
  return null;
}

function labelOf(item: InboxItem, time: string, now: number): string {
  const unread = item.read ? "" : "Unread, ";
  if (item.kind === "credential") {
    const { text } = credentialLine(item, new Date(now));
    const name = aboutOf(item) ?? "";
    return `${unread}Factory, ${name} ${text.charAt(0).toLowerCase()}${text.slice(1)}, ${time}`;
  }
  const task = item.task ? `${item.task.key} ${item.task.title}` : "";
  if (item.kind === "mention") {
    return `${unread}@${item.from.name} mentioned you on ${task}, ${time}`;
  }
  if (item.kind === "task_event")
    return `${unread}Factory, ${item.fact === "cancelled" ? "cancelled" : "done"}, ${task}, ${time}`;
  const who =
    item.from.kind === "factory"
      ? `Factory${item.about ? ` about @${item.about}` : ""}`
      : `@${item.from.name}`;
  return `${unread}From ${who} to ${item.to}${item.urgent ? ", urgent" : ""}, ${time}`;
}

// A grid row's single track would stretch to the 4.5rem minimum, and the lines' auto tracks with it
// (a two-line row's line one grew to 27px): `content-center` keeps the track at its content and
// centres it, so line one is always one 18px line with the time on the name's baseline.
export const LINK_CLASS = "of-row grid min-h-[4.5rem] content-center py-2 pr-2 pl-0 text-sm";

/**
 * One inbox row: a single link, three lines, an ink dot in a fixed slot when unread.
 * Opening it (click, Cmd/Ctrl-click, middle-click via `onAuxClick`, Enter) calls `onOpen`, which may
 * `preventDefault` to select the row instead of following the link.
 */
export const InboxRow = memo(function InboxRow({
  item,
  now,
  onOpen,
  selected = false,
  selectable = false,
  viewer,
}: {
  item: InboxItem;
  /** Epoch ms rounded to the minute: a primitive, so a row that didn't change doesn't render. */
  now: number;
  onOpen(item: InboxItem, e: MouseEvent): void;
  /** The reading pane shows this row. */
  selected?: boolean;
  /** A plain click selects rather than navigates, so the link's target isn't preloaded on hover or focus
   *  (a j/k sweep would otherwise start a loader per row). */
  selectable?: boolean;
  /** The viewer's handle: a message to them doesn't repeat "→ @them". */
  viewer?: string;
}) {
  const at = new Date(item.createdAt);
  const time = formatInboxTime(at, new Date(now));
  const previewId = `inbox-preview-${item.id}`;
  const preview = useMemo(() => previewOf(item.preview), [item.preview]);
  const common: RowCommon = {
    "data-inbox-id": item.id,
    "aria-label": labelOf(item, time, now),
    "aria-describedby": previewId,
    "aria-current": selected ? ("true" as const) : undefined,
    preload: selectable ? (false as const) : undefined,
    // Below 1024 rows keep hover preload, but a keyboard sweep through them preloads nothing.
    onFocus: skipFocusPreload,
    onClick: (e: MouseEvent) => onOpen(item, e),
    // Middle-click only: Chrome fires auxclick for the right button too, and opening the context
    // menu must not mark the row read.
    onAuxClick: (e: MouseEvent) => {
      if (e.button === 1) onOpen(item, e);
    },
    className: `${LINK_CLASS} grid-cols-[0.75rem_minmax(0,1fr)] gap-x-2 px-2`,
  };
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
        <ContextLine item={item} now={now} viewer={viewer} />
        <span
          id={previewId}
          className={`truncate text-[0.8125rem] leading-[1.125rem] ${item.read ? "text-muted-foreground" : "text-foreground"}`}
        >
          {preview}
        </span>
      </span>
    </>
  );
  return (
    <li className="border-b border-border last:border-b-0">
      <RowLink link={item.link} common={common}>
        {body}
      </RowLink>
    </li>
  );
});

type RowCommon = Omit<ComponentProps<typeof Link>, "to" | "params" | "search" | "children"> &
  Record<`data-${string}`, string>;

/** The row's link, by kind; a new kind fails to compile here. */
function RowLink({
  link,
  common,
  children,
}: {
  link: InboxItem["link"];
  common: RowCommon;
  children: ReactNode;
}) {
  switch (link.kind) {
    case "task":
      return (
        <Link
          to="/tasks/$key"
          params={{ key: link.key }}
          search={link.commentId ? { comment: link.commentId } : {}}
          {...common}
        >
          {children}
        </Link>
      );
    case "session":
      return link.seq === undefined ? (
        <Link to="/agents/$slug/chat" params={{ slug: link.agentSlug }} {...common}>
          {children}
        </Link>
      ) : (
        <Link
          to="/agents/$slug/session"
          params={{ slug: link.agentSlug }}
          search={{ event: link.seq }}
          {...common}
        >
          {children}
        </Link>
      );
    case "credential":
      return (
        <Link to="/settings/credentials" search={{ credential: link.name }} {...common}>
          {children}
        </Link>
      );
    default: {
      const unhandled: never = link;
      return unhandled;
    }
  }
}
