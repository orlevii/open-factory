import type { ChatRow } from "@open-factory/shared";
import { Link } from "@tanstack/react-router";
import { type MouseEvent, memo } from "react";
import { AgentChip } from "@/components/agent-chip";
import { ROW_GRID } from "@/components/row-grid";
import { formatInboxTime } from "@/features/session/format";
import { skipFocusPreload } from "@/lib/row-nav";
import { chatRowId } from "./api";
import { LINK_CLASS } from "./inbox-row";

const COUNT = new Intl.NumberFormat();

/** What an ended agent's row says beside the name. */
const ended = (a: ChatRow["agent"]): string | undefined =>
  a.status === "terminated" ? "terminated" : a.archivedAt !== null ? "archived" : undefined;

/**
 * One unread chat as an Inbox row (I1 §6.7): the item row's anatomy. Line one is the agent (16px chip,
 * its handle in the tooltip, a spawned agent keeps `· ab12`), a muted "· 3 new", Urgent, "archived" or
 * "terminated" when ended, and the time. Only the name truncates; the rest never shrink. Line two is the
 * preview. A chat with no count (read, held in the list) shows read.
 */
export const ChatInboxRow = memo(function ChatInboxRow({
  row,
  now,
  onOpen,
  selected,
  selectable,
}: {
  row: ChatRow;
  /** Epoch ms rounded to the minute. */
  now: number;
  onOpen(slug: string, e: MouseEvent): void;
  selected: boolean;
  /** A plain click selects (the pane), so the link's target isn't preloaded. */
  selectable: boolean;
}) {
  const { agent, unread, latest } = row;
  const read = unread === 0;
  const at = new Date(latest.createdAt);
  const time = formatInboxTime(at, new Date(now));
  const previewId = `inbox-preview-chat-${agent.slug}`;
  const state = ended(agent);
  const count = read ? "" : `${COUNT.format(unread)} new`;
  const label = [
    read ? "" : "Unread",
    agent.displayName,
    count,
    latest.urgent && !read ? "urgent" : "",
    state ?? "",
    time,
  ]
    .filter(Boolean)
    .join(", ");
  const tone = read ? "text-muted-foreground" : "text-foreground";
  return (
    <li className="border-b border-border last:border-b-0">
      <Link
        to="/agents/$slug/chat"
        params={{ slug: agent.slug }}
        data-inbox-id={chatRowId(agent.slug)}
        data-chat-row=""
        data-row=""
        aria-label={label}
        aria-describedby={previewId}
        aria-current={selected ? "true" : undefined}
        preload={selectable ? false : undefined}
        onFocus={skipFocusPreload}
        onClick={(e) => onOpen(agent.slug, e)}
        className={`${LINK_CLASS} ${ROW_GRID}`}
      >
        <span
          aria-hidden="true"
          className="flex items-center justify-center self-start pt-[0.4375rem]"
        >
          {!read && <span className="size-1.5 rounded-full bg-foreground" />}
        </span>
        <span className="grid min-w-0 gap-0.5">
          <span
            className={`grid grid-cols-[minmax(0,1fr)_auto] gap-2 text-[0.8125rem] leading-[1.125rem] ${read ? "" : "font-medium"}`}
          >
            <span
              className={`flex min-w-0 items-center gap-x-1.5 overflow-hidden whitespace-nowrap ${read ? "text-muted-foreground" : ""}`}
            >
              <AgentChip agent={agent} size={16} handleInTooltip />
              {!read && (
                <span className="shrink-0 font-normal text-muted-foreground">· {count}</span>
              )}
              {latest.urgent && !read && (
                <span
                  className={`shrink-0 rounded-sm border border-border px-1.5 leading-4 ${tone}`}
                >
                  Urgent
                </span>
              )}
              {state && <span className="shrink-0 font-normal text-muted-foreground">{state}</span>}
            </span>
            <time
              dateTime={latest.createdAt}
              title={at.toLocaleString()}
              className="shrink-0 font-normal tabular-nums text-muted-foreground"
            >
              {time}
            </time>
          </span>
          <span id={previewId} className={`truncate text-[0.8125rem] leading-[1.125rem] ${tone}`}>
            {latest.preview}
          </span>
        </span>
      </Link>
    </li>
  );
});
