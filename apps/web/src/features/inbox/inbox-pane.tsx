import { ApiError, type TaskActivity, type TaskDetail } from "@open-factory/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { AgentChip, PrincipalChip } from "@/components/agent-chip";
import { Button } from "@/components/ui/button";
import { agentDetailQueryOptions, summaryFromAgentsList } from "@/features/session/api";
import { Composer, TerminatedComposer } from "@/features/session/composer";
import { formatInboxTime } from "@/features/session/format";
import { taskDetailOptions } from "@/features/tasks/api";
import { CommentBlock } from "@/features/tasks/comment-block";
import { CommentComposer, type CommentComposerHandle } from "@/features/tasks/comment-composer";
import { StatusLabel } from "@/features/tasks/status-label";
import { type InboxItem, inboxItemOptions, useOpenItem } from "./api";
import { ExcerptSkeleton, SessionExcerpt } from "./session-excerpt";

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

const BODY = "min-h-0 flex-1 overflow-y-auto px-4 py-4 md:px-6";
const muted = "text-sm text-muted-foreground";

/** The pane's scrolling body; whatever follows it in the pane (a composer) stays pinned below. */
function Body({ children }: { children: ReactNode }) {
  return (
    <div data-pane-body className={BODY}>
      {children}
    </div>
  );
}

/**
 * The item to show: the row from the loaded pages; else `GET /api/inbox/:id` (a deep link outside
 * them, or a row a refetch dropped). A row that drops out keeps showing while that fetch runs, so
 * the header never blanks; a 404 is `gone`.
 */
function usePaneItem(id: string, loaded: InboxItem | undefined) {
  const [kept, setKept] = useState(loaded);
  if (loaded && loaded !== kept) setKept(loaded);
  const fetched = useQuery({ ...inboxItemOptions(id), enabled: !loaded });
  const gone = !loaded && fetched.error instanceof ApiError && fetched.error.status === 404;
  // `kept` is always this id's row: PaneItem is keyed by id.
  const item = loaded ?? (gone ? undefined : (fetched.data ?? kept));
  return { item, gone, failed: !item && !gone && fetched.isError };
}

/** Sending a reply marks the item read at once (also its single-item copy, so a second send doesn't
 *  count it again). */
function useMarkReplied(item: InboxItem) {
  const open = useOpenItem();
  const qc = useQueryClient();
  return useCallback(() => {
    open(item);
    qc.setQueryData(inboxItemOptions(item.id).queryKey, (i) => i && { ...i, read: true });
  }, [open, qc, item]);
}

/** A message: the session excerpt at its target, and the composer to that session. */
function MessageContent({
  item,
  link,
}: {
  item: InboxItem;
  link: Extract<InboxItem["link"], { kind: "session" }>;
}) {
  // An errored top-level agent's notice comes from the factory: reply to the agent it is about.
  const slug = item.from.kind === "factory" && item.about ? item.about : link.agentSlug;
  const seq = slug === link.agentSlug ? link.seq : undefined;
  const qc = useQueryClient();
  // agentDetailQueryOptions is always stale (the session page reloads it); here the app default is
  // enough, as status frames patch this cache live: stepping through one agent's items fetches once.
  const detail = useQuery({
    ...agentDetailQueryOptions(slug),
    staleTime: 30_000,
    select: (d) => d.agent,
  });
  const agent = detail.data ?? summaryFromAgentsList(qc, slug);
  const replied = useMarkReplied(item);
  const [raceNotice, setRaceNotice] = useState<string>();
  return (
    <>
      <Body>
        <SessionExcerpt
          key={`${slug}:${seq ?? "latest"}`}
          slug={slug}
          seq={seq}
          spawned={agent?.kind === "ephemeral"}
        />
      </Body>
      {!agent ? null : agent.archivedAt !== null ? (
        <p className="shrink-0 border-t border-border px-4 py-3 text-sm text-muted-foreground md:px-6">
          This agent is archived.{" "}
          <Link
            to="/agents/$slug/edit"
            params={{ slug }}
            className="text-foreground underline underline-offset-4 decoration-muted-foreground hover:decoration-ring"
          >
            Restore it
          </Link>{" "}
          to send messages.
        </p>
      ) : agent.status === "terminated" ? (
        <TerminatedComposer key={slug} slug={slug} notice={raceNotice} />
      ) : (
        <Composer
          key={slug}
          slug={slug}
          agent={agent}
          onSent={replied}
          onTerminated={(notice) => {
            setRaceNotice(notice);
            void detail.refetch();
          }}
        />
      )}
    </>
  );
}

