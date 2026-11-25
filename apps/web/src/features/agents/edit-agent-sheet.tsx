import {
  type AgentSummary,
  ApiError,
  type CreateAgentBody,
  type PatchAgentBody,
} from "@open-factory/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import {
  type FormEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import { ErrorLine } from "@/components/error-line";
import { FieldShell } from "@/components/field-shell";
import { FormField } from "@/components/form-field";
import { InlineOutcome } from "@/components/inline-outcome";
import { Button } from "@/components/ui/button";
import type { ComboOption } from "@/components/ui/combobox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SheetBody, SheetClose, SheetDescription, SheetFooter } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { notify } from "@/components/ui/toaster";
import { AgentCombobox, type AgentOpt } from "@/features/agents/agent-combobox";
import { useAgentFormState } from "@/features/agents/agent-form-state";
import { agentsListQueryOptions, updateAgent } from "@/features/agents/api";
import { restoreAgent } from "@/features/agents/lifecycle";
import { ProjectGrantPicker } from "@/features/agents/project-grant-picker";
import { agentDetailQueryOptions } from "@/features/session/api";
import { projectsQueryOptions } from "@/features/settings/api";
import { BodySkeleton } from "@/features/sheets/body-skeleton";
import { clearDraft, clearDraftIf, draftGeneration, peekDraft } from "@/features/sheets/drafts";
import { SheetFormFooter } from "@/features/sheets/form-footer";
import type { BodyProps } from "@/features/sheets/sheet-bodies";
import {
  closeSheet,
  getSheetState,
  openChildSheet,
  openSheet,
  returnFocusAfterChild,
} from "@/features/sheets/sheet-store";
import { isMobileNow } from "@/hooks/use-mobile";
import { FORM_MSG } from "@/lib/form-messages.ts";

type Spec = { kind: "edit-agent"; slug: string; at?: string };

const NO_MANAGER: ComboOption[] = [
  { value: "", label: "No manager (reports to the humans)", fixed: true },
];
const KIND_LABEL = { oauth_token: "OAuth token", api_key: "API key" } as const;
const andList = (items: string[]) =>
  items.length < 2 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
/** A process is running, so a save that changes anything restarts it when idle (the server restarts on every field). */
const isRunning = (a: AgentSummary) => a.status === "working" || a.status === "idle";
const SHEET_CONTENT = "[data-slot=sheet-content], [data-slot=drawer-content]";

/** "@slug · Template name", wrapping, never truncated. */
function Description({ agent }: { agent: AgentSummary }) {
  return (
    <SheetDescription className="px-4 pt-3 [overflow-wrap:anywhere]">
      <span className="font-mono text-foreground">@{agent.slug}</span> · Template{" "}
      <span className="font-mono text-foreground">{agent.template}</span>
    </SheetDescription>
  );
}

/** A state with no form: its line, and Close. */
function Plain({ agent, children }: { agent?: AgentSummary; children: ReactNode }) {
  return (
    <>
      {agent && <Description agent={agent} />}
      <SheetBody className="grid content-start justify-items-start gap-3 text-sm">
        {children}
      </SheetBody>
      <SheetFooter>
        <SheetClose asChild>
          <Button type="button" variant="ghost">
            Close
          </Button>
        </SheetClose>
      </SheetFooter>
    </>
  );
}

/** "This agent is archived." with Restore (§6.5): the button stays on screen, so its outcome is inline. Success
 *  refetches the agent and the sheet turns into the form, with any draft. */
function Archived({ agent }: { agent: AgentSummary }) {
  const qc = useQueryClient();
  const busy = useRef(false);
  const [outcome, setOutcome] = useState<{ tone: "pending" | "error"; text: string }>();
  async function restore() {
    if (busy.current) return;
    busy.current = true;
    setOutcome({ tone: "pending", text: `Restoring @${agent.slug}…` });
    const failed = await restoreAgent(agent.slug, qc, { inline: true });
    busy.current = false;
    setOutcome(failed ? { tone: "error", text: failed } : undefined);
  }
  return (
    <Plain agent={agent}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <p>This agent is archived.</p>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-disabled={outcome?.tone === "pending" || undefined}
          onClick={() => void restore()}
        >
          Restore
        </Button>
      </div>
      <InlineOutcome tone={outcome?.tone}>{outcome?.text}</InlineOutcome>
    </Plain>
  );
}

