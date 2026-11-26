import { ApiError, type TaskActivity, type TaskDetail } from "@open-factory/shared";
import { tagOf } from "@open-factory/shared/tags";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AgentAvatar } from "@/components/agent-avatar";
import { AgentChip, PrincipalChip } from "@/components/agent-chip";
import { Button } from "@/components/ui/button";
import { AgentName } from "@/features/agents/agent-tree";
import { useHandle } from "@/features/agents/use-agent-index";
import { useAgentSummary } from "@/features/agents/use-agent-summary";
import { ViewSwitch } from "@/features/agents/view-switch";
import { ChatBody, type PaneOptions } from "@/features/chat/chat-view";
import { formatInboxTime } from "@/features/session/format";
import { StatusBadge } from "@/features/session/status-badge";
import { formatExpiryDate } from "@/features/settings/sign-in/expiry";
import { SetupBlock } from "@/features/setup/setup-steps";
import { sheetIntent } from "@/features/sheets/sheet-bodies";
import { openSheet } from "@/features/sheets/sheet-store";
import { taskDetailOptions } from "@/features/tasks/api";
import { CommentBlock } from "@/features/tasks/comment-block";
import { CommentComposer, type CommentComposerHandle } from "@/features/tasks/comment-composer";
import { StatusLabel } from "@/features/tasks/status-label";
import { INBOX_DWELL_MS, PREFETCH_REST_MS } from "@/lib/timing";
import { chatRefOf, type InboxItem, inboxQueryOptions, useOpenItem, usePaneItem } from "./api";
import { aboutOf } from "./credential-notice";
import { LoopHoldPane } from "./loop-hold-pane";

/** Static plates where a pane body will be. */
function ExcerptSkeleton() {
  return (
    <div data-pane-skeleton aria-hidden="true" className="grid gap-4">
      {[0, 1, 2, 3].map((n) => (
        <div key={n} className="grid gap-1.5">
          <div className="h-3 w-24 rounded-sm bg-muted" />
          <div className="h-3 w-full rounded-sm bg-muted" />
          <div className="h-3 w-2/3 rounded-sm bg-muted" />
        </div>
      ))}
    </div>
  );
}

/** The sender as the pane's header shows it: a 20px chip for an agent, otherwise the name. */
function Sender({ item }: { item: InboxItem }) {
  const about = aboutOf(item);
  if (item.from.kind === "agent") return <AgentChip agentRef={item.from.ref} size={20} />;
  if (item.from.kind === "factory")
    return (
      <span className="truncate">
        Factory
        {about && (
          <span className="text-muted-foreground">
            {" "}
            about <span className="font-mono">{about}</span>
          </span>
        )}
      </span>
    );
  return <span className="truncate font-mono">@{item.from.handle}</span>;
}

/** The exact target, as the row links it. */
function OpenLink({ item }: { item: InboxItem }) {
  return (
    <Button asChild variant="outline" size="sm" className="shrink-0">
      <OpenLinkTarget link={item.link} />
    </Button>
  );
}