type Comment = Extract<TaskActivity, { type: "comment" }>;

function TaskHeader({ task }: { task: TaskDetail }) {
  return (
    <div className="grid gap-1.5">
      <p className="font-mono text-[0.8125rem] leading-[1.125rem] text-muted-foreground">
        {task.key}
      </p>
      <h2 className="min-w-0 font-heading text-base leading-6 font-[650] [overflow-wrap:anywhere]">
        {task.title}
      </h2>
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[0.8125rem] leading-[1.125rem]">
        <StatusLabel status={task.status} />
        {task.assignee && (
          <AgentChip slug={task.assignee.slug} name={task.assignee.displayName} size={16} />
        )}
      </div>
    </div>
  );
}

/** The mention's comment with the 3 comments before it (spec §11.2). */
function thread(activity: TaskActivity[], commentId: string | undefined): Comment[] {
  const comments = activity.filter((a): a is Comment => a.type === "comment");
  const i = comments.findIndex((c) => c.id === commentId);
  return i < 0 ? [] : comments.slice(Math.max(0, i - 3), i + 1);
}

function MentionThread({
  task,
  commentId,
  onReply,
}: {
  task: TaskDetail;
  commentId: string | undefined;
  onReply(mention: string): void;
}) {
  const comments = thread(task.activity, commentId);
  const list = useRef<HTMLDivElement>(null);
  const found = comments.length > 0;
  // Once the thread is in: the mentioned comment's top at the top of the body (spec §11.2, as the
  // message excerpt does), so the composer below never hides it. Layout; jsdom only sees the call.
  useLayoutEffect(() => {
    if (found)
      list.current?.querySelector("[data-highlighted]")?.scrollIntoView?.({ block: "start" });
  }, [found]);
  if (comments.length === 0) return <p className={muted}>This comment no longer exists.</p>;
  const now = new Date();
  return (
    <div ref={list} className="grid gap-3 [&>[data-highlighted]]:scroll-mt-4">
      {comments.map((c) => (
        <CommentBlock
          key={c.id}
          taskKey={task.key}
          comment={c}
          now={now}
          highlighted={c.id === commentId}
          onReply={onReply}
        />
      ))}
    </div>
  );
}

/** The comment composer under a mention, keyed by task (its draft is the task's), prefilled with
 *  `@author ` when an agent wrote the comment, as the task page does. */
function MentionReply({
  item,
  task,
  replyRef,
}: {
  item: InboxItem;
  task: TaskDetail;
  replyRef: RefObject<CommentComposerHandle | null>;
}) {
  const replied = useMarkReplied(item);
  const mention = item.from.kind === "agent" ? `@${item.from.name}` : undefined;
  // Once per item (the pane remounts this per item): only into an empty draft, as the task page does.
  useEffect(() => {
    if (mention) replyRef.current?.prefill(mention);
  }, [mention, replyRef]);
  const assignee = task.assignee && !task.assignee.ended ? task.assignee.slug : undefined;
  return (
    // Capped, scrolling within itself (the editor resizes): the body keeps most of the pane.
    <div
      data-pane-composer
      className="grid max-h-[45%] shrink-0 gap-2 overflow-y-auto border-t border-border px-4 py-3 md:px-6"
    >
      <CommentComposer
        compact
        key={task.key}
        ref={replyRef}
        taskKey={task.key}
        assignee={assignee}
        onPosted={replied}
      />
    </div>
  );
}

const FACT = { done: "Done", cancelled: "Cancelled" } as const;

