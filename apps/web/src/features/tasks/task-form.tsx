import { ApiError, type TaskSummary, taskBodySchema, taskTitleSchema } from "@open-factory/shared";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type FormEvent, useRef, useState } from "react";
import { FieldShell } from "@/components/field-shell";
import { FormField } from "@/components/form-field";
import { MarkdownEditor } from "@/components/markdown/markdown-editor";
import { Button } from "@/components/ui/button";
import { agentsListQueryOptions } from "@/features/session/api";
import { AgentPicker } from "./agent-picker";
import type { CreateTaskBody } from "./api";
import { checkDependencies, DependencyEditor } from "./dependency-editor";
import { checkLink, LinkEditor, type LinkRow, rowsToInput } from "./link-editor";

const FIELDS = ["title", "body", "assignee", "dependsOn", "links"] as const;
type Field = (typeof FIELDS)[number];
type Errors = Partial<Record<Field, string>>;

const firstIssue = (r: { success: boolean; error?: { issues: { message: string }[] } }) =>
  r.success ? undefined : r.error?.issues[0]?.message;

/**
 * The create page's form (UI design §6). Each field validates when you leave it, never while you type, and everything
 * again on submit, which moves focus to the first invalid field. Server field errors map to their fields.
 */
export function TaskForm({ onSubmit }: { onSubmit(body: CreateTaskBody): Promise<void> }) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [assignee, setAssignee] = useState("");
  const [deps, setDeps] = useState("");
  const [resolved, setResolved] = useState<TaskSummary[]>([]);
  const [rows, setRows] = useState<LinkRow[]>([]);
  const [errors, setErrors] = useState<Errors>({});
  const [rowErrors, setRowErrors] = useState<Record<string, string | undefined>>({});
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const active = useQuery(agentsListQueryOptions("exclude"));
  const ended = useQuery(agentsListQueryOptions("only"));
  const known =
    active.data && ended.data
      ? new Set([...active.data, ...ended.data].map((a) => a.slug))
      : undefined;

  const setError = (f: Field, m: string | undefined) => setErrors((e) => ({ ...e, [f]: m }));
  const checkTitle = () => firstIssue(taskTitleSchema.safeParse(title));
  const checkBody = () => firstIssue(taskBodySchema.safeParse(body));
  /** The dependency check; `undefined` when the lookup itself failed. */
  async function checkDeps() {
    const r = await checkDependencies(deps).catch(() => undefined);
    if (r) setResolved(r.resolved);
    return r;
  }
  const checkRows = (all: LinkRow[] = rows) => {
    const next: Record<string, string | undefined> = {};
    for (const r of all) next[r.id] = checkLink(r, known);
    setRowErrors(next);
    return Object.values(next).find(Boolean);
  };

  const focus = (f: Field) =>
    form.current
      ?.querySelector<HTMLElement>(f === "links" ? '[aria-invalid="true"]' : `#field-${f}`)
      ?.focus();

  async function submit(ev: FormEvent) {
    ev.preventDefault();
    if (pending) return;
    setFailed(false);
    const checked = await checkDeps();
    const found: Errors = {
      title: checkTitle(),
      body: checkBody(),
      dependsOn: checked?.error,
      links: checkRows(),
    };
    setErrors(found);
    const first = FIELDS.find((f) => found[f]);
    if (first) return focus(first);
    // The lookup failed: nothing to submit the keys from.
    if (!checked) return setFailed(true);
    setPending(true);
    try {
      await onSubmit({
        title: title.trim(),
        body,
        ...(assignee ? { assignee } : {}),
        dependsOn: checked.keys,
        links: rowsToInput(rows),
      });
    } catch (err) {
      setPending(false);
      if (err instanceof ApiError) {
        const fields = (err.body.fields ?? {}) as Record<string, string>;
        const e: Errors = {};
        for (const f of FIELDS) if (fields[f]) e[f] = fields[f];
        if (Object.keys(e).length > 0) {
          setErrors(e);
          // The form is still disabled until the next render: focus once it is enabled again.
          queueMicrotask(() => focus(FIELDS.find((f) => e[f]) as Field));
          return;
        }
      }
      setFailed(true);
    }
  }

  return (
    <form ref={form} onSubmit={submit} noValidate className="grid max-w-[720px] gap-5">
      <fieldset disabled={pending} className="grid min-w-0 gap-5">
        <FormField
          name="title"
          label="Title"
          value={title}
          error={errors.title}
          autoComplete="off"
          onChange={(e) => {
            setTitle(e.target.value);
            setError("title", undefined);
          }}
          onBlur={() => setError("title", checkTitle())}
        />
        <FieldShell name="body" label="Description" error={errors.body}>
          {(a) => (
            <MarkdownEditor
              id={a.id}
              value={body}
              onChange={(v) => {
                setBody(v);
                setError("body", undefined);
              }}
              onBlur={() => setError("body", checkBody())}
              {...(a.describedBy ? { "aria-describedby": a.describedBy } : {})}
            />
          )}
        </FieldShell>
        <FieldShell
          name="assignee"
          label="Assignee"
          error={errors.assignee}
          help="Assigning sends the task to the agent's session right away."
        >
          {(a) => (
            <AgentPicker
              id={a.id}
              value={assignee}
              describedBy={a.describedBy}
              onChange={(v) => {
                setAssignee(v);
                setError("assignee", undefined);
              }}
            />
          )}
        </FieldShell>
        <DependencyEditor
          value={deps}
          resolved={resolved}
          error={errors.dependsOn}
          onChange={(v) => {
            setDeps(v);
            setError("dependsOn", undefined);
          }}
          onBlur={() => void checkDeps().then((r) => setError("dependsOn", r?.error))}
        />
        <div className="grid gap-1">
          <LinkEditor
            rows={rows}
            onChange={(next) => {
              setRows(next);
              setError("links", undefined);
            }}
            errors={rowErrors}
            onBlurRow={() => checkRows()}
          />
          {errors.links && !Object.values(rowErrors).some(Boolean) && (
            <p className="text-[0.8125rem] leading-[1.125rem] text-destructive">{errors.links}</p>
          )}
        </div>
        {failed && (
          <p role="alert" className="text-[0.8125rem] leading-[1.125rem] text-destructive">
            Couldn't create the task. Try again.
          </p>
        )}
        <div className="flex items-center gap-2">
          <Button type="submit" disabled={pending}>
            {pending ? "Creating…" : "Create task"}
          </Button>
          <Button type="button" variant="ghost" asChild>
            <Link to="/tasks" search={{}}>
              Cancel
            </Link>
          </Button>
        </div>
      </fieldset>
    </form>
  );
}