/**
 * The Edit agent sheet body (§6.4). It follows the agent live: archived, terminated or deleted elsewhere while open,
 * it flips to that state, and the draft (written on every change) is kept for when the form comes back.
 */
export default function EditAgentSheet(props: BodyProps<Spec>) {
  const { slug } = props.spec;
  const { data, error, refetch } = useQuery(agentDetailQueryOptions(slug));
  const agent = data?.agent;
  if (error instanceof ApiError && error.code === "agent_not_found")
    return <Plain>There is no agent @{slug}.</Plain>;
  if (!agent) {
    if (error)
      return (
        <Plain>
          <ErrorLine text="Couldn't load this agent." onRetry={() => void refetch()} />
        </Plain>
      );
    return <BodySkeleton kind="edit-agent" />;
  }
  if (agent.kind === "ephemeral")
    return <Plain agent={agent}>Spawned agents can't be edited.</Plain>;
  if (agent.status === "terminated") return <Plain agent={agent}>This agent is terminated.</Plain>;
  if (agent.archivedAt) return <Archived agent={agent} />;
  // A fresh form per open (and per return from a state above), over the agent's draft.
  return <EditAgentForm key={props.sheetId} {...props} agent={agent} />;
}

function EditAgentForm({ spec, sheetId, agent }: BodyProps<Spec> & { agent: AgentSummary }) {
  const qc = useQueryClient();
  const slug = agent.slug;
  const draftKey = `edit-agent:${slug}` as const;
  const form = useRef<HTMLFormElement>(null);
  const s = useAgentFormState({ mode: "edit", agent, draftKey, form });
  const { values, shown, errors, set, blur, claim, pending, changes } = s;
  const { noCredentials, credentials, staleNotes } = s;
  const activeAgents = useQuery(agentsListQueryOptions("exclude"));
  const projects = useQuery(projectsQueryOptions);
  const latestShown = useRef(shown);
  useLayoutEffect(() => {
    latestShown.current = shown;
  });

  // Focus on open (and when Restore turns the sheet into the form): phones the drawer content, desktop Display name.
  // Not when focus is already somewhere in the sheet (the form came back while the user was on Close). Once, on mount.
  useEffect(() => {
    const el = form.current;
    const content = el?.closest<HTMLElement>(SHEET_CONTENT);
    const at = document.activeElement;
    // The host parks focus on the panel itself until the body mounts; only focus elsewhere inside it is kept.
    if (!el || (at && at !== content && content?.contains(at))) return;
    if (isMobileNow()) content?.focus({ preventScroll: true });
    else el.querySelector<HTMLElement>("#field-displayName")?.focus({ preventScroll: true });
  }, []);

  // A stacked child's result (§7): the served field takes the value before the child exits, and focus lands on it.
  const serve = (write: () => void, find: () => HTMLElement | null | undefined) => {
    flushSync(write);
    find()?.scrollIntoView({ block: "nearest", behavior: "instant" });
    returnFocusAfterChild(() =>
      isMobileNow()
        ? (form.current?.closest<HTMLElement>("[data-slot=drawer-content]") ?? null)
        : (find() ?? null),
    );
  };
  const onAddCredential = () =>
    openChildSheet({ kind: "add-credential" }, (name) =>
      serve(
        () => set("credential", name),
        () => form.current?.querySelector<HTMLElement>("#field-credential"),
      ),
    );
  const onAddProject = () =>
    openChildSheet({ kind: "add-project" }, (name) =>
      serve(
        () => s.setProjects([...latestShown.current.projects.filter((p) => p !== name), name]),
        () => form.current?.querySelector<HTMLElement>(`[data-project="${CSS.escape(name)}"]`),
      ),
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

  // Who can manage: persistent agents other than this one and everything under it (picking one would make a cycle).
  // The excluded slugs, joined: a status frame rebuilds the list but not this key, so `canManage` keeps its identity.
  const excludedKey = useMemo(() => {
    const list = activeAgents.data ?? [];
    const excluded = new Set<string>([slug]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const a of list) {
        if (a.reportsTo && excluded.has(a.reportsTo) && !excluded.has(a.slug)) {
          excluded.add(a.slug);
          grew = true;
        }
      }
    }
    return [...excluded].sort().join("\n");
  }, [activeAgents.data, slug]);
  const canManage = useMemo(() => {
    const excluded = new Set(excludedKey.split("\n"));
    return (a: AgentOpt) => a.kind === "persistent" && !excluded.has(a.slug);
  }, [excludedKey]);
  // The saved manager may since have been archived: it stays, named as such.
  const managerMissing =
    values.reportsTo !== "" &&
    activeAgents.data !== undefined &&
    !activeAgents.data.some(
      (a) => a.slug === values.reportsTo && !a.archivedAt && !a.terminatedAt && canManage(a),
    );
  const renderMissingManager = useMemo(
    () => (managerMissing ? (m: string) => `@${m} (archived)` : undefined),
    [managerMissing],
  );

  const running = isRunning(agent);
  // A display name or description change also restarts the agent's live direct reports (their prompt names their
  // manager); only the running ones restart anything.
  const runningReports = (activeAgents.data ?? [])
    .filter((a) => a.reportsTo === slug && isRunning(a))
    .map((a) => `@${a.slug}`);
  const selfRestarts = running && changes.length > 0;
  const reportsRestart =
    runningReports.length > 0 && changes.some((f) => f === "displayName" || f === "description");
  // One short line on the reserved outcome line (§8); the detail is the static help below, which no edit changes.
  const restartNotice = selfRestarts
    ? reportsRestart
      ? FORM_MSG.restartsBoth
      : FORM_MSG.restartsSelf
    : reportsRestart
      ? FORM_MSG.restartsReports
      : undefined;
  const restartHelp = restartHelpText(running, runningReports);

  // The form is gone while the sheet shows another state (archived or terminated elsewhere mid-save): a result then
  // has no form to land in, though the sheet is still open.
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const stillOpen = () => mounted.current && getSheetState().parent?.id === sheetId;
  async function save(body: CreateAgentBody | PatchAgentBody): Promise<AgentSummary | undefined> {
    // A patch never names a template; a create body always does.
    if ("template" in body) return undefined;
    // A late result is judged against what was submitted (the draft now) and the session it was sent in.
    const snapshot = peekDraft(draftKey);
    const generation = draftGeneration();
    const restartsNow = running;
    const nameOnly = onlyDisplayName(body);
    let saved: AgentSummary;
    try {
      saved = await updateAgent(slug, body);
    } catch (err) {
      // Dismissed (or the form replaced by another state) while saving: the error has no form to land in. The draft
      // is kept for "Open form".
      if (!stillOpen() && draftGeneration() === generation)
        notify({
          text: `Couldn't save @${slug}: ${err instanceof ApiError ? err.message : "can't reach the server."}`,
          action: { label: "Open form", run: () => openSheet({ kind: "edit-agent", slug }) },
        });
      throw err;
    }
    // Nothing is written back after a sign-out: the result belongs to the old session.
    if (draftGeneration() !== generation) return undefined;
    // The response is the saved agent: show it now; the lists and the detail's queue catch up in the background.
    qc.setQueryData(agentDetailQueryOptions(slug).queryKey, (d) =>
      d ? { ...d, agent: saved } : d,
    );
    void qc.invalidateQueries({ queryKey: ["agents"] });
    void qc.invalidateQueries({ queryKey: ["agent", slug] });
    const late = !stillOpen();
    // Late: dismissed, or the sheet now shows another state the user is reading; it stays. A late success clears the
    // draft only if it still holds what was sent; this agent's Edit reopened on those untouched values closes. Edits
    // made since are kept.
    if (!late) {
      clearDraft(draftKey);
      closeSheet();
    } else if (clearDraftIf(draftKey, snapshot)) {
      const parent = getSheetState().parent;
      // Not while a stacked child the user opened on it is up: the child (and its input) stays.
      if (
        parent?.kind === "edit-agent" &&
        parent.slug === slug &&
        parent.id !== sheetId &&
        !getSheetState().child
      )
        closeSheet();
    }
    // Silent only when the session under the sheet already shows the result (its header shows the name).
    if (saved.restartPending || restartsNow)
      notify({ text: `Saved @${slug}. Restarts when idle.` });
    else if (late || spec.at !== `/agents/${slug}` || !nameOnly)
      notify({ text: `Saved @${slug}.` });
    return saved;
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (pending) return;
    void s.submit(save);
  }

  return (
    <form ref={form} onSubmit={onSubmit} noValidate className="flex min-h-0 flex-1 flex-col">
      <Description agent={agent} />
      <SheetBody className="field-stack">
        <fieldset disabled={pending} className="field-stack">
          <legend className="sr-only">Edit agent</legend>
          <FormField
            name="displayName"
            label="Display name"
            error={errors.displayName}
            value={shown.displayName}
            onChange={(e) => set("displayName", e.target.value)}
            onFocus={() => claim("displayName")}
            onBlur={(e) => blur("displayName", e)}
            autoComplete="off"
          />
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
                renderValue={renderMissingManager}
                aria-invalid={a.invalid || undefined}
                aria-describedby={a.describedBy}
                onValueChange={(v) => set("reportsTo", v ?? "")}
              />
            )}
          </FieldShell>
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
                <Select
                  disabled={!credentials}
                  value={shown.credential}
                  onValueChange={(v) => set("credential", v)}
                >
                  <SelectTrigger
                    id={a.id}
                    aria-invalid={a.invalid || undefined}
                    aria-describedby={a.describedBy}
                    onBlur={(e) => blur("credential", e)}
                  >
                    <SelectValue placeholder="Choose a credential">
                      {credentials ? undefined : shown.credential || "Loading…"}
                    </SelectValue>
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
            onChange={s.setProjects}
            onUseDefault={s.applyTemplateDefault}
            onAddProject={onAddProject}
          />
        </fieldset>
        {restartHelp && (
          <p className="text-[0.8125rem] leading-[1.125rem] text-muted-foreground">{restartHelp}</p>
        )}
      </SheetBody>
      <SheetFormFooter
        submitLabel="Save changes"
        pendingLabel="Saving…"
        pending={pending}
        restored={s.restored}
        onDiscard={s.discard}
        submitClassName="min-w-32"
        outcome={{ ...s.outcome, notice: restartNotice }}
      />
    </form>
  );
}

/** What a save restarts, from stable data only (never the edit), so it never appears or changes as the user types. */
function restartHelpText(running: boolean, reports: string[]) {
  const parts: string[] = [];
  if (running)
    parts.push(
      "A running agent restarts when idle to apply a change. Crons it set in this session stop.",
    );
  if (reports.length > 0) {
    const who =
      reports.length === 1
        ? `Its direct report ${reports[0]} restarts`
        : `Its direct reports ${andList(reports)} restart`;
    parts.push(
      running
        ? `${who} too when a name or description changes.`
        : `${who} when idle if a name or description changes.`,
    );
  }
  return parts.length > 0 ? parts.join(" ") : undefined;
}

/** Only the display name changes: the header of the agent's own session already shows it. */
function onlyDisplayName(body: PatchAgentBody) {
  return (
    body.displayName !== undefined &&
    body.description === undefined &&
    body.reportsTo === undefined &&
    body.credential === undefined &&
    body.projects === undefined
  );
}
