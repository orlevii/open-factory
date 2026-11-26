import type { TaskActivity as Activity, TaskPrincipal } from "@open-factory/shared";
import { memo } from "react";
import { formatInboxTime } from "@/features/session/format";
import { AgentLink } from "@/features/session/message-block";
import { QuietLine } from "@/features/session/quiet-line";
import { CommentBlock } from "./comment-block";
import { STATUS } from "./status-label";

type Event = Extract<Activity, { type: "event" }>;

const Who = ({ p }: { p: TaskPrincipal }) =>
  p.kind === "agent" ? (
    <AgentLink slug={p.handle} />
  ) : (
    <span className="font-mono">@{p.handle}</span>
  );

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/** The history line for one structured event, never built from prose (UI design §7). */
function EventText({ e }: { e: Event }) {
  const from = e.from as unknown;
  const to = e.to as unknown;
  switch (e.event) {
    case "created":
      return <>created this task</>;
    case "assignee":
      return typeof to === "string" ? (
        <>
          assigned <span className="font-mono">@{to}</span>
        </>
      ) : (
        <>
          unassigned <span className="font-mono">@{String(from)}</span>
        </>
      );
    case "status": {
      const f = from as string;
      const t = to as keyof typeof STATUS;
      if (t === "done") return <>marked this done</>;
      if (t === "cancelled") return <>cancelled this</>;
      if (f === "done" || f === "cancelled") return <>reopened this</>;
      return <>moved this to {STATUS[t].sentence}</>;
    }
    case "title":
      return <>renamed this from “{String(from)}”</>;
    case "body":
      return <>edited the description</>;
    case "depends_on": {
      const before = strings(from);
      const after = strings(to);
      const added = after.filter((k) => !before.includes(k));
      const removed = before.filter((k) => !after.includes(k));
      const parts = [
        ...(added.length ? [`added ${added.join(", ")}`] : []),
        ...(removed.length ? [`removed ${removed.join(", ")}`] : []),
      ];
      return <>changed the dependencies{parts.length ? `: ${parts.join(", ")}` : ""}</>;
    }
    case "links":
      return <>changed the links</>;
  }
}

/**
 * Comments and history, oldest first (UI design §7). Memoized: the page re-renders on its own
 * state (announcements, saves), and each comment renders markdown, so it waits for new items.
 */
export const TaskActivity = memo(function TaskActivity({
  taskKey,
  items,
  highlightedId,
  onReply,
  notFoundLine,
}: {
  taskKey: string;
  items: Activity[];
  highlightedId: string | undefined;
  onReply(mention: string): void;
  notFoundLine: boolean;
}) {
  const now = new Date();
  return (
    <section className="grid grid-cols-[minmax(0,1fr)] gap-3">
      <h2 className="text-[0.8125rem] font-medium text-muted-foreground">Activity</h2>
      {notFoundLine && (
        <p className="text-[0.8125rem] leading-[1.125rem] text-muted-foreground">
          Comment not found. Showing the task.
        </p>
      )}
      <ol aria-label="Activity" className="grid grid-cols-[minmax(0,1fr)] gap-3">
        {items.map((a) => (
          <li key={a.id}>
            {a.type === "comment" ? (
              <CommentBlock
                taskKey={taskKey}
                comment={a}
                now={now}
                highlighted={a.id === highlightedId}
                onReply={onReply}
              />
            ) : (
              <QuietLine>
                <Who p={a.actor} /> <EventText e={a} />
                {" · "}
                <time dateTime={a.at} title={new Date(a.at).toLocaleString()}>
                  {formatInboxTime(new Date(a.at), now)}
                </time>
              </QuietLine>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
});