function OpenLinkTarget({ link }: { link: InboxItem["link"] }) {
  switch (link.kind) {
    case "task":
      return (
        <Link
          to="/tasks/$key"
          params={{ key: link.key }}
          search={link.commentId ? { comment: link.commentId } : {}}
        >
          Open task
        </Link>
      );
    case "session":
      return link.seq === undefined ? (
        <Link to="/agents/$ref/chat" params={{ ref: link.agentRef }}>
          Open chat
        </Link>
      ) : (
        <Link
          to="/agents/$ref/session"
          params={{ ref: link.agentRef }}
          search={{ event: link.seq }}
        >
          Open in session
        </Link>
      );
    case "credential":
      return (
        <Link to="/settings/credentials" search={{ credential: link.name }}>
          Open credentials
        </Link>
      );
    default: {
      const unhandled: never = link;
      return unhandled;
    }
  }
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

/** Sending a reply marks the item read at once. */
function useMarkReplied(item: InboxItem) {
  const open = useOpenItem();
  return useCallback(() => open(item), [open, item]);
}

/**
 * The dwell (spec §11.1): an unread item is read once it has been shown for INBOX_DWELL_MS, however
 * it came to be shown (j/k, a deep link, Back/Forward). It fires at most once per shown item (the
 * pane remounts per item): moving on or unmounting first cancels it; so does the item turning read
 * while shown (a click, Enter or Space turns the cached row read at once). An item that turns
 * unread again while shown (a failed read rolled back, an Undo of Mark all read) is left unread.
 */
function useDwellRead(item: InboxItem | undefined) {
  const open = useOpenItem();
  const latest = useRef(item);
  useEffect(() => {
    latest.current = item;
  }, [item]);
  const done = useRef(false);
  const shown = item !== undefined;
  const unread = shown && !item.read;
  useEffect(() => {
    if (!shown || done.current) return;
    if (!unread) {
      done.current = true;
      return;
    }
    const timer = setTimeout(() => {
      done.current = true;
      if (latest.current) open(latest.current);
    }, INBOX_DWELL_MS);
    return () => clearTimeout(timer);
  }, [shown, unread, open]);
}

/** A factory notice: its text. It has no reply: the header's link opens the session at it. */
function NoticeContent({ item }: { item: InboxItem }) {
  return (
    <Body>
      <p className="max-w-[52rem] text-sm whitespace-pre-wrap [overflow-wrap:anywhere]">
        {item.preview}
      </p>
    </Body>
  );
}

/** A credential's expiry: the live fact from `expiresAt` (not the stored body), then Sign in again. No reply. */
function CredentialContent({
  item,
  link,
}: {
  item: InboxItem;
  link: Extract<InboxItem["link"], { kind: "credential" }>;
}) {
  const { name } = link;
  const intent = useMemo(
    () => sheetIntent("sign-in-again", { kind: "sign-in-again", name }),
    [name],
  );
  const credential = item.credential;
  const at = credential?.expiresAt ? new Date(credential.expiresAt) : undefined;
  // Read per render: the pane is not memoised.
  const fact = at
    ? `${name} ${at.getTime() <= Date.now() ? "expired" : "expires"} on ${formatExpiryDate(at)}.`
    : item.preview;
  return (
    <Body>
      <div className="grid max-w-[52rem] justify-items-start gap-3">
        <p className="text-sm [overflow-wrap:anywhere]">{fact}</p>
        {credential?.current === false ? (
          <p className={muted}>Already signed in again.</p>
        ) : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            {...intent}
            onClick={() => openSheet({ kind: "sign-in-again", name })}
          >
            Sign in again
          </Button>
        )}
      </div>
    </Body>
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
          <AgentChip agentRef={task.assignee.ref} name={task.assignee.displayName} size={16} />
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
    <div
      ref={list}
      className="grid grid-cols-[minmax(0,1fr)] gap-3 [&>[data-highlighted]]:scroll-mt-4"
    >
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
  const mention = item.from.kind === "agent" ? tagOf(item.from.ref) : undefined;
  // Once per item (the pane remounts this per item): only into an empty draft, as the task page does.
  useEffect(() => {
    if (mention) replyRef.current?.prefill(mention);
  }, [mention, replyRef]);
  const assignee = task.assignee && !task.assignee.ended ? task.assignee.ref : undefined;
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
    change?.type === "event" ? change.actor : item.from.kind === "factory" ? undefined : item.from;
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
          // One shrinkable track: a wide code block scrolls inside its comment, not the body sideways.
          <div className="grid grid-cols-[minmax(0,1fr)] gap-4">
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

/** The body by link kind; a new kind fails to compile here. */
function PaneBody({ item }: { item: InboxItem }) {
  if (item.notice === "loop_held" && item.loopHold)
    return <LoopHoldPane item={item} hold={item.loopHold} />;
  const link = item.link;
  switch (link.kind) {
    case "session":
      return <NoticeContent item={item} />;
    case "task":
      return <TaskContent item={item} link={link} />;
    case "credential":
      return <CredentialContent item={item} link={link} />;
    default: {
      const unhandled: never = link;
      return unhandled;
    }
  }
}

function PaneItem({
  id,
  loaded,
  rested,
}: {
  id: string;
  loaded: InboxItem | undefined;
  /** The body (and its fetches) waits until the selection has rested; the header doesn't. */
  rested: boolean;
}) {
  const { item, gone, failed } = usePaneItem(id, loaded);
  useDwellRead(item);
  return (
    <>
      <div className="flex min-h-12 shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b px-4 py-1 text-sm md:px-6">
        {item && (
          <>
            <span className="flex min-w-0 items-center gap-1.5">
              <Sender item={item} />
            </span>
            <time dateTime={item.createdAt} className="shrink-0 tabular-nums text-muted-foreground">
              {formatInboxTime(new Date(item.createdAt), new Date())}
            </time>
            <span className="ml-auto" />
            {item.notice !== "loop_held" && <OpenLink item={item} />}
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
      ) : !item || !rested ? (
        <Body>
          <ExcerptSkeleton />
        </Body>
      ) : (
        <PaneBody key={item.id} item={item} />
      )}
    </>
  );
}

/**
 * Whether the selection's body may load. A selection that follows one that had rested for
 * PREFETCH_REST_MS (a click, Enter, the first j/k, a deep link) loads at once; during a j/k sweep
 * the body waits until the selection rests, so the rows passed over send no request.
 */
function useRested(selectedId: string | undefined) {
  const [sel, setSel] = useState({ id: selectedId, now: true });
  const [settled, setSettled] = useState(false);
  // Adjusted during render on the change (no effect): `settled` still describes the previous one.
  if (selectedId !== sel.id) {
    setSel({ id: selectedId, now: settled || sel.id === undefined });
    setSettled(false);
  }
  useEffect(() => {
    if (selectedId === undefined) return;
    const timer = setTimeout(() => setSettled(true), PREFETCH_REST_MS);
    return () => clearTimeout(timer);
  }, [selectedId]);
  return sel.now || settled;
}

/** A chat's row when it was opened, once the Inbox has loaded: its unread count and newest message,
 *  which is where the Chat opens. */
function useOpenedUnread(agentRef: string): PaneOptions | undefined {
  const now = useInfiniteQuery({
    ...inboxQueryOptions,
    select: (d) => d.pages[0]?.chats?.find((c) => c.agent.ref === agentRef),
  });
  const [opened, setOpened] = useState<PaneOptions>();
  if (now.isSuccess && opened === undefined)
    setOpened({ unread: now.data?.unread ?? 0, latestId: now.data?.latest.messageId ?? "" });
  return opened;
}

/** The 40px strip over a chat in the pane: avatar, name, status, a link to the page and the view switch. */
function ChatStrip({ agentRef }: { agentRef: string }) {
  const agent = useAgentSummary(agentRef);
  const handle = useHandle(agentRef);
  return (
    <div
      data-chat-strip
      className="@container flex min-h-10 shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b px-4 py-1 text-sm md:px-6"
    >
      {agent ? (
        <>
          <AgentAvatar
            agentRef={agent.ref}
            template={agent.template}
            avatarVersion={agent.avatarVersion}
            color={agent.color}
            size={20}
          />
          <span className="flex min-w-0 font-medium">
            <AgentName agent={agent} />
          </span>
          <span className="shrink-0">
            <StatusBadge status={agent.status} size="short" />
          </span>
        </>
      ) : (
        <span className="min-w-0 truncate font-mono">@{handle}</span>
      )}
      <span className="ml-auto" />
      <Button asChild variant="outline" size="sm" className="shrink-0">
        <Link to="/agents/$ref/chat" params={{ ref: agentRef }}>
          Open chat
        </Link>
      </Button>
      <ViewSwitch agentRef={agentRef} view="chat" />
    </div>
  );
}

/** A chat in the pane: the Chat (thread and composer) under the strip. Keyed by agentRef, so a retarget
 *  swaps it instantly and nothing of the previous thread stays. It is read after the dwell. */
function ChatPane({ agentRef, rested }: { agentRef: string; rested: boolean }) {
  const pane = useOpenedUnread(agentRef);
  const qc = useQueryClient();
  return (
    <>
      <ChatStrip agentRef={agentRef} />
      {pane && rested ? (
        <ChatBody
          agentRef={agentRef}
          pane={pane}
          onRestored={() => void qc.invalidateQueries({ queryKey: ["agent", agentRef] })}
        />
      ) : (
        <Body>
          <ExcerptSkeleton />
        </Body>
      )}
    </>
  );
}

/**
 * The reading pane beside the list (≥1024, spec §11.2): a 48px header from the list row (so it swaps
 * at once), a scrolling body, and the reply composer pinned below it. Switching items swaps the
 * content at once: the body shows skeleton plates until its own data arrives (and, during a j/k
 * sweep, until the selection rests), never the previous item's body.
 */
export function InboxPane({
  selectedId,
  item,
  showSetup,
}: {
  /** Whether the first-run steps show: they take the pane while nothing is selected. */
  showSetup: boolean;
  selectedId: string | undefined;
  /** The selected row from the loaded pages, when it is there. */
  item: InboxItem | undefined;
}) {
  const rested = useRested(selectedId);
  const chat = chatRefOf(selectedId);
  return (
    <section aria-label="Reading pane" className="flex min-h-0 min-w-0 flex-1 flex-col">
      {selectedId === undefined ? (
        showSetup ? (
          <div className="max-w-[40rem] px-4 py-6 md:px-6">
            <SetupBlock />
          </div>
        ) : (
          <p className="px-4 py-6 text-sm text-muted-foreground md:px-6">No item selected.</p>
        )
      ) : chat ? (
        <ChatPane key={selectedId} agentRef={chat} rested={rested} />
      ) : (
        <PaneItem key={selectedId} id={selectedId} loaded={item} rested={rested} />
      )}
    </section>
  );
}
