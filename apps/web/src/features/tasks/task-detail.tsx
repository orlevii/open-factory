import {
  ApiError,
  type TaskDetail as Detail,
  type TaskSummary,
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
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { PrincipalChip } from "@/components/agent-chip";
import { FieldShell } from "@/components/field-shell";
import {
  FormOutcome,
  type Outcome,
  showsNotice,
  useOutcome,
} from "@/components/forms/form-outcome";
import { skippedLeave, useFieldErrors } from "@/components/forms/use-field-errors";
import { Markdown } from "@/components/markdown/markdown";
import { MarkdownEditor } from "@/components/markdown/markdown-editor";
import { PageHeader } from "@/components/page-header";
import { InlineTags } from "@/components/tag/inline-tags";
import { usePlainTags } from "@/components/tag/plain-tags";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useAgent } from "@/features/agents/use-agent-index";
import { usePrincipalLookup } from "@/features/principals/use-principal";
import { agentsListQueryOptions } from "@/features/session/api";
import { formatInboxTime } from "@/features/session/format";
import { LINK_CLASS } from "@/features/session/message-block";
import { formatCostEst } from "@/features/usage/format";
import { FORM_MSG } from "@/lib/form-messages.ts";
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
import {
  checkLink,
  LinkEditor,
  type LinkRow,
  linkRowErrors,
  newLinkRow,
  rowsToInput,
} from "./link-editor";
import { LinkList } from "./link-list";
import { BlockedMarker, STATUS, StatusLabel } from "./status-label";
import { StatusMenu } from "./status-menu";
import { TaskActivity } from "./task-activity";
import { TaskBadge } from "./task-badge";

const sentenceOf = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);
/** An editor's failure that no field of its own explains: a 400's own sentence, anything else the fixed line (the text stays). */
const saveFailure = (e: unknown) =>
  e instanceof ApiError && e.status === 400 ? e.message : FORM_MSG.saveFailed;
const fieldsOf = (e: unknown) =>
  e instanceof ApiError ? (e.body.fields as Record<string, string> | undefined) : undefined;
const firstIssue = (r: { success: boolean; error?: { issues: { message: string }[] } }) =>
  r.success ? undefined : r.error?.issues[0]?.message;

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

/**
 * The outcome line and Save / Cancel row of an inline editor. `outcome` is the editor's `useOutcome()` with its hint
 * merged in as the notice: a save failure replaces the hint, and the hint returns when the editor clears the failure.
 */
function EditorButtons({
  pending,
  saveDisabled = false,
  onSave,
  onCancel,
  outcome,
}: {
  pending: boolean;
  /** Save waits for something besides the request in flight. */
  saveDisabled?: boolean;
  onSave(): void;
  onCancel(): void;
  outcome: Outcome;
}) {
  const noticeId = useId();
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-2">
      <FormOutcome
        outcome={outcome}
        pending={pending ? "Saving…" : undefined}
        noticeId={noticeId}
      />
      <div className="flex items-center gap-2">
        <Button
          type="button"
          onClick={onSave}
          disabled={pending || saveDisabled}
          aria-describedby={showsNotice(outcome) ? noticeId : undefined}
        >
          {pending ? "Saving…" : "Save"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          data-skip-validate
          onClick={onCancel}
          disabled={pending}
        >
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
      className="order-3 grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2 @[45rem]/task:col-start-1"
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

/** The task page body (UI design §7): the route adds the header and the page padding, the peek its sheet. */
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
          !(a.author.kind === "human" && a.author.handle === me),
      );
      if (fresh && fresh.type === "comment")
        setAnnounce(`${authorMention(fresh.author)} commented`);
    }
    seen.current = ids;
  }, [task, placeholder, me]);

  if (!task) return null;
  const liveAssignee = task.assignee && !task.assignee.ended ? task.assignee.handle : undefined;
  return (
    // A container (spec §12): two columns when the view itself is wide (the page), stacked in a peek.
    <div className="@container/task min-w-0">
      <p role="status" aria-live="polite" className="sr-only">
        {announce}
      </p>
      <div className="grid grid-cols-[minmax(0,1fr)] gap-x-6 gap-y-6 @[45rem]/task:grid-cols-[minmax(0,1fr)_min(17.5rem,40%)] @[45rem]/task:grid-rows-[auto_auto_1fr]">
        <TitleBlock
          task={task}
          liveAssignee={liveAssignee}
          save={saveTask}
          disabled={placeholder}
        />
        <aside className="contents min-w-0 @[45rem]/task:col-start-2 @[45rem]/task:row-span-3 @[45rem]/task:row-start-1 @[45rem]/task:block">
          <div className="order-2 grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1 @[45rem]/task:mb-0">
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
        <div className="order-5 grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4 @[45rem]/task:col-start-1">
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
    </div>
  );
}

