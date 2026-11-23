import { ApiError, taskBodySchema, taskTitleSchema } from "@open-factory/shared";
import { useQuery } from "@tanstack/react-query";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { FieldShell } from "@/components/field-shell";
import { FormField } from "@/components/form-field";
import { useOutcome } from "@/components/forms/form-outcome";
import { useFieldErrors } from "@/components/forms/use-field-errors";
import { MarkdownEditor } from "@/components/markdown/markdown-editor";
import type { ComboOption } from "@/components/ui/combobox";
import { SheetBody } from "@/components/ui/sheet";
import { AgentCombobox } from "@/features/agents/agent-combobox";
import { agentsListQueryOptions } from "@/features/session/api";
import { type DraftKey, useSheetDraft } from "@/features/sheets/drafts";
import { useFocusOnOpen } from "@/features/sheets/focus-on-open";
import { SheetFormFooter } from "@/features/sheets/form-footer";
import { MoreOptions } from "@/features/sheets/more-options";
import { FORM_MSG } from "@/lib/form-messages.ts";
import type { CreateTaskBody } from "./api";
import { checkDependencies, DependencyEditor } from "./dependency-editor";
import { checkLink, LinkEditor, type LinkRow, linkRowErrors, rowsToInput } from "./link-editor";

type Values = { title: string; body: string; assignee: string; deps: string; rows: LinkRow[] };
const blank = (prefill?: { assignee?: string }): Values => ({
  title: "",
  body: "",
  assignee: prefill?.assignee ?? "",
  deps: "",
  rows: [],
});

const UNASSIGNED: ComboOption[] = [{ value: "", label: "Unassigned", fixed: true }];
const FIELDS = ["title", "assignee", "body", "dependsOn", "links"] as const;
type Field = (typeof FIELDS)[number];

const firstIssue = (r: { success: boolean; error?: { issues: { message: string }[] } }) =>
  r.success ? undefined : r.error?.issues[0]?.message;

/**
 * The New task sheet's form (§8.2). Fields: Title, Assignee, Description; Dependencies and Links sit in More options,
 * which opens itself when they hold values, and again on every submit that finds an error in them. Validation timing
 * and focus belong to `useFieldErrors`; the dependency lookup is async, so its result is passed to the submit as
 * `extra`. Server field errors map to their fields. Values live in the draft; a restored draft keeps its own
 * assignee, and a prefill applies to an empty one.
 */
