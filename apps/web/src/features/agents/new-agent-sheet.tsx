import {
  type AgentSummary,
  ApiError,
  type CreateAgentBody,
  type PatchAgentBody,
} from "@open-factory/shared";
import {
  useQueries,
  useQuery,
  useQueryClient,
  useSuspenseQueries,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import {
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import { FieldShell } from "@/components/field-shell";
import { FormField } from "@/components/form-field";
import { Button } from "@/components/ui/button";
import type { ComboOption } from "@/components/ui/combobox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SheetBody } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { notify } from "@/components/ui/toaster";
import { AddressLine } from "@/features/agents/address-line";
import { AgentCombobox, type AgentOpt } from "@/features/agents/agent-combobox";
import { useAgentFormState } from "@/features/agents/agent-form-state";
import { agentsListQueryOptions, createAgent } from "@/features/agents/api";
import { deriveSlug, useTakenNames } from "@/features/agents/derive-slug";
import { ProjectGrantPicker } from "@/features/agents/project-grant-picker";
import { showOutput } from "@/features/agents/show-output";
import {
  TemplateField,
  type TemplateOption,
  TemplateSummary,
} from "@/features/agents/template-field";
import {
  credentialsQueryOptions,
  projectsQueryOptions,
  usersQueryOptions,
} from "@/features/settings/api";
import { clearDraft, clearDraftIf, draftGeneration, peekDraft } from "@/features/sheets/drafts";
import { SheetFormFooter } from "@/features/sheets/form-footer";
import { MoreOptions } from "@/features/sheets/more-options";
import type { BodyProps } from "@/features/sheets/sheet-bodies";
import {
  closeSheet,
  getSheetState,
  openChildSheet,
  openSheet,
  returnFocusAfterChild,
} from "@/features/sheets/sheet-store";
import { templateQueryOptions, templatesQueryOptions } from "@/features/templates/api";
import { isMobileNow } from "@/hooks/use-mobile";

type Spec = { kind: "new-agent"; template?: string };

const NO_MANAGER: ComboOption[] = [
  { value: "", label: "No manager (reports to the humans)", fixed: true },
];
const KIND_LABEL = { oauth_token: "OAuth token", api_key: "API key" } as const;
const EMPTY: ReadonlySet<string> = new Set();
/** A spawned agent never manages. */
const canManage = (a: AgentOpt) => a.kind === "persistent";
const SHEET_CONTENT = "[data-slot=sheet-content], [data-slot=drawer-content]";
// biome-ignore lint/suspicious/noThenProperty: ChildSpec's field, not a thenable
const NEW_TEMPLATE = { kind: "new-template", then: "return" } as const;
const TAKEN_LISTS = [
  agentsListQueryOptions("exclude"),
  agentsListQueryOptions("only"),
  usersQueryOptions,
] as const;

/**
 * The New agent sheet body (§6.2). It renders once the credentials and templates have answered (the host's skeleton
 * holds until then, so More options' state is final at first paint); the other lists were prefetched with them.
 * Each open is a fresh form instance over the `new-agent` draft.
 */
export default function NewAgentSheet(props: BodyProps<Spec>) {
  useSuspenseQueries({ queries: [credentialsQueryOptions, templatesQueryOptions] });
  return <NewAgentForm key={props.sheetId} {...props} />;
}

function NewAgentForm({ spec, sheetId }: BodyProps<Spec>) {
  // Read here, not passed down: a stacked New template writes the list and sets Template in one flushSync that
  // re-renders only this form, so the Select must see the new item in that same commit (§7).
  const templates: TemplateOption[] = useSuspenseQuery(templatesQueryOptions).data.templates;
  const qc = useQueryClient();
  const router = useRouter();
  const taken = useTakenNames(true);
  // A list that failed can't hold the submit forever: it goes ahead without the suffix (the server still refuses).
  const takenFailed = useQueries({
    queries: TAKEN_LISTS,
    combine: (r) => r.some((q) => q.isError),
  });
  const slugFor = useCallback((name: string) => deriveSlug(name, taken ?? EMPTY), [taken]);
  const form = useRef<HTMLFormElement>(null);
  const s = useAgentFormState({
    mode: "create",
    draftKey: "new-agent",
    prefill: spec.template ? { template: spec.template } : undefined,
    slugFor,
    form,
  });
  const { values, shown, errors, set, blur, claim, pending, slow, config, pluginOutput } = s;
  const { missingSecrets, noCredentials, credentials, staleNotes } = s;
  const detail = useQuery({
    ...templateQueryOptions(values.template),
    enabled: values.template !== "",
    retry: false,
  });
  const activeAgents = useQuery(agentsListQueryOptions("exclude"));
  const projects = useQuery(projectsQueryOptions);
  // The latest shown values, for a stacked child's result that lands after this render.
  const latestShown = useRef(shown);
  useLayoutEffect(() => {
    latestShown.current = shown;
  });

  // A stacked child's result (§7): the served field takes the value and scrolls into view (instantly) before the child
  // exits, and focus lands on it after the child closes. Phones focus the drawer content, so the keyboard doesn't rise.
  // `onDone` never runs once this sheet instance has closed (the store drops it), so it writes no closed form's draft.
  const serve = (write: () => void, find: () => HTMLElement | null | undefined) => {
    flushSync(write);
    find()?.scrollIntoView({ block: "nearest", behavior: "instant" });
    returnFocusAfterChild(() =>
      isMobileNow()
        ? (form.current?.closest<HTMLElement>("[data-slot=drawer-content]") ?? null)
        : (find() ?? null),
    );
  };
  const byId = (id: string) => () => form.current?.querySelector<HTMLElement>(`#${id}`);
  const onAddCredential = () =>
    openChildSheet({ kind: "add-credential" }, (name) =>
      serve(() => set("credential", name), byId("field-credential")),
    );
  const onAddProject = () =>
    openChildSheet({ kind: "add-project" }, (name) =>
      serve(
        // Joins the grant set as an override (setProjects).
        () => s.setProjects([...latestShown.current.projects.filter((p) => p !== name), name]),
        () => form.current?.querySelector<HTMLElement>(`[data-project="${CSS.escape(name)}"]`),
      ),
    );
  // The warning disappears with the secrets cache; Template is the field it served.
  const onAddSecret = (name: string) =>
    openChildSheet({ kind: "add-secret", name }, () => serve(() => {}, byId("field-template")));
  const onNewTemplate = () =>
    openChildSheet(NEW_TEMPLATE, (name) =>
      serve(() => set("template", name), byId("field-template")),
    );
  const addCredential = (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      inForm
      data-skip-validate
      onClick={onAddCredential}
    >
      <Plus aria-hidden="true" data-icon="inline-start" />
      Add credential
    </Button>
  );

  // An unknown or broken template name counts as none (the field shows it unchosen).
  const chosen = templates.some((t) => t.name === values.template && t.errors === 0);
  // Focus on open: phones the drawer content (the keyboard doesn't rise mid-slide); desktop Template when none is
  // chosen, else Display name. Not when focus is already somewhere in the sheet (the user moved it while the skeleton
  // showed). Once, on mount.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, when the body mounts
  useEffect(() => {
    const el = form.current;
    const content = el?.closest<HTMLElement>(SHEET_CONTENT);
    const at = document.activeElement;
    // The host parks focus on the panel itself until the body mounts; only focus elsewhere inside it is kept.
    if (!el || (at && at !== content && content?.contains(at))) return;
    if (isMobileNow()) {
      content?.focus({ preventScroll: true });
      return;
    }
    const target =
      (chosen ? null : el.querySelector<HTMLElement>("#field-template")) ??
      el.querySelector<HTMLElement>("#field-displayName");
    target?.focus({ preventScroll: true });
  }, []);

  // The address field opens itself, focused, when Display name is left with a name that derives nothing.
  const [forceSlug, setForceSlug] = useState(false);
  const onSlugOpened = useCallback(() => setForceSlug(false), []);

  // More options opens itself, once per reason, and says why (§6.2); the user can fold it again.
  const several = (credentials?.length ?? 0) > 1;
  let reason: ReactNode;
  let reasonKey = "";
  if (noCredentials) {
    reason = "No Claude credential yet.";
    reasonKey = "no-credential";
  } else if (several && shown.credential === "") {
    reason = "Choose a credential.";
    reasonKey = "choose-credential";
  } else if (missingSecrets.length === 1) {
    reason = (
      <>
        Secret <code className="font-mono">{missingSecrets[0]}</code> isn't set.
      </>
    );
    reasonKey = `secrets:${missingSecrets.join(",")}`;
  } else if (missingSecrets.length > 1) {
    reason = `${missingSecrets.length} secrets aren't set.`;
    reasonKey = `secrets:${missingSecrets.join(",")}`;
  }
  // While a field inside has an error, every focus request (a failing submit, a mapped server error) reopens it, even
  // over the user's fold (§6.5).
  const inner = (["description", "credential", "projects"] as const).filter((f) => errors[f]);
  const autoKey = [
    reasonKey,
    staleNotes.credential || staleNotes.projects ? "stale" : "",
    inner.length > 0 ? `errors:${inner.join(",")}` : "",
    inner.length > 0 ? `attempt:${s.attempt}` : "",
  ]
    .filter(Boolean)
    .join("|");
  const [moreOpen, setMoreOpen] = useState(false);
  const [openedFor, setOpenedFor] = useState("");
  if (autoKey && autoKey !== openedFor) {
    setOpenedFor(autoKey);
    setMoreOpen(true);
  }

  const stillOpen = () => getSheetState().parent?.id === sheetId;
  async function create(body: CreateAgentBody | PatchAgentBody) {
    // A create body always names its template; a patch never does.
    if (!("template" in body)) return;
    // A late result is judged against what was submitted (the draft now) and the session it was sent in.
    const snapshot = peekDraft("new-agent");
    const generation = draftGeneration();
    let agent: AgentSummary;
    try {
      agent = await createAgent(body);
    } catch (err) {
      // Dismissed while creating: the error has no form to land in. The draft is kept for "Open form". Nothing is
      // said after a sign-out: the result belongs to the old session.
      if (!stillOpen() && draftGeneration() === generation)
        notify({
          text:
            err instanceof ApiError
              ? err.message
              : "Couldn't create the agent: can't reach the server.",
          action: { label: "Open form", run: () => openSheet({ kind: "new-agent" }) },
        });
      throw err;
    }
    if (draftGeneration() !== generation) return;
    // The lists refetch in the background; the session view needn't wait for them.
    void qc.invalidateQueries({ queryKey: ["agents"] });
    const open = stillOpen();
    // A late success clears the draft only if it still holds the submitted values; a New agent reopened on those
    // untouched values closes, so the same agent can't be created twice. Edits made since are kept.
    if (open) clearDraft("new-agent");
    else if (
      clearDraftIf("new-agent", snapshot) &&
      getSheetState().parent?.kind === "new-agent" &&
      !getSheetState().child // a stacked child the user opened on it (and its input) stays
    )
      closeSheet();
    const go = () => void router.navigate({ to: "/agents/$slug", params: { slug: agent.slug } });
    if (open) {
      closeSheet();
      go();
    } else {
      notify({ text: `Created @${agent.slug}.`, action: { label: "Open", run: go } });
    }
  }

  // Until the taken names have answered the derivation has no suffix, so submit waits for them (§6.3).
  const [queued, setQueued] = useState(false);
  const waitForTaken = !values.touched.slug && !taken && !takenFailed;
  const run = () => void s.submit(create);
  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (pending || queued) return;
    if (waitForTaken) setQueued(true);
    else run();
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs the queued submit once the names have answered
  useEffect(() => {
    if (!queued || waitForTaken) return;
    setQueued(false);
    run();
  }, [queued, waitForTaken]);
  const busy = pending || queued;

  return (
    <form ref={form} onSubmit={onSubmit} noValidate className="flex min-h-0 flex-1 flex-col">
      <SheetBody className="field-stack">
        <fieldset disabled={pending} className="field-stack">
          <legend className="sr-only">New agent</legend>
          <TemplateField
            value={values.template}
            onChange={(v) => set("template", v)}
            onBlur={(e) => blur("template", e)}
            templates={templates}
            error={errors.template}
            onNewTemplate={onNewTemplate}
            describedBy={config ? "template-summary" : undefined}
          >
            {config && (
              <TemplateSummary
                config={config}
                issues={detail.data?.issues ?? []}
                missingSecrets={missingSecrets}
                onAddSecret={onAddSecret}
              />
            )}
          </TemplateField>
          <div className="field-stack">
            <FormField
              name="displayName"
              label="Display name"
              error={errors.displayName}
              value={shown.displayName}
              onChange={(e) => set("displayName", e.target.value)}
              onFocus={() => claim("displayName")}
              onBlur={(e) => {
                blur("displayName", e);
                if (!values.touched.slug && shown.displayName.trim() !== "" && !shown.slug)
                  setForceSlug(true);
              }}
              autoComplete="off"
            />
            <AddressLine
              name={shown.displayName}
              slug={values.slug}
              slugTouched={Boolean(values.touched.slug)}
              onSlug={(v) => set("slug", v)}
              onBlur={(e) => blur("slug", e)}
              error={errors.slug}
              forceOpen={forceSlug}
              onOpened={onSlugOpened}
            />
          </div>
          <FieldShell
            name="reportsTo"
            label="Manager"
            error={errors.reportsTo}
            help={staleNotes.reportsTo}
          >
            {(a) => (
              <AgentCombobox
                id={a.id}
                aria-label="Manager"
                scope="live"
                order="tree"
                fixed={NO_MANAGER}
                filter={canManage}
                disabled={!activeAgents.data}
                value={shown.reportsTo || null}
                aria-invalid={a.invalid || undefined}
                aria-describedby={a.describedBy}
                onValueChange={(v) => set("reportsTo", v ?? "")}
              />
            )}
          </FieldShell>
          <MoreOptions open={moreOpen} onOpenChange={setMoreOpen} reason={reason}>
            <FieldShell name="description" label="Description" error={errors.description}>
              {(a) => (
                <Textarea
                  id={a.id}
                  name="description"
                  rows={3}
                  data-vaul-no-drag=""
                  aria-invalid={a.invalid || undefined}
                  aria-describedby={a.describedBy}
                  value={shown.description}
                  onChange={(e) => set("description", e.target.value)}
                  onFocus={() => claim("description")}
                  onBlur={(e) => blur("description", e)}
                />
              )}
            </FieldShell>
            {noCredentials ? (
              // More options' summary says "No Claude credential yet."; the field offers to add one.
              <div className="flex min-h-7 items-center justify-between gap-2">
                <p className="text-[0.8125rem] font-medium">Credential</p>
                {addCredential}
              </div>
            ) : (
              <FieldShell
                name="credential"
                label="Credential"
                error={errors.credential}
                help={staleNotes.credential}
                action={addCredential}
              >
                {(a) => (
                  <Select value={shown.credential} onValueChange={(v) => set("credential", v)}>
                    <SelectTrigger
                      id={a.id}
                      aria-invalid={a.invalid || undefined}
                      aria-describedby={a.describedBy}
                      onBlur={(e) => blur("credential", e)}
                    >
                      <SelectValue placeholder="Choose a credential" />
                    </SelectTrigger>
                    <SelectContent>
                      {credentials?.map((c) => (
                        <SelectItem key={c.name} value={c.name}>
                          {`${c.name}: ${KIND_LABEL[c.kind]}`}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </FieldShell>
            )}
            <ProjectGrantPicker
              projects={projects.data}
              value={shown.projects}
              custom={s.custom}
              error={errors.projects}
              help={staleNotes.projects}
              onChange={s.setProjects}
              onUseDefault={s.applyTemplateDefault}
              onAddProject={onAddProject}
            />
          </MoreOptions>
        </fieldset>
      </SheetBody>
      <SheetFormFooter
        submitLabel="Create agent"
        pendingLabel="Creating…"
        pending={busy}
        restored={s.restored}
        onDiscard={s.discard}
        submitClassName="min-w-32"
        outcome={{
          ...s.outcome,
          notice: slow ? "Installing plugins…" : undefined,
          action: pluginOutput ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() =>
                showOutput({
                  title: "Plugin install output",
                  description: "The output of the failed plugin install.",
                  output: pluginOutput,
                })
              }
            >
              Show output
            </Button>
          ) : undefined,
        }}
      />
    </form>
  );
}
