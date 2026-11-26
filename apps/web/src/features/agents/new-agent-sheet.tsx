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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SheetBody } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { notify } from "@/components/ui/toaster";
import { AddressLine } from "@/features/agents/address-line";
import { useAgentFormState } from "@/features/agents/agent-form-state";
import {
  agentsListQueryOptions,
  createAgent,
  type ModelEffort,
  saveModelEffort,
} from "@/features/agents/api";
import { deriveHandle, useTakenNames } from "@/features/agents/derive-handle";
import { MANAGE_ORG_HELP } from "@/features/agents/manage-org-help";
import { ManagerCombobox } from "@/features/agents/manager-combobox";
import { ModelEffortFields } from "@/features/agents/model-effort-fields";
import { ProjectGrantPicker } from "@/features/agents/project-grant-picker";
import {
  TemplateField,
  type TemplateOption,
  TemplateSummary,
} from "@/features/agents/template-field";
import {
  credentialsQueryOptions,
  projectsQueryOptions,
  secretsQueryOptions,
  usersQueryOptions,
} from "@/features/settings/api";
import { AddCredentialForm } from "@/features/settings/forms/add-credential-form";
import { AddProjectForm } from "@/features/settings/forms/add-project-form";
import { AddSecretForm } from "@/features/settings/forms/add-secret-form";
import { setupQueryOptions } from "@/features/setup/api";
import {
  clearDraft,
  clearDraftIf,
  clearInlineDrafts,
  draftGeneration,
  inlineKey,
  peekDraft,
} from "@/features/sheets/drafts";
import { SheetFormFooter } from "@/features/sheets/form-footer";
import {
  InlineAddTrigger,
  useInlineAdd,
  usePrerequisiteGuards,
} from "@/features/sheets/inline-add";
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
import { FORM_MSG } from "@/lib/form-messages.ts";

type Spec = { kind: "new-agent"; template?: string };

