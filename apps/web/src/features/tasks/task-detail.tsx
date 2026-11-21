import {
  ApiError,
  type TaskDetail as Detail,
  taskBodySchema,
  taskTitleSchema,
} from "@open-factory/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Markdown } from "@/components/markdown/markdown";
import { MarkdownEditor } from "@/components/markdown/markdown-editor";
import { PageBody, PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { agentsListQueryOptions } from "@/features/session/api";
import { formatInboxTime } from "@/features/session/format";
import { AgentLink, LINK_CLASS } from "@/features/session/message-block";
import { formatCostEst } from "@/features/usage/format";
import { sessionQueryOptions } from "@/lib/session";
import {
  type PatchTaskBody,
  patchTask,
  taskDetailOptions,
  taskPlaceholder,
  taskSummaryFromList,
  tasksQueryKey,
} from "./api";
import { AssigneeMenu } from "./assignee-menu";
import { authorMention } from "./comment-block";
import { CommentComposer, type CommentComposerHandle } from "./comment-composer";
import { checkDependencies, DependencyEditor } from "./dependency-editor";
import { checkLink, LinkEditor, type LinkRow, newLinkRow, rowsToInput } from "./link-editor";
import { LinkList } from "./link-list";
import { BlockedMarker, STATUS, StatusLabel } from "./status-label";
import { StatusMenu } from "./status-menu";
import { TaskActivity } from "./task-activity";
import { TaskBadge } from "./task-badge";

const sentenceOf = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);
/** An editor's failure: a field error (400) is the server's sentence, anything else the fixed line (the text stays). */
const saveFailure = (e: unknown) =>
  e instanceof ApiError && e.status === 400 ? e.message : "Couldn't save. Try again.";

/**
 * Moves focus back to an editor's Edit button once the closed editor has rendered. A frame callback
 * could run before React commits that render (the button isn't mounted while editing), so the focus
 * waits for the commit instead.
 */
function useReturnFocus(editing: boolean, target: RefObject<HTMLButtonElement | null>) {
  const pending = useRef(false);
  useEffect(() => {
    if (editing || !pending.current) return;
    pending.current = false;
    target.current?.focus();
  }, [editing, target]);
  return () => {
    pending.current = true;
  };
}

function SideSection({
  label,
  children,
  flush,
}: {
  label: string;
  children: ReactNode;
  /** The first section of the panel starts at the top edge. */
  flush?: boolean;
}) {
  return (
    <section
      className={`grid grid-cols-[minmax(0,1fr)] gap-1.5 border-b border-border py-3 ${flush ? "pt-0" : ""}`}
    >
      <h3 className="text-[0.8125rem] font-normal text-muted-foreground">{label}</h3>
      {children}
    </section>
  );
}