type Save = (b: PatchTaskBody) => Promise<void>;

/* An editor's body (title, description, dependencies, links) is mounted only while editing: Cancel and a successful
 * Save unmount it, and its field errors and outcome with it. */

const TITLE_FIELDS = ["title"] as const;

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
  const edit = useRef<HTMLButtonElement>(null);
  const returnFocus = useReturnFocus(editing, edit);
  const close = () => {
    setEditing(false);
    returnFocus();
  };
  return (
    <div className="order-1 grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1.5 @[45rem]/task:col-start-1">
      {editing ? (
        <TitleEditor title={task.title} liveAssignee={liveAssignee} save={save} onClose={close} />
      ) : (
        <div className="flex min-w-0 items-start gap-2">
          <h2 className="min-w-0 font-heading text-xl leading-7 font-[650] tracking-[-0.015em] [overflow-wrap:anywhere]">
            <InlineTags text={task.title} />
          </h2>
          <Button
            ref={edit}
            variant="outline"
            size="xs"
            aria-label="Edit title"
            className="shrink-0"
            disabled={disabled}
            onClick={() => setEditing(true)}
          >
            Edit
          </Button>
        </div>
      )}
    </div>
  );
}

function TitleEditor({
  title,
  liveAssignee,
  save,
  onClose,
}: {
  title: string;
  liveAssignee: string | undefined;
  save: Save;
  onClose(): void;
}) {
  const [text, setText] = useState(title);
  const [pending, setPending] = useState(false);
  const o = useOutcome();
  const form = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  const f = useFieldErrors({
    form,
    fields: TITLE_FIELDS,
    checks: { title: () => firstIssue(taskTitleSchema.safeParse(text)) },
  });
  async function commit() {
    if (pending) return;
    o.clear();
    if (!f.submit()) return;
    const next = text.trim();
    if (next === title) return onClose();
    setPending(true);
    try {
      await save({ title: next });
      onClose();
    } catch (e) {
      setPending(false);
      if (!f.server(fieldsOf(e))) o.fail(saveFailure(e));
    }
  }
  return (
    <div ref={form} className="grid grid-cols-[minmax(0,1fr)] gap-1">
      {/* The heading's place already names it: the label is for assistive tech. */}
      <FieldShell name="task-title" label="Title" hideLabel error={f.errors.title}>
        {(a) => (
          <Input
            ref={input}
            id={a.id}
            value={text}
            autoComplete="off"
            aria-invalid={a.invalid || undefined}
            aria-describedby={a.describedBy}
            onChange={(e) => {
              setText(e.target.value);
              f.change("title");
              o.clear();
            }}
            onBlur={(e) => f.blur("title", e)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void commit();
              } else if (e.key === "Escape" && !pending) onClose();
            }}
            className="h-9"
          />
        )}
      </FieldShell>
      <EditorButtons
        pending={pending}
        onSave={() => void commit()}
        onCancel={onClose}
        outcome={{
          ...o.outcome,
          notice: liveAssignee ? `Saving sends the new title to @${liveAssignee}.` : undefined,
        }}
      />
    </div>
  );
}

