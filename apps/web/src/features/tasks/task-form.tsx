import { ApiError, type TaskSummary, taskBodySchema, taskTitleSchema } from "@open-factory/shared";
import { useQuery } from "@tanstack/react-query";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { FieldShell } from "@/components/field-shell";
import { FormField } from "@/components/form-field";
import { MarkdownEditor } from "@/components/markdown/markdown-editor";
import type { ComboOption } from "@/components/ui/combobox";
import { SheetBody } from "@/components/ui/sheet";
import { AgentCombobox } from "@/features/agents/agent-combobox";
import { agentsListQueryOptions } from "@/features/session/api";
import { type DraftKey, useSheetDraft } from "@/features/sheets/drafts";
import { SheetFormFooter } from "@/features/sheets/form-footer";
import { MoreOptions } from "@/features/sheets/more-options";
import type { CreateTaskBody } from "./api";
import { checkDependencies, DependencyEditor } from "./dependency-editor";
import { checkLink, LinkEditor, type LinkRow, rowsToInput } from "./link-editor";

type Values = { title: string; body: string; assignee: string; deps: string; rows: LinkRow[] };
const blank = (prefill?: { assignee?: string }): Values => ({
  title: "",
  body: "",
  assignee: prefill?.assignee ?? "",
  deps: "",
  rows: [],
});

const UNASSIGNED: ComboOption[] = [{ value: "", label: "Unassigned", fixed: true }];
const FIELDS = ["title", "body", "assignee", "dependsOn", "links"] as const;
type Field = (typeof FIELDS)[number];
type Errors = Partial<Record<Field, string>>;

const firstIssue = (r: { success: boolean; error?: { issues: { message: string }[] } }) =>
  r.success ? undefined : r.error?.issues[0]?.message;

/**
 * The New task sheet's form (§8.2). Fields: Title, Assignee, Description; Dependencies and Links sit in More options,
 * which opens itself when they hold values or an error. Each field validates when you leave it, never while you type,
 * and everything again on submit, which moves focus to the first invalid field. Server field errors map to their
 * fields. Values live in the draft; a restored draft keeps its own assignee, and a prefill applies to an empty one.
 */