/** "Done by @dev · 2m": from the task's status change when it is there, else from the item. */
function TaskFact({ item, task }: { item: InboxItem; task: TaskDetail }) {
  const fact = item.fact ?? (task.status === "cancelled" ? "cancelled" : "done");
  const change = task.activity.findLast(
    (a) => a.type === "event" && a.event === "status" && a.to === fact,
  );
  const by =
    change?.type === "event"
      ? change.actor
      : item.from.kind === "agent"
        ? { kind: "agent" as const, slug: item.from.name }
        : item.from.kind === "human"
          ? { kind: "user" as const, handle: item.from.name }
          : undefined;
  const when = change?.at ?? item.createdAt;
  return (
    <p data-testid="task-fact" className="min-w-0 text-sm">
      <span className="font-medium">{FACT[fact]}</span>
      {by && (
        <>
          {" "}
          <span className="text-muted-foreground">by</span>{" "}
          <span className="inline-flex max-w-full align-bottom">
            <PrincipalChip principal={by} size={16} />
          </span>
        </>
      )}{" "}
      <span className="text-muted-foreground">·</span>{" "}
      <time dateTime={when} className="tabular-nums text-muted-foreground">
        {formatInboxTime(new Date(when), new Date())}
      </time>
    </p>
  );
}

/** A mention or a task event: the task header, then the thread (and a composer) or the fact. */
function TaskContent({
  item,
  link,
}: {
  item: InboxItem;
  link: Extract<InboxItem["link"], { kind: "task" }>;
}) {
  const q = useQuery(taskDetailOptions(link.key));
  const reply = useRef<CommentComposerHandle>(null);
  const onReply = useCallback((m: string) => reply.current?.reply(m), []);
  const task = q.data;
  const isMention = item.kind === "mention";
  return (
    <>
      <Body>
        {task ? (
          <div className="grid gap-4">
            <TaskHeader task={task} />
            {isMention ? (
              <MentionThread task={task} commentId={link.commentId} onReply={onReply} />
            ) : (
              <TaskFact item={item} task={task} />
            )}
          </div>
        ) : q.isError ? (
          <p className={muted}>
            {q.error instanceof ApiError && q.error.status === 404
              ? "This task no longer exists."
              : "Couldn't load this task."}
          </p>
        ) : (
          <ExcerptSkeleton />
        )}
      </Body>
      {isMention && task && <MentionReply item={item} task={task} replyRef={reply} />}
    </>
  );
}

function PaneItem({ id, loaded }: { id: string; loaded: InboxItem | undefined }) {
  const { item, gone, failed } = usePaneItem(id, loaded);
  return (
    <>
      <div className="flex h-12 shrink-0 items-center gap-2 border-b px-4 text-sm md:px-6">
        {item && (
          <>
            <span className="flex min-w-0 items-center gap-1.5">
              <Sender item={item} />
            </span>
            <time dateTime={item.createdAt} className="shrink-0 tabular-nums text-muted-foreground">
              {formatInboxTime(new Date(item.createdAt), new Date())}
            </time>
            <span className="ml-auto" />
            <OpenLink item={item} />
          </>
        )}
      </div>
      {gone ? (
        <Body>
          <p className={muted}>This item no longer exists.</p>
        </Body>
      ) : failed ? (
        <Body>
          <p className={muted}>Couldn't load this item.</p>
        </Body>
      ) : !item ? (
        <Body>
          <ExcerptSkeleton />
        </Body>
      ) : item.link.kind === "session" ? (
        <MessageContent key={item.id} item={item} link={item.link} />
      ) : (
        <TaskContent key={item.id} item={item} link={item.link} />
      )}
    </>
  );
}

/**
 * The reading pane beside the list (≥1024, spec §11.2): a 48px header from the list row (so it swaps
 * at once), a scrolling body, and the reply composer pinned below it. Switching items swaps the
 * content at once: the body shows skeleton plates until its own data arrives, never the previous
 * item's body.
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
        <PaneItem key={selectedId} id={selectedId} loaded={item} />
      )}
    </section>
  );
}