const BODY_FIELDS = ["body"] as const;

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
  const edit = useRef<HTMLButtonElement>(null);
  const returnFocus = useReturnFocus(editing, edit);
  const close = () => {
    setEditing(false);
    returnFocus();
  };
  return (
    <div className="order-3 grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2 @[45rem]/task:col-start-1">
      {editing ? (
        <BodyEditor body={task.body} liveAssignee={liveAssignee} save={save} onClose={close} />
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
              onClick={() => setEditing(true)}
            >
              {task.body.trim() ? "Edit" : "Add a description"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function BodyEditor({
  body,
  liveAssignee,
  save,
  onClose,
}: {
  body: string;
  liveAssignee: string | undefined;
  save: Save;
  onClose(): void;
}) {
  const [text, setText] = useState(body);
  const [pending, setPending] = useState(false);
  const [view, setView] = useState<"write" | "preview">("write");
  const o = useOutcome();
  const form = useRef<HTMLDivElement>(null);
  // The textarea takes focus when it mounts: on open, and after a failing Save switched Preview back to Write (its tab
  // panel mounts a commit after the switch, too late for the hook's focus).
  const focusNext = useRef(true);
  const focusOnMount = useCallback((el: HTMLTextAreaElement | null) => {
    if (!el || !focusNext.current) return;
    focusNext.current = false;
    el.focus();
  }, []);
  const bodyIssue = () => firstIssue(taskBodySchema.safeParse(text));
  const f = useFieldErrors({ form, fields: BODY_FIELDS, checks: { body: bodyIssue } });
  async function commit() {
    if (pending) return;
    o.clear();
    if (view === "preview" && bodyIssue()) {
      focusNext.current = true;
      setView("write");
    }
    if (!f.submit()) return;
    if (text === body) return onClose();
    setPending(true);
    try {
      await save({ body: text });
      onClose();
    } catch (e) {
      setPending(false);
      if (!f.server(fieldsOf(e))) o.fail(saveFailure(e));
    }
  }
  return (
    <div ref={form} className="grid grid-cols-[minmax(0,1fr)] gap-1">
      <FieldShell name="task-body" label="Description" hideLabel error={f.errors.body}>
        {(a) => (
          // Escape does not cancel here: it would discard a long draft.
          <MarkdownEditor
            id={a.id}
            value={text}
            invalid={a.invalid}
            view={view}
            onViewChange={setView}
            onChange={(next) => {
              setText(next);
              f.change("body");
              o.clear();
            }}
            onBlur={(e) => f.blur("body", e)}
            textareaRef={focusOnMount}
            variant="detail"
            {...(a.describedBy ? { "aria-describedby": a.describedBy } : {})}
          />
        )}
      </FieldShell>
      <EditorButtons
        pending={pending}
        onSave={() => void commit()}
        onCancel={onClose}
        outcome={{
          ...o.outcome,
          notice: liveAssignee
            ? `Saving sends the new description to @${liveAssignee}.`
            : undefined,
        }}
      />
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
  const lookup = usePrincipalLookup();
  async function apply(body: PatchTaskBody, say: string, shown: typeof optimistic) {
    setError(undefined);
    setOptimistic(shown);
    setPending(true);
    try {
      await save(body);
      announce(say);
    } catch (e) {
      setError(sentenceOf(e, FORM_MSG.saveFailed));
    } finally {
      setOptimistic({});
      setPending(false);
    }
  }
  const status = optimistic.status ?? task.status;
  const chosen = useAgent(optimistic.assignee ?? "");
  const assignee =
    optimistic.assignee === undefined
      ? task.assignee
      : optimistic.assignee === null
        ? null
        : {
            ref: optimistic.assignee,
            handle: chosen?.handle ?? "…",
            displayName: chosen?.displayName ?? optimistic.assignee,
          };
  return (
    <>
      <SideSection label="Status" flush>
        <StatusMenu
          value={status}
          disabled={disabled}
          pending={pending}
          onCommit={(s) =>
            void apply({ status: s }, `Status set to ${STATUS[s].sentence}`, { status: s })
          }
        />
      </SideSection>
      <SideSection label="Assignee">
        <AssigneeMenu
          value={assignee}
          disabled={disabled}
          pending={pending}
          onCommit={(ref) =>
            void apply(
              { assignee: ref },
              ref ? `Assigned to @${lookup(ref)?.handle ?? ref}` : "Unassigned",
              { assignee: ref },
            )
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
          <span data-created-by className="inline-flex items-center align-middle">
            <PrincipalChip principal={task.createdBy} size={20} link />
          </span>
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

const DEPENDS_FIELDS = ["dependsOn"] as const;
/** The dependency check is async: its result reaches the hook through `set` (leave) and `submit`'s extra (Save). */
const NO_CHECKS = {};

function DependsOnSection({ task, save }: { task: Detail; save: Save }) {
  const [editing, setEditing] = useState(false);
  const edit = useRef<HTMLButtonElement>(null);
  const returnFocus = useReturnFocus(editing, edit);
  const close = () => {
    setEditing(false);
    returnFocus();
  };
  return (
    <SideSection label="Depends on">
      {editing ? (
        <DependsOnEditor task={task} save={save} onClose={close} />
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
            <Button ref={edit} variant="ghost" size="xs" onClick={() => setEditing(true)}>
              Edit dependencies
            </Button>
          </div>
        </>
      )}
    </SideSection>
  );
}

function DependsOnEditor({ task, save, onClose }: { task: Detail; save: Save; onClose(): void }) {
  const [text, setText] = useState(() => task.dependsOn.map((d) => d.key).join(", "));
  // The keys as last typed, for a lookup that returns after they changed.
  const latest = useRef(text);
  const [resolved, setResolved] = useState<TaskSummary[]>([]);
  const [pending, setPending] = useState(false);
  // A ref, not `pending`: a second Save can arrive during the lookup, before `pending` is set.
  const inFlight = useRef(false);
  // Cancel stays live during the lookup; a Save whose lookup returns after it sends nothing.
  const cancelled = useRef(false);
  const o = useOutcome();
  const form = useRef<HTMLDivElement>(null);
  const f = useFieldErrors<(typeof DEPENDS_FIELDS)[number]>({
    form,
    fields: DEPENDS_FIELDS,
    checks: NO_CHECKS,
  });
  async function commit() {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      o.clear();
      const r = await checkDependencies(text, task.key).catch(() => undefined);
      if (cancelled.current) return;
      if (r) setResolved(r.resolved);
      if (!f.submit(undefined, { dependsOn: r?.error })) return;
      // The lookup failed: nothing to save the keys from.
      if (!r) return o.fail(FORM_MSG.saveFailed);
      setPending(true);
      try {
        await save({ dependsOn: r.keys });
        onClose();
      } catch (e) {
        setPending(false);
        if (!f.server(fieldsOf(e))) o.fail(saveFailure(e));
      }
    } finally {
      inFlight.current = false;
    }
  }
  return (
    <div ref={form} className="grid grid-cols-[minmax(0,1fr)] gap-1.5">
      <DependencyEditor
        name="task-depends-on"
        value={text}
        resolvedKeys={resolved.map((t) => t.key)}
        error={f.errors.dependsOn}
        onChange={(v) => {
          latest.current = v;
          setText(v);
          f.change("dependsOn");
          o.clear();
        }}
        onBlur={(e) => {
          // Focus leaving the window is not a leave (D11).
          if (!document.hasFocus()) return;
          // Toward Cancel (§5.4) the lookup still resolves the badges, but says no error.
          const quiet = skippedLeave(e);
          const typed = text;
          checkDependencies(typed, task.key).then(
            (r) => {
              if (latest.current !== typed) return;
              setResolved(r.resolved);
              // Blur only adds: an edit clears through `f.change`, so a server error survives tabbing out.
              if (r.error && !quiet) f.set("dependsOn", r.error);
            },
            // A failed lookup on leave says nothing; Save says it.
            () => {},
          );
        }}
      />
      {resolved.length > 0 && (
        <ul aria-label="Resolved dependencies" className="grid gap-1">
          {resolved.map((t) => (
            <li key={t.key} className="flex min-w-0 items-center gap-2 text-[0.8125rem]">
              <TaskBadge taskKey={t.key} title={t.title} />
              <StatusLabel status={t.status} className="ml-auto text-muted-foreground" />
            </li>
          ))}
        </ul>
      )}
      <EditorButtons
        pending={pending}
        onSave={() => void commit()}
        onCancel={() => {
          cancelled.current = true;
          onClose();
        }}
        outcome={o.outcome}
      />
    </div>
  );
}

const LINK_FIELDS = ["links"] as const;

function LinksSection({ task, save }: { task: Detail; save: Save }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const edit = useRef<HTMLButtonElement>(null);
  const returnFocus = useReturnFocus(editing, edit);
  const close = () => {
    setEditing(false);
    returnFocus();
  };
  return (
    <SideSection label="Links">
      {editing ? (
        <LinksEditor task={task} save={save} onClose={close} />
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

function LinksEditor({ task, save, onClose }: { task: Detail; save: Save; onClose(): void }) {
  const [rows, setRows] = useState<LinkRow[]>(() =>
    task.links.map((l) =>
      newLinkRow({
        kind: l.kind,
        target: l.kind === "agent" ? `@${l.agent?.handle ?? ""}` : (l.target ?? ""),
        title: l.title ?? "",
      }),
    ),
  );
  // Which rows' notes may show their message: a row joins on its blur, every row on Save.
  const [checkedRows, setCheckedRows] = useState<ReadonlySet<string>>(() => new Set());
  const [pending, setPending] = useState(false);
  const o = useOutcome();
  const form = useRef<HTMLDivElement>(null);
  // The agent lists only check an @agent link while editing; the read view doesn't fetch them.
  const active = useQuery(agentsListQueryOptions("exclude"));
  const ended = useQuery(agentsListQueryOptions("only"));
  const known = useMemo(
    () =>
      active.data && ended.data
        ? new Set([...active.data, ...ended.data].map((a) => a.handle))
        : undefined,
    [active.data, ended.data],
  );
  const f = useFieldErrors({
    form,
    fields: LINK_FIELDS,
    // Every row, blurred or not, so a bad row blocks the save.
    checks: { links: () => rows.map((r) => checkLink(r, known)).find(Boolean) },
  });
  const rowErrors = linkRowErrors(rows, known, checkedRows, f.errors.links);
  async function commit() {
    if (pending) return;
    o.clear();
    setCheckedRows(new Set(rows.map((r) => r.id)));
    if (!f.submit()) return;
    setPending(true);
    try {
      await save({ links: rowsToInput(rows) });
      onClose();
    } catch (e) {
      setPending(false);
      const fields = fieldsOf(e);
      // With no rows, a links error has no note to sit in.
      if (rows.length === 0) o.fail(fields?.links ?? saveFailure(e));
      else if (!f.server(fields)) o.fail(saveFailure(e));
    }
  }
  return (
    <div ref={form} className="grid grid-cols-[minmax(0,1fr)] gap-1">
      <LinkEditor
        rows={rows}
        onChange={(next) => {
          setRows(next);
          f.change("links");
          o.clear();
        }}
        errors={rowErrors}
        onBlurRow={(id, e) => {
          setCheckedRows((s) => (s.has(id) ? s : new Set(s).add(id)));
          f.blur("links", e);
        }}
      />
      {(active.isError || ended.isError) && (
        <p className="text-[0.8125rem] leading-[1.125rem] text-muted-foreground">
          Couldn't load agents, so @agent links aren't checked here.
        </p>
      )}
      <EditorButtons
        pending={pending}
        saveDisabled={active.isPending || ended.isPending}
        onSave={() => void commit()}
        onCancel={onClose}
        outcome={o.outcome}
      />
    </div>
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
  const plain = usePlainTags(title ?? "");
  return (
    <PageHeader
      title={taskKey}
      documentTitle={title ? `${taskKey} · ${plain}` : taskKey}
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