export function TaskForm({
  draftKey,
  prefill,
  onSubmit,
  onDiscard,
}: {
  draftKey: DraftKey;
  prefill?: { assignee?: string };
  onSubmit(body: CreateTaskBody): Promise<void>;
  /** After Discard: the form is back to its blank start, prefill included. */
  onDiscard?(): void;
}) {
  const draft = useSheetDraft<Values>(draftKey, () => blank(prefill));
  const values = useRef<Values>(draft.start);
  const [v, setV] = useState<Values>(draft.start);
  const [restored, setRestored] = useState(draft.restored);
  const [resolvedKeys, setResolvedKeys] = useState<string[]>([]);
  // Which rows' notes may show their message: a row joins on its blur, every row on submit.
  const [checkedRows, setCheckedRows] = useState<ReadonlySet<string>>(() => new Set());
  const [userOpen, setUserOpen] = useState<boolean | undefined>(undefined);
  const [bodyView, setBodyView] = useState<"write" | "preview">("write");
  const [pending, setPending] = useState(false);
  const o = useOutcome();
  const inFlight = useRef(false);
  const form = useRef<HTMLFormElement>(null);
  useFocusOnOpen(form);
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

  const checks = {
    title: () => firstIssue(taskTitleSchema.safeParse(title)),
    body: () => firstIssue(taskBodySchema.safeParse(body)),
    // Every row, blurred or not, so a bad row blocks the submit.
    links: () => rows.map((r) => checkLink(r, known)).find(Boolean),
  };
  const f = useFieldErrors<Field>({ form, fields: FIELDS, checks });

  // A reference that no longer points at a live agent reads as empty at once, with its reason under the field, set
  // during render so it shows in the commit that empties the field; the stored value is cleared in the effect below.
  const stale = Boolean(
    v.assignee &&
      active.data &&
      ended.data &&
      !active.data.some((a) => a.slug === v.assignee && !a.archivedAt && !a.terminatedAt),
  );
  const assignee = stale ? "" : v.assignee;
  const staleSlug = v.assignee;
  const staleEnded =
    stale && [...(active.data ?? []), ...(ended.data ?? [])].some((a) => a.slug === staleSlug);
  const staleError = stale ? (staleEnded ? FORM_MSG.agentEnded : FORM_MSG.agentMissing) : undefined;
  // Guarded, not left to the updater's bail-out: any setState call during render schedules another render, even one
  // whose updater returns the same state, so an unguarded call loops.
  if (staleError && f.errors.assignee !== staleError) f.set("assignee", staleError);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `update` and `draft.rebase` only write refs, the draft and state
  useEffect(() => {
    if (!staleError) return;
    // A stale prefill cleared is not an edit: the cleared form is the new baseline, so it leaves no draft. `restored`
    // is the form's own state, so after Discard the prefill counts as a fresh one.
    if (!restored && staleSlug === prefill?.assignee)
      draft.rebase({ ...blank(prefill), assignee: "" });
    update({ assignee: "" });
  }, [staleError]);

  // A failing submit with an error inside More options reopens it, even over the user's fold (§6.5).
  const [seenAttempt, setSeenAttempt] = useState(f.attempt);
  if (f.attempt !== seenAttempt) {
    setSeenAttempt(f.attempt);
    if (f.errors.dependsOn || f.errors.links) setUserOpen(undefined);
  }
  const hasValues = deps.trim() !== "" || rows.length > 0;
  const moreOpen = userOpen ?? (hasValues || Boolean(f.errors.dependsOn || f.errors.links));

  const rowErrors = linkRowErrors(rows, known, checkedRows, f.errors.links);

  async function submit(ev: FormEvent) {
    ev.preventDefault();
    // A ref, not `pending`: a second Enter can arrive before the first one's state has rendered.
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      o.clear();
      // The textarea exists only in Write, and its tab panel mounts one commit after the switch: switch here, before
      // the lookup's await, so this event's commit has mounted it by the time the submit focuses it.
      if (checks.body()) setBodyView("write");
      const r = await checkDependencies(deps).catch(() => undefined);
      if (r) setResolvedKeys(r.keys);
      setCheckedRows(new Set(rows.map((x) => x.id)));
      if (!f.submit(undefined, { dependsOn: r?.error })) return;
      // The lookup failed: nothing to submit the keys from.
      if (!r) {
        o.fail(FORM_MSG.createTaskFailed);
        return;
      }
      setPending(true);
      try {
        await onSubmit({
          title: title.trim(),
          body,
          ...(assignee ? { assignee } : {}),
          dependsOn: r.keys,
          links: rowsToInput(rows),
        });
      } catch (err) {
        const fields =
          err instanceof ApiError ? { ...(err.body.fields as Record<string, string>) } : {};
        // With no rows, a links error has no note to sit in.
        const linksOutcome = rows.length === 0 ? fields.links : undefined;
        if (linksOutcome) delete fields.links;
        // Re-enabled in the commit that focuses the field.
        setPending(false);
        const mapped = f.server(fields);
        if (linksOutcome) o.fail(linksOutcome);
        else if (!mapped) o.fail(FORM_MSG.createTaskFailed);
      }
    } finally {
      inFlight.current = false;
    }
  }

  return (
    <form ref={form} onSubmit={submit} noValidate className="flex min-h-0 flex-1 flex-col">
      <SheetBody className="field-stack">
        <fieldset disabled={pending} className="field-stack">
          <FormField
            name="title"
            label="Title"
            value={title}
            error={f.errors.title}
            autoComplete="off"
            onChange={(e) => {
              update({ title: e.target.value });
              f.change("title");
            }}
            onBlur={(e) => f.blur("title", e)}
          />
          <FieldShell
            name="assignee"
            label="Assignee"
            error={f.errors.assignee}
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
                  f.change("assignee");
                }}
              />
            )}
          </FieldShell>
          <FieldShell name="body" label="Description" error={f.errors.body}>
            {(a) => (
              <MarkdownEditor
                id={a.id}
                value={body}
                invalid={Boolean(f.errors.body)}
                view={bodyView}
                onViewChange={setBodyView}
                onChange={(next) => {
                  update({ body: next });
                  f.change("body");
                }}
                onBlur={() => f.blur("body")}
                {...(a.describedBy ? { "aria-describedby": a.describedBy } : {})}
              />
            )}
          </FieldShell>
          <MoreOptions open={moreOpen} onOpenChange={setUserOpen}>
            <DependencyEditor
              value={deps}
              resolvedKeys={resolvedKeys}
              error={f.errors.dependsOn}
              onChange={(next) => {
                setUserOpen((open) => open ?? true);
                update({ deps: next });
                f.change("dependsOn");
              }}
              onBlur={() => {
                // Focus leaving the window is not a leave (D11).
                if (!document.hasFocus()) return;
                const text = deps;
                checkDependencies(text).then(
                  (r) => {
                    // A lookup that returns after the keys changed answers for old keys.
                    if (values.current.deps !== text) return;
                    setResolvedKeys(r.keys);
                    // Blur only adds: an edit clears through `f.change`, so a server error survives tabbing out.
                    if (r.error) f.set("dependsOn", r.error);
                  },
                  // A failed lookup on leave says nothing; the submit says it.
                  () => {},
                );
              }}
            />
            <LinkEditor
              rows={rows}
              onChange={(next) => {
                setUserOpen((open) => open ?? true);
                update({ rows: next });
                f.change("links");
              }}
              errors={rowErrors}
              onBlurRow={(id, e) => {
                setCheckedRows((s) => (s.has(id) ? s : new Set(s).add(id)));
                f.blur("links", e);
              }}
            />
          </MoreOptions>
        </fieldset>
      </SheetBody>
      <SheetFormFooter
        outcome={o.outcome}
        submitLabel="Create task"
        pendingLabel="Creating…"
        pending={pending}
        restored={restored}
        onDiscard={() => {
          draft.clear();
          const fresh = blank(prefill);
          values.current = fresh;
          setV(fresh);
          f.reset();
          o.clear();
          setCheckedRows(new Set());
          setResolvedKeys([]);
          setBodyView("write");
          setUserOpen(undefined);
          setRestored(false);
          onDiscard?.();
        }}
      />
    </form>
  );
}