const KIND_LABEL = { oauth_token: "OAuth token", api_key: "API key" } as const;
const EMPTY: ReadonlySet<string> = new Set();
/** A spawned agent never manages. */
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
  const handleFor = useCallback((name: string) => deriveHandle(name, taken ?? EMPTY), [taken]);
  const form = useRef<HTMLFormElement>(null);
  const s = useAgentFormState({
    mode: "create",
    draftKey: "new-agent",
    prefill: spec.template ? { template: spec.template } : undefined,
    handleFor,
    form,
  });
  const { values, shown, errors, set, blur, claim, pending, config } = s;
  const { missingSecrets, noCredentials, credentials, staleNotes } = s;
  const detail = useQuery({
    ...templateQueryOptions(values.template),
    enabled: values.template !== "",
    retry: false,
  });
  const projects = useQuery(projectsQueryOptions);
  const secrets = useQuery(secretsQueryOptions);
  // The latest shown values, for an inline form's result that lands after this render.
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
  const guards = usePrerequisiteGuards();
  const credentialAdd = useInlineAdd({
    draftKey: inlineKey("new-agent", "credential"),
    guards,
    noun: "credential",
  });
  const projectAdd = useInlineAdd({
    draftKey: inlineKey("new-agent", "project"),
    guards,
    noun: "project",
  });
  const secretAdd = useInlineAdd({
    draftKey: inlineKey("new-agent", "secret"),
    guards,
    noun: "secret",
  });
  // "Added <name>." under Credential, until the pick changes.
  const [credentialNote, setCredentialNote] = useState<string>();
  const byId = (id: string) => () => form.current?.querySelector<HTMLElement>(`#${id}`);
  const onNewTemplate = () =>
    openChildSheet(NEW_TEMPLATE, (name) =>
      serve(() => set("template", name), byId("field-template")),
    );
  const addCredential = <InlineAddTrigger add={credentialAdd}>Add credential</InlineAddTrigger>;
  const credentialForm = credentialAdd.open && (
    <AddCredentialForm
      key={credentialAdd.round}
      frame="embedded"
      embed={credentialAdd.embed}
      existing={(credentials ?? []).map((c) => c.name)}
      onCancel={credentialAdd.cancel}
      onDone={(c) =>
        void credentialAdd.finish(
          credentialsQueryOptions.queryKey,
          c,
          () => {
            set("credential", c.name);
            setCredentialNote(`Added ${c.name}.`);
          },
          byId("field-credential"),
        )
      }
    />
  );
  const projectForm = projectAdd.open && (
    <AddProjectForm
      key={projectAdd.round}
      frame="embedded"
      embed={projectAdd.embed}
      existing={(projects.data ?? []).map((p) => p.name)}
      onCancel={projectAdd.cancel}
      onDone={(p) =>
        void projectAdd.finish(
          projectsQueryOptions.queryKey,
          p,
          // Joins the grant set as an override (setProjects).
          () =>
            s.setProjects([...latestShown.current.projects.filter((x) => x !== p.name), p.name]),
          () => form.current?.querySelector<HTMLElement>(`[data-project="${CSS.escape(p.name)}"]`),
        )
      }
    />
  );
  const secretNames = (secrets.data ?? []).map((x) => x.name);
  const secretForm = secretAdd.open && (
    <AddSecretForm
      key={secretAdd.round}
      frame="embedded"
      embed={secretAdd.embed}
      initialName={secretAdd.embed.start.name ?? ""}
      existing={secretNames}
      onCancel={secretAdd.cancel}
      // The warning goes with the secrets cache; Template is the field it served.
      onDone={(x) =>
        void secretAdd.finish(secretsQueryOptions.queryKey, x, () => {}, byId("field-template"))
      }
    />
  );

  // An unknown or broken template name counts as none (the field shows it unchosen).
  const chosen = templates.some((t) => t.name === values.template && t.errors === 0);
  // The sheet's own focus on open isn't the user entering Display name: it doesn't claim the field from the prefill.
  const focusingOnOpen = useRef(false);
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
    focusingOnOpen.current = true;
    target?.focus({ preventScroll: true });
    focusingOnOpen.current = false;
  }, []);

  // The address field opens itself, focused, when Display name is left with a name that derives nothing.
  const [forceRef, setForceRef] = useState(false);
  const onRefOpened = useCallback(() => setForceRef(false), []);

  // More options opens itself, once per reason, and says why (§6.2); the user can fold it again.
  const several = (credentials?.length ?? 0) > 1;
  let reason: ReactNode;
  let reasonKey = "";
  if (noCredentials) {
    reason = "No Claude credential yet.";
    reasonKey = "no-credential";
  } else if (several && shown.credential === "") {
    reason = FORM_MSG.chooseCredential;
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
  // An open inline form lives in here: it keeps it open, and brings it back open with a restored draft.
  const inlineOpen = credentialAdd.open || projectAdd.open;
  const autoKey = [
    reasonKey,
    inlineOpen ? "inline" : "",
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
  async function create(body: CreateAgentBody | PatchAgentBody, modelEffort?: ModelEffort) {
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
    // An agent exists now: the first-run answer can't change back, so a cached one is flipped without a request.
    // An in-flight refetch must not land after this and put the stale `false` back.
    void qc.cancelQueries({ queryKey: setupQueryOptions.queryKey });
    qc.setQueryData(setupQueryOptions.queryKey, (d) => d && { ...d, hasAgent: true });
    // The agent exists; its model and effort are a second write. A failure doesn't undo the first: it is said below.
    let notSet: string | undefined;
    if (modelEffort)
      try {
        await saveModelEffort(qc, agent.ref, modelEffort);
      } catch (err) {
        notSet = err instanceof ApiError ? err.message : FORM_MSG.unreachable;
      }
    const open = stillOpen();
    // A late success clears the draft only if it still holds the submitted values; a New agent reopened on those
    // untouched values closes, so the same agent can't be created twice. Edits made since are kept.
    if (open) {
      clearDraft("new-agent");
      clearInlineDrafts("new-agent");
    } else if (
      clearDraftIf("new-agent", snapshot) &&
      getSheetState().parent?.kind === "new-agent" &&
      !getSheetState().child // a stacked child the user opened on it (and its input) stays
    )
      closeSheet();
    const go = () => void router.navigate({ to: "/agents/$ref/chat", params: { ref: agent.ref } });
    const created = `Created @${agent.handle}.`;
    if (notSet) {
      // Said in a toast either way: the sheet closes onto the session.
      const configure = () =>
        void router.navigate({ to: "/agents/$ref/config", params: { ref: agent.ref } });
      if (open) {
        closeSheet();
        go();
      }
      notify({
        text: `${created} Model and effort weren't set: ${notSet}`,
        action: { label: "Open configuration", run: configure },
      });
    } else if (open) {
      closeSheet();
      go();
    } else {
      notify({ text: created, action: { label: "Open", run: go } });
    }
  }

  // Until the taken names have answered the derivation has no suffix, so submit waits for them (§6.3).
  const [queued, setQueued] = useState(false);
  const waitForTaken = !values.touched.handle && !taken && !takenFailed;
  const run = () => void s.submit(create);
  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (pending || queued) return;
    // An open inline form with input in it takes focus first: the agent isn't created behind it.
    if (guards.block()) return;
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
                addSecret={secretAdd}
                secretForm={secretForm}
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
              onFocus={() => {
                if (!focusingOnOpen.current) claim("displayName");
              }}
              onBlur={(e) => {
                blur("displayName", e);
                if (!values.touched.handle && shown.displayName.trim() !== "" && !shown.handle)
                  setForceRef(true);
              }}
              autoComplete="off"
            />
            <AddressLine
              name={shown.displayName}
              handle={values.handle}
              handleTouched={Boolean(values.touched.handle)}
              onHandle={(v) => set("handle", v)}
              onBlur={(e) => blur("handle", e)}
              error={errors.handle}
              forceOpen={forceRef}
              onOpened={onRefOpened}
            />
          </div>
          <FieldShell
            name="reportsTo"
            label="Manager"
            error={errors.reportsTo}
            help={staleNotes.reportsTo}
          >
            {(a) => (
              <ManagerCombobox
                id={a.id}
                aria-label="Manager"
                value={shown.reportsTo}
                aria-invalid={a.invalid || undefined}
                aria-describedby={a.describedBy}
                onValueChange={(v) => set("reportsTo", v)}
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
              <div>
                <div className="flex min-h-7 items-center justify-between gap-2">
                  <p className="text-[0.8125rem] font-medium">Credential</p>
                  {addCredential}
                </div>
                {credentialForm}
              </div>
            ) : (
              <FieldShell
                name="credential"
                label="Credential"
                error={errors.credential}
                help={staleNotes.credential ?? credentialNote}
                action={addCredential}
                below={credentialForm}
              >
                {(a) => (
                  <Select
                    value={shown.credential}
                    onValueChange={(v) => {
                      set("credential", v);
                      setCredentialNote(undefined);
                    }}
                  >
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
              error={errors.projects}
              help={staleNotes.projects}
              onChange={s.setProjects}
              add={
                <div className="grid gap-0">
                  <div className="flex flex-wrap gap-2">
                    <InlineAddTrigger add={projectAdd}>Add project</InlineAddTrigger>
                  </div>
                  {projectForm}
                </div>
              }
            />
            <ModelEffortFields {...s.modelEffort} />
          </MoreOptions>
          <FieldShell name="manageOrg" label="Can manage the org" help={MANAGE_ORG_HELP}>
            {(a) => (
              <Switch
                id={a.id}
                className="justify-self-start"
                checked={shown.manageOrg}
                aria-describedby={a.describedBy}
                onCheckedChange={(v) => set("manageOrg", v)}
              />
            )}
          </FieldShell>
        </fieldset>
      </SheetBody>
      <SheetFormFooter
        submitLabel="Create agent"
        pendingLabel="Creating…"
        pending={busy}
        restored={s.restored}
        onDiscard={() => {
          s.discard();
          clearInlineDrafts("new-agent");
        }}
        submitClassName="min-w-32"
        outcome={s.outcome}
      />
    </form>
  );
}