/** Save / Cancel row of an inline editor. */
function EditorButtons({
  pending,
  saveDisabled = false,
  onSave,
  onCancel,
  failed,
  hint,
}: {
  pending: boolean;
  /** Save waits for something besides the request in flight. */
  saveDisabled?: boolean;
  onSave(): void;
  onCancel(): void;
  failed: string | undefined;
  hint?: string | undefined;
}) {
  return (
    <div className="grid gap-1.5">
      {hint && <p className="text-[0.8125rem] leading-[1.125rem] text-muted-foreground">{hint}</p>}
      {failed && (
        <p role="alert" className="text-[0.8125rem] leading-[1.125rem] text-destructive">
          {failed}
        </p>
      )}
      <div className="flex items-center gap-2">
        <Button type="button" onClick={onSave} disabled={pending || saveDisabled}>
          {pending ? "Saving…" : "Save"}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/** The task detail, or until it arrives a stand-in from the cached list row (spec §11): the route
 *  renders the title and status at once instead of waiting. The list-cache read in `placeholderData`
 *  is deliberately non-reactive: the real detail replaces it as soon as it loads. */
export function useTaskDetail(key: string) {
  const qc = useQueryClient();
  return useQuery({
    ...taskDetailOptions(key),
    placeholderData: () => {
      const row = taskSummaryFromList(qc, key);
      return row && taskPlaceholder(row);
    },
  });
}

/** Static plates where a detail-only part of the page will go (distinct classes: they are the keys). */
function Plates({ heights }: { heights: readonly string[] }) {
  return (
    <div aria-hidden="true" className="grid gap-2">
      {heights.map((h) => (
        <Skeleton key={h} className={h} />
      ))}
    </div>
  );
}
const ACTIVITY_PLATES = ["h-10", "h-14"] as const;

/** One line of side-panel text ("None") at its own line height. */
const SIDE_LINE = "h-[1lh] text-[0.8125rem]";

/** The side sections as they render empty (None, None, None, the creator), a plate per line at its
 *  real height: on a phone Activity sits under them, and it must not jump when the detail lands. */
function SideRestPlates() {
  return (
    <div aria-hidden="true">
      <SideSection label="Depends on">
        <Skeleton className={`${SIDE_LINE} w-10`} />
        <Skeleton className="h-6 w-32" />
      </SideSection>
      <SideSection label="Blocks">
        <Skeleton className={`${SIDE_LINE} w-10`} />
      </SideSection>
      <SideSection label="Links">
        <Skeleton className={`${SIDE_LINE} w-10`} />
        <Skeleton className="h-6 w-20" />
      </SideSection>
      <SideSection label="Created by">
        <Skeleton className="h-[1.125rem] w-36" />
      </SideSection>
    </div>
  );
}

/** A one-paragraph description and its Edit row, at their real heights. */
function BodyPlates() {
  return (
    <div
      aria-hidden="true"
      className="order-3 grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2 lg:col-start-1"
    >
      {/* The markdown's line (1.375rem) and the paragraph's bottom margin (prose-sm: 1rem). */}
      <div className="pb-4">
        <Skeleton className="h-[1.375rem] w-10/12" />
      </div>
      <div>
        <Skeleton className="h-6 w-12" />
      </div>
    </div>
  );
}

/** The task page body (UI design §7); the route wraps it with the header. */
export function TaskDetailView({
  taskKey,
  commentId,
}: {
  taskKey: string;
  commentId: string | undefined;
}) {
  const qc = useQueryClient();
  // While `placeholder`, only the list row's fields are real: nothing is editable from them.
  const { data: task, isPlaceholderData: placeholder } = useTaskDetail(taskKey);
  const { data: session } = useQuery(sessionQueryOptions);
  const me =
    session?.user && "handle" in session.user ? (session.user.handle as string) : undefined;
  const [announce, setAnnounce] = useState("");

  // The PATCH answers with the whole task: it goes straight into the cache (a later refetch can't
  // land under it), and the rest of the tasks cache refreshes without holding the editor open.
  const save = useMutation({
    mutationFn: (b: PatchTaskBody) => patchTask(taskKey, b),
    onSuccess: async (r) => {
      const detailKey = taskDetailOptions(taskKey).queryKey;
      // An older detail GET still in flight would land on top of the saved task (pr76 R3).
      await qc.cancelQueries({ queryKey: detailKey });
      qc.setQueryData(detailKey, r.task);
      void qc.invalidateQueries({
        queryKey: tasksQueryKey,
        predicate: (q) => !(q.queryKey[1] === "detail" && q.queryKey[2] === taskKey),
      });
    },
  });
  const saveTask: Save = async (b) => {
    await save.mutateAsync(b);
  };

  // --- the comment composer owns its draft (a keystroke re-renders only it); Reply and ?comment= reach in ---
  const composer = useRef<CommentComposerHandle>(null);
  const reply = useCallback((mention: string) => composer.current?.reply(mention), []);

  // --- deep link: scroll, highlight and focus the comment once; prefill the reply for an agent's comment ---
  const [highlight, setHighlight] = useState<string>();
  const [missing, setMissing] = useState(false);
  const handled = useRef<string>(undefined);
  useEffect(() => {
    // The stand-in has no activity: look for the comment once the real one is in.
    if (!task || placeholder || !commentId || handled.current === commentId) return;
    handled.current = commentId;
    const c = task.activity.find((a) => a.type === "comment" && a.id === commentId);
    if (c?.type !== "comment") return setMissing(true);
    setHighlight(commentId);
    if (c.author.kind === "agent") composer.current?.prefill(authorMention(c.author));
    requestAnimationFrame(() => {
      const el = document.getElementById(`comment-${commentId}`);
      el?.scrollIntoView?.({ block: "center" });
      el?.focus({ preventScroll: true });
    });
  }, [task, placeholder, commentId]);
  useEffect(() => {
    if (!highlight) return;
    const off = (e: PointerEvent) => {
      if (!document.getElementById(`comment-${highlight}`)?.contains(e.target as Node))
        setHighlight(undefined);
    };
    document.addEventListener("pointerdown", off);
    return () => document.removeEventListener("pointerdown", off);
  }, [highlight]);

  // A new comment by someone else is announced politely.
  const seen = useRef<Set<string>>(undefined);
  useEffect(() => {
    if (!task || placeholder) return; // the first real activity is history, not news
    const ids = new Set(task.activity.filter((a) => a.type === "comment").map((a) => a.id));
    if (seen.current) {
      const fresh = task.activity.find(
        (a) =>
          a.type === "comment" &&
          !seen.current?.has(a.id) &&
          !(a.author.kind === "user" && a.author.handle === me),
      );
      if (fresh && fresh.type === "comment")
        setAnnounce(`${authorMention(fresh.author)} commented`);
    }
    seen.current = ids;
  }, [task, placeholder, me]);

  if (!task) return null;
  const liveAssignee = task.assignee && !task.assignee.ended ? task.assignee.slug : undefined;
  return (
    <PageBody>
      <p role="status" aria-live="polite" className="sr-only">
        {announce}
      </p>
      <div className="grid grid-cols-[minmax(0,1fr)] gap-x-6 gap-y-6 lg:grid-cols-[minmax(0,1fr)_min(17.5rem,40%)] lg:grid-rows-[auto_auto_1fr]">
        <TitleBlock
          task={task}
          liveAssignee={liveAssignee}
          save={saveTask}
          disabled={placeholder}
        />
        <aside className="contents min-w-0 lg:col-start-2 lg:row-span-3 lg:row-start-1 lg:block">
          <div className="order-2 grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1 lg:mb-0">
            <StatusAndAssignee
              task={task}
              announce={setAnnounce}
              save={saveTask}
              disabled={placeholder}
            />
          </div>
          <div className="order-4 min-w-0">
            {placeholder ? <SideRestPlates /> : <SideRest task={task} save={saveTask} />}
          </div>
        </aside>
        {placeholder ? (
          <BodyPlates />
        ) : (
          <BodyBlock task={task} liveAssignee={liveAssignee} save={saveTask} />
        )}
        <div className="order-5 grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4 lg:col-start-1">
          {placeholder ? (
            <Plates heights={ACTIVITY_PLATES} />
          ) : (
            <>
              <TaskActivity
                taskKey={task.key}
                items={task.activity}
                highlightedId={highlight}
                onReply={reply}
                notFoundLine={missing}
              />
              <CommentComposer ref={composer} taskKey={taskKey} assignee={liveAssignee} />
            </>
          )}
        </div>
      </div>
    </PageBody>
  );
}

type Save = (b: PatchTaskBody) => Promise<void>;

function TitleBlock({
  task,
  liveAssignee,
  save,
  disabled,
}: {
  task: Detail;
  liveAssignee: string | undefined;
  save: Save;
  disabled: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(task.title);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const edit = useRef<HTMLButtonElement>(null);
  const returnFocus = useReturnFocus(editing, edit);
  const input = useRef<HTMLInputElement>(null);
  const close = () => {
    setEditing(false);
    setError(undefined);
    returnFocus();
  };
  useEffect(() => {
    if (editing) input.current?.focus();
  }, [editing]);
  async function commit() {
    const parsed = taskTitleSchema.safeParse(text);
    if (!parsed.success) return setError(parsed.error.issues[0]?.message);
    if (parsed.data === task.title) return close();
    setPending(true);
    try {
      await save({ title: parsed.data });
      setPending(false);
      close();
    } catch (e) {
      setPending(false);
      setError(saveFailure(e));
    }
  }
  return (
    <div className="order-1 grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1.5 lg:col-start-1">
      {editing ? (
        <div className="grid grid-cols-[minmax(0,1fr)] gap-1.5">
          <Input
            ref={input}
            aria-label="Title"
            value={text}
            aria-invalid={error ? true : undefined}
            onChange={(e) => {
              setText(e.target.value);
              setError(undefined);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void commit();
              } else if (e.key === "Escape") close();
            }}
            className="h-9"
          />
          <EditorButtons
            pending={pending}
            onSave={() => void commit()}
            onCancel={close}
            failed={error}
            hint={liveAssignee ? `Saving sends the new title to @${liveAssignee}.` : undefined}
          />
        </div>
      ) : (
        <div className="flex min-w-0 items-start gap-2">
          <h2 className="min-w-0 font-heading text-xl leading-7 font-[650] tracking-[-0.015em] [overflow-wrap:anywhere]">
            {task.title}
          </h2>
          <Button
            ref={edit}
            variant="outline"
            size="xs"
            aria-label="Edit title"
            className="shrink-0"
            disabled={disabled}
            onClick={() => {
              setText(task.title);
              setEditing(true);
            }}
          >
            Edit
          </Button>
        </div>
      )}
    </div>
  );
}

function BodyBlock({
  task,
  liveAssignee,
  save,
}: {
  task: Detail;
  liveAssignee: string | undefined;
  save: Save;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(task.body);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const edit = useRef<HTMLButtonElement>(null);
  const returnFocus = useReturnFocus(editing, edit);
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (editing) area.current?.focus();
  }, [editing]);
  const close = () => {
    setEditing(false);
    setError(undefined);
    returnFocus();
  };
  async function commit() {
    const parsed = taskBodySchema.safeParse(text);
    if (!parsed.success) return setError(parsed.error.issues[0]?.message);
    if (text === task.body) return close();
    setPending(true);
    try {
      await save({ body: text });
      setPending(false);
      close();
    } catch (e) {
      setPending(false);
      setError(saveFailure(e));
    }
  }
  return (
    <div className="order-3 grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2 lg:col-start-1">
      {editing ? (
        <div className="grid grid-cols-[minmax(0,1fr)] gap-2">
          {/* Escape does not cancel here: it would discard a long draft. */}
          <MarkdownEditor
            id="task-body"
            aria-label="Description"
            value={text}
            onChange={setText}
            textareaRef={area}
            variant="detail"
          />
          <EditorButtons
            pending={pending}
            onSave={() => void commit()}
            onCancel={close}
            failed={error}
            hint={
              liveAssignee ? `Saving sends the new description to @${liveAssignee}.` : undefined
            }
          />
        </div>
      ) : (
        <div className="grid grid-cols-[minmax(0,1fr)] gap-2">
          {task.body.trim() ? (
            <Markdown source={task.body} variant="detail" />
          ) : (
            <p className="text-sm text-muted-foreground">No description.</p>
          )}
          <div>
            <Button
              ref={edit}
              variant="ghost"
              size="xs"
              aria-label={task.body.trim() ? "Edit description" : "Add a description"}
              onClick={() => {
                setText(task.body);
                setEditing(true);
              }}
            >
              {task.body.trim() ? "Edit" : "Add a description"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function StatusAndAssignee({
  task,
  announce,
  save,
  disabled,
}: {
  task: Detail;
  announce(s: string): void;
  save: Save;
  disabled: boolean;
}) {
  const [optimistic, setOptimistic] = useState<{
    status?: Detail["status"];
    assignee?: string | null;
  }>({});
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  async function apply(body: PatchTaskBody, say: string, shown: typeof optimistic) {
    setError(undefined);
    setOptimistic(shown);
    setPending(true);
    try {
      await save(body);
      announce(say);
    } catch (e) {
      setError(sentenceOf(e, "Couldn't save. Try again."));
    } finally {
      setOptimistic({});
      setPending(false);
    }
  }
  const status = optimistic.status ?? task.status;
  const assignee =
    optimistic.assignee === undefined
      ? task.assignee
      : optimistic.assignee === null
        ? null
        : { slug: optimistic.assignee, displayName: optimistic.assignee };
  return (
    <>
      <SideSection label="Status" flush>
        <StatusMenu
          value={status}
          disabled={pending || disabled}
          onCommit={(s) =>
            void apply({ status: s }, `Status set to ${STATUS[s].sentence}`, { status: s })
          }
        />
      </SideSection>
      <SideSection label="Assignee">
        <AssigneeMenu
          value={assignee}
          disabled={pending || disabled}
          onCommit={(slug) =>
            void apply({ assignee: slug }, slug ? `Assigned to @${slug}` : "Unassigned", {
              assignee: slug,
            })
          }
        />
        {error && (
          <p role="alert" className="text-[0.8125rem] leading-[1.125rem] text-destructive">
            {error}
          </p>
        )}
        {task.blockedBy.length > 0 && (
          <p className="flex flex-wrap items-center gap-x-1 text-[0.8125rem] leading-[1.125rem]">
            <BlockedMarker keys={[]} />
            <span className="text-muted-foreground">Blocked by</span>
            {task.blockedBy.map((k, i) => (
              <span key={k}>
                <TaskBadge taskKey={k} link />
                {i < task.blockedBy.length - 1 ? "," : ""}
              </span>
            ))}
          </p>
        )}
      </SideSection>
    </>
  );
}

function SideRest({ task, save }: { task: Detail; save: Save }) {
  const now = new Date();
  const created = new Date(task.createdAt);
  return (
    <>
      <DependsOnSection task={task} save={save} />
      <SideSection label="Blocks">
        {task.blocks.length ? (
          <ul className="grid gap-1.5">
            {task.blocks.map((b) => (
              <li key={b.key} className="grid gap-0.5 text-[0.8125rem] leading-[1.125rem]">
                <TaskBadge taskKey={b.key} title={b.title} link />
                <span className="flex items-center gap-2">
                  <StatusLabel status={b.status} className="text-muted-foreground" />
                  {b.blocked && <span className="text-foreground">Blocked</span>}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[0.8125rem] text-muted-foreground">None</p>
        )}
      </SideSection>
      <LinksSection task={task} save={save} />
      {task.usage && (
        <section className="grid gap-1 border-b border-border py-3">
          <p className="text-[0.8125rem] leading-[1.125rem] tabular-nums">
            Usage: {formatCostEst(task.usage.costUsd, task.usage.turns)} · {task.usage.turns}{" "}
            {task.usage.turns === 1 ? "turn" : "turns"}
          </p>
          <p className="text-[0.8125rem] leading-[1.125rem] text-muted-foreground">
            Counts only turns that handled this task's messages and nothing else. Real usage can be
            higher.
          </p>
        </section>
      )}
      <SideSection label="Created by">
        <p className="text-[0.8125rem] leading-[1.125rem]">
          {task.createdBy.kind === "agent" ? (
            <AgentLink slug={task.createdBy.slug} />
          ) : (
            <span className="font-mono">@{task.createdBy.handle}</span>
          )}
          {" · "}
          <time
            dateTime={task.createdAt}
            title={created.toLocaleString()}
            className="text-muted-foreground"
          >
            {formatInboxTime(created, now)}
          </time>
        </p>
      </SideSection>
    </>
  );
}

function DependsOnSection({ task, save }: { task: Detail; save: Save }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const [resolved, setResolved] = useState<
    Awaited<ReturnType<typeof checkDependencies>>["resolved"]
  >([]);
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState<string>();
  const edit = useRef<HTMLButtonElement>(null);
  const returnFocus = useReturnFocus(editing, edit);
  const close = () => {
    setEditing(false);
    setError(undefined);
    setFailed(undefined);
    returnFocus();
  };
  async function check() {
    const r = await checkDependencies(text, task.key).catch(() => undefined);
    if (r) setResolved(r.resolved);
    setError(r?.error);
    return r;
  }
  async function commit() {
    const r = await check();
    if (!r || r.error) return;
    setPending(true);
    setFailed(undefined);
    try {
      await save({ dependsOn: r.keys });
      setPending(false);
      close();
    } catch (e) {
      setPending(false);
      if (
        e instanceof ApiError &&
        typeof (e.body.fields as Record<string, string> | undefined)?.dependsOn === "string"
      )
        setError((e.body.fields as Record<string, string>).dependsOn);
      else setFailed("Couldn't save. Try again.");
    }
  }
  return (
    <SideSection label="Depends on">
      {editing ? (
        <div className="grid grid-cols-[minmax(0,1fr)] gap-2">
          <DependencyEditor
            name="task-depends-on"
            value={text}
            resolved={resolved}
            error={error}
            onChange={(v) => {
              setText(v);
              setError(undefined);
            }}
            onBlur={() => void check()}
          />
          <EditorButtons
            pending={pending}
            onSave={() => void commit()}
            onCancel={close}
            failed={failed}
          />
        </div>
      ) : (
        <>
          {task.dependsOn.length ? (
            <ul className="grid gap-1.5">
              {task.dependsOn.map((d) => (
                <li key={d.key} className="grid gap-0.5 text-[0.8125rem] leading-[1.125rem]">
                  <TaskBadge taskKey={d.key} title={d.title} link />
                  <StatusLabel status={d.status} className="text-muted-foreground" />
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[0.8125rem] text-muted-foreground">None</p>
          )}
          <div>
            <Button
              ref={edit}
              variant="ghost"
              size="xs"
              onClick={() => {
                setText(task.dependsOn.map((d) => d.key).join(", "));
                setResolved([]);
                setEditing(true);
              }}
            >
              Edit dependencies
            </Button>
          </div>
        </>
      )}
    </SideSection>
  );
}

function LinksSection({ task, save }: { task: Detail; save: Save }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [rows, setRows] = useState<LinkRow[]>([]);
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState<string>();
  const edit = useRef<HTMLButtonElement>(null);
  const returnFocus = useReturnFocus(editing, edit);
  // The agent lists only check an @agent link while editing; the read view doesn't fetch them.
  const active = useQuery({ ...agentsListQueryOptions("exclude"), enabled: editing });
  const ended = useQuery({ ...agentsListQueryOptions("only"), enabled: editing });
  const known = useMemo(
    () =>
      active.data && ended.data
        ? new Set([...active.data, ...ended.data].map((a) => a.slug))
        : undefined,
    [active.data, ended.data],
  );
  const close = () => {
    setEditing(false);
    setFailed(undefined);
    returnFocus();
  };
  const check = (all = rows) => {
    const next: Record<string, string | undefined> = {};
    for (const r of all) next[r.id] = checkLink(r, known);
    setErrors(next);
    return Object.values(next).some(Boolean);
  };
  async function commit() {
    if (check()) return;
    setPending(true);
    setFailed(undefined);
    try {
      await save({ links: rowsToInput(rows) });
      setPending(false);
      close();
    } catch {
      setPending(false);
      setFailed("Couldn't save. Try again.");
    }
  }
  return (
    <SideSection label="Links">
      {editing ? (
        <div className="grid grid-cols-[minmax(0,1fr)] gap-2">
          <LinkEditor rows={rows} onChange={setRows} errors={errors} onBlurRow={() => check()} />
          {(active.isError || ended.isError) && (
            <p className="text-[0.8125rem] leading-[1.125rem] text-muted-foreground">
              Couldn't load agents, so @agent links aren't checked here.
            </p>
          )}
          <EditorButtons
            pending={pending}
            saveDisabled={active.isPending || ended.isPending}
            onSave={() => void commit()}
            onCancel={close}
            failed={failed}
          />
        </div>
      ) : (
        <>
          <LinkList links={task.links} />
          <div>
            <Button
              ref={edit}
              variant="ghost"
              size="xs"
              onClick={() => {
                // The lists start loading on the click, not on the next render.
                void qc.prefetchQuery(agentsListQueryOptions("exclude"));
                void qc.prefetchQuery(agentsListQueryOptions("only"));
                setRows(
                  task.links.map((l) =>
                    newLinkRow({
                      kind: l.kind,
                      target: l.kind === "agent" ? `@${l.agent?.slug ?? ""}` : (l.target ?? ""),
                      title: l.title ?? "",
                    }),
                  ),
                );
                setErrors({});
                setEditing(true);
              }}
            >
              Edit links
            </Button>
          </div>
        </>
      )}
    </SideSection>
  );
}

/** The page header: Tasks back link, the key in mono. */
export function TaskDetailHeader({
  taskKey,
  title,
}: {
  taskKey: string;
  title?: string | undefined;
}) {
  return (
    <PageHeader
      title={taskKey}
      documentTitle={title ? `${taskKey} · ${title}` : taskKey}
      heading={
        <>
          <Link
            to="/tasks"
            search={{}}
            className={`font-normal text-muted-foreground ${LINK_CLASS}`}
          >
            Tasks
          </Link>
          <span aria-hidden="true" className="px-1.5 font-normal text-muted-foreground">
            /
          </span>
          <span className="font-mono">{taskKey}</span>
        </>
      }
    />
  );
}