export function TaskForm({
  draftKey,
  prefill,
  onSubmit,
}: {
  draftKey: DraftKey;
  prefill?: { assignee?: string };
  onSubmit(body: CreateTaskBody): Promise<void>;
}) {
  const draft = useSheetDraft<Values>(draftKey, () => blank(prefill));
  const values = useRef<Values>(draft.start);
  const [v, setV] = useState<Values>(draft.start);
  const [restored, setRestored] = useState(draft.restored);
  const [resolved, setResolved] = useState<TaskSummary[]>([]);
  const [errors, setErrors] = useState<Errors>({});
  const [rowErrors, setRowErrors] = useState<Record<string, string | undefined>>({});
  const [userOpen, setUserOpen] = useState<boolean | undefined>(undefined);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const inFlight = useRef(false);
  const form = useRef<HTMLFormElement>(null);
  const active = useQuery(agentsListQueryOptions("exclude"));
  const ended = useQuery(agentsListQueryOptions("only"));
  const known =
    active.data && ended.data
      ? new Set([...active.data, ...ended.data].map((a) => a.slug))
      : undefined;

  /** Writes through a ref, so the draft never lags a render. */
  const update = (patch: Partial<Values>) => {
    values.current = { ...values.current, ...patch };
    setV(values.current);
    draft.save(values.current);
  };
  const { title, body, deps, rows } = v;

  // A reference that no longer points at a live agent reads as empty at once, with its reason under the field;
  // the stored value is cleared in the effect below.
  const stale = Boolean(
    v.assignee &&
      active.data &&
      !active.data.some((a) => a.slug === v.assignee && !a.archivedAt && !a.terminatedAt),
  );
  const assignee = stale ? "" : v.assignee;
  const staleSlug = v.assignee;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `update` only writes the ref, the draft and state
  useEffect(() => {
    if (!stale) return;
    update({ assignee: "" });
    setErrors((e) => ({ ...e, assignee: `@${staleSlug} has ended; pick another.` }));
  }, [stale, staleSlug]);

  const hasValues = deps.trim() !== "" || rows.length > 0;
  const hasError = Boolean(errors.dependsOn || errors.links);
  const moreOpen = userOpen ?? (hasValues || hasError);

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
  /** Rendered before focusing: a field inside a folded More options only exists once it is open. */
  const show = (e: Errors) =>
    flushSync(() => {
      setErrors(e);
      if (e.dependsOn || e.links) setUserOpen(undefined);
    });

  async function submit(ev: FormEvent) {
    ev.preventDefault();
    // A ref, not `pending`: a second Enter can arrive before the first one's state has rendered.
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      setFailed(false);
      const checked = await checkDeps();
      const found: Errors = {
        title: checkTitle(),
        body: checkBody(),
        dependsOn: checked?.error,
        links: checkRows(),
      };
      show(found);
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
            show(e);
            // The form is still disabled until the next render: focus once it is enabled again.
            queueMicrotask(() => focus(FIELDS.find((f) => e[f]) as Field));
            return;
          }
        }
        setFailed(true);
      }
    } finally {
      inFlight.current = false;
    }
  }

  return (
    <form ref={form} onSubmit={submit} noValidate className="flex min-h-0 flex-1 flex-col">
      <SheetBody className="grid content-start gap-5">
        <fieldset disabled={pending} className="grid min-w-0 gap-5">
          <FormField
            name="title"
            label="Title"
            value={title}
            error={errors.title}
            autoComplete="off"
            onChange={(e) => {
              update({ title: e.target.value });
              setError("title", undefined);
            }}
            onBlur={() => setError("title", checkTitle())}
          />
          <FieldShell
            name="assignee"
            label="Assignee"
            error={errors.assignee}
            help="Assigning sends the task to the agent's session right away."
          >
            {(a) => (
              <AgentCombobox
                id={a.id}
                aria-label="Assignee"
                scope="live"
                fixed={UNASSIGNED}
                value={assignee || null}
                aria-invalid={a.invalid || undefined}
                aria-describedby={a.describedBy}
                onValueChange={(next) => {
                  update({ assignee: next ?? "" });
                  setError("assignee", undefined);
                }}
              />
            )}
          </FieldShell>
          <FieldShell name="body" label="Description" error={errors.body}>
            {(a) => (
              <MarkdownEditor
                id={a.id}
                value={body}
                onChange={(next) => {
                  update({ body: next });
                  setError("body", undefined);
                }}
                onBlur={() => setError("body", checkBody())}
                {...(a.describedBy ? { "aria-describedby": a.describedBy } : {})}
              />
            )}
          </FieldShell>
          <MoreOptions open={moreOpen} onOpenChange={setUserOpen}>
            <DependencyEditor
              value={deps}
              resolved={resolved}
              error={errors.dependsOn}
              onChange={(next) => {
                setUserOpen((o) => o ?? true);
                update({ deps: next });
                setError("dependsOn", undefined);
              }}
              onBlur={() => void checkDeps().then((r) => setError("dependsOn", r?.error))}
            />
            <div className="grid gap-1">
              <LinkEditor
                rows={rows}
                onChange={(next) => {
                  setUserOpen((o) => o ?? true);
                  update({ rows: next });
                  setError("links", undefined);
                }}
                errors={rowErrors}
                onBlurRow={() => checkRows()}
              />
              {errors.links && !Object.values(rowErrors).some(Boolean) && (
                <p className="text-[0.8125rem] leading-[1.125rem] text-destructive">
                  {errors.links}
                </p>
              )}
            </div>
          </MoreOptions>
          {failed && (
            <p role="alert" className="text-[0.8125rem] leading-[1.125rem] text-destructive">
              Couldn't create the task. Try again.
            </p>
          )}
        </fieldset>
      </SheetBody>
      <SheetFormFooter
        submitLabel="Create task"
        pendingLabel="Creating…"
        pending={pending}
        restored={restored}
        onDiscard={() => {
          draft.clear();
          const fresh = blank(prefill);
          values.current = fresh;
          setV(fresh);
          setErrors({});
          setRowErrors({});
          setResolved([]);
          setUserOpen(undefined);
          setRestored(false);
        }}
      />
    </form>
  );
}
