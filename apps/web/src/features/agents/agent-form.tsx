import type {
  AgentSummary,
  CreateAgentBody,
  PatchAgentBody,
  TemplateConfig,
  TemplateIssue,
} from "@open-factory/shared";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { TriangleAlert } from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
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
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { AgentCombobox, type AgentOpt } from "@/features/agents/agent-combobox";
import { type Errors, FIELDS, useAgentFormState } from "@/features/agents/agent-form-state";
import { agentsListQueryOptions } from "@/features/agents/api";
import { ProjectGrantPicker } from "@/features/agents/project-grant-picker";
import { projectsQueryOptions } from "@/features/settings/api";
import { clearDraft, type DraftKey } from "@/features/sheets/drafts";
import { templateQueryOptions, templatesQueryOptions } from "@/features/templates/api";

const NO_MANAGER: ComboOption[] = [
  { value: "", label: "No manager (reports to the humans)", fixed: true },
];
const KIND_LABEL = { oauth_token: "OAuth token", api_key: "API key" } as const;
const linkClass =
  "text-foreground underline underline-offset-4 decoration-muted-foreground hover:decoration-ring";

type Props =
  | {
      mode: "create";
      initial?: { template?: string };
      onSubmit: (body: CreateAgentBody) => Promise<unknown>;
    }
  | {
      mode: "edit";
      initial: AgentSummary;
      onSubmit: (body: PatchAgentBody) => Promise<AgentSummary>;
    };

/** The New agent and Edit agent form. Fields validate on blur and all together on submit; server
 *  field errors land under their fields. */
export function AgentForm(props: Props) {
  const { mode } = props;
  const create = mode === "create";
  const agent = mode === "edit" ? props.initial : undefined;
  const draftKey: DraftKey = agent ? `edit-agent:${agent.slug}` : "new-agent";
  const s = useAgentFormState({
    mode,
    agent,
    draftKey,
    prefill: create ? props.initial : undefined,
  });
  const { values, shown, errors, set, blur, claim, pending, slow, outcome, config } = s;
  const { missingSecrets, noCredentials, credentials } = s;
  // Until the sheets replace these pages, a draft lives only as long as the page.
  useEffect(() => () => clearDraft(draftKey), [draftKey]);
  const form = useRef<HTMLFormElement>(null);

  const templates = useQuery({ ...templatesQueryOptions, enabled: create });
  const detail = useQuery({
    ...templateQueryOptions(values.template),
    enabled: values.template !== "",
    retry: false,
  });
  const activeAgents = useQuery(agentsListQueryOptions("exclude"));
  const projects = useQuery(projectsQueryOptions);

  const focusFirst = (e: Errors) => {
    const first = FIELDS.find((f) => e[f]);
    if (first) form.current?.querySelector<HTMLElement>(`#field-${first}`)?.focus();
  };
  // Focus moves to the first error once it renders, and once the fieldset is enabled again after a server answer.
  const wantFocus = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the errors or a request settle
  useEffect(() => {
    if (pending || !wantFocus.current) return;
    wantFocus.current = false;
    focusFirst(errors);
  }, [pending, errors]);

  // Opening a Radix Select moves focus into its list, so the trigger blurs on open. The template
  // validates when its list closes (this effect sees the chosen value), not while it is open.
  const [templateOpen, setTemplateOpen] = useState(false);
  const templateOpened = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the list closes
  useEffect(() => {
    if (templateOpen || !templateOpened.current) return;
    templateOpened.current = false;
    blur("template");
  }, [templateOpen]);

  function submit(ev: FormEvent) {
    ev.preventDefault();
    wantFocus.current = true;
    return s.submit((b) =>
      props.mode === "create"
        ? props.onSubmit(b as CreateAgentBody)
        : props.onSubmit(b as PatchAgentBody),
    );
  }

  // Who can manage: persistent agents (a spawned agent never manages). On Edit the agent and everything
  // under it are left out, because picking one of them would make a cycle.
  const editing = agent?.slug;
  // The excluded slugs, joined: a status frame rebuilds the list but not this key, so `canManage` keeps
  // its identity and the picker's options are not rebuilt.
  const excludedKey = (() => {
    const list = activeAgents.data ?? [];
    const excluded = new Set<string>(editing ? [editing] : []);
    let grew = editing !== undefined;
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
  })();
  const canManage = useMemo(() => {
    const excluded = new Set(excludedKey ? excludedKey.split("\n") : []);
    return (a: AgentOpt) => a.kind === "persistent" && !excluded.has(a.slug);
  }, [excludedKey]);
  const managerMissing =
    values.reportsTo !== "" &&
    activeAgents.data !== undefined &&
    !activeAgents.data.some(
      (a) => a.slug === values.reportsTo && !a.archivedAt && !a.terminatedAt && canManage(a),
    );
  const renderMissingManager = useMemo(
    () => (managerMissing ? (slug: string) => `@${slug} (archived)` : undefined),
    [managerMissing],
  );

  return (
    <form ref={form} onSubmit={submit} noValidate className="grid max-w-[36rem] gap-6">
      <fieldset disabled={pending} className="grid min-w-0 gap-5">
        <legend className="sr-only">{create ? "New agent" : "Agent"}</legend>
        {agent && (
          <p className="text-[0.8125rem] leading-[1.125rem] text-muted-foreground">
            Template <span className="font-mono text-foreground">{agent.template}</span> ·{" "}
            <span className="font-mono text-foreground">@{agent.slug}</span>
          </p>
        )}
        {create && (
          <FieldShell name="template" label="Template" error={errors.template}>
            {(a) => (
              <div className="grid gap-1.5">
                <Select
                  disabled={!templates.data}
                  value={values.template}
                  onValueChange={(v) => set("template", v)}
                  onOpenChange={(open) => {
                    setTemplateOpen(open);
                    if (open) templateOpened.current = true;
                  }}
                >
                  <SelectTrigger
                    id={a.id}
                    aria-invalid={a.invalid || undefined}
                    aria-describedby={[a.describedBy, config ? "template-summary" : undefined]
                      .filter(Boolean)
                      .join(" ")}
                    onBlur={() => !templateOpen && blur("template")}
                  >
                    <SelectValue placeholder="Choose a template">
                      {templates.data ? undefined : values.template || "Loading…"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {templates.data?.templates.map((t) => (
                      <SelectItem key={t.name} value={t.name} disabled={t.errors > 0}>
                        {t.errors > 0 ? `${t.name} (has errors)` : t.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {config && (
                  <TemplateSummary
                    config={config}
                    issues={detail.data?.issues ?? []}
                    missingSecrets={missingSecrets}
                  />
                )}
              </div>
            )}
          </FieldShell>
        )}
        {create && (
          <FormField
            name="slug"
            label="Slug"
            prefix="@"
            help="How others address this agent, like @team-lead. Lowercase letters, numbers and hyphens. Can't be changed later."
            error={errors.slug}
            value={shown.slug}
            onChange={(e) => set("slug", e.target.value)}
            onBlur={() => blur("slug")}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            className="font-mono"
          />
        )}
        <FormField
          name="displayName"
          label="Display name"
          error={errors.displayName}
          value={shown.displayName}
          onChange={(e) => set("displayName", e.target.value)}
          onFocus={() => claim("displayName")}
          onBlur={() => blur("displayName")}
          autoComplete="off"
        />
        <FieldShell name="description" label="Description" error={errors.description}>
          {(a) => (
            <Textarea
              id={a.id}
              name="description"
              rows={3}
              aria-invalid={a.invalid || undefined}
              aria-describedby={a.describedBy}
              value={shown.description}
              onChange={(e) => set("description", e.target.value)}
              onFocus={() => claim("description")}
              onBlur={() => blur("description")}
            />
          )}
        </FieldShell>
        <FieldShell name="reportsTo" label="Manager" error={errors.reportsTo}>
          {(a) => (
            <AgentCombobox
              id={a.id}
              aria-label="Manager"
              scope="live"
              order="tree"
              fixed={NO_MANAGER}
              filter={canManage}
              disabled={!activeAgents.data}
              value={values.reportsTo || null}
              renderValue={renderMissingManager}
              aria-invalid={a.invalid || undefined}
              aria-describedby={a.describedBy}
              onValueChange={(v) => set("reportsTo", v ?? "")}
            />
          )}
        </FieldShell>
        {noCredentials ? (
          <div className="grid gap-1.5">
            <p className="text-[0.8125rem] font-medium">Credential</p>
            <p className="text-[0.8125rem] text-muted-foreground">
              <Link to="/settings/credentials" className={linkClass}>
                Add a Claude credential in Settings
              </Link>{" "}
              first.
            </p>
          </div>
        ) : (
          <FieldShell name="credential" label="Credential" error={errors.credential}>
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
                  onBlur={() => blur("credential")}
                >
                  <SelectValue>
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
        />
      </fieldset>
      <div className="grid gap-2">
        <InlineOutcome tone={outcome?.tone}>{outcome?.content}</InlineOutcome>
        <div>
          <Button type="submit" size="lg" aria-disabled={pending || noCredentials || undefined}>
            {pending && <Spinner />}
            {pending
              ? create
                ? "Creating…"
                : "Saving…"
              : create
                ? "Create agent"
                : "Save changes"}
          </Button>
        </div>
        <p role="status" className="text-[0.8125rem] leading-[1.125rem] text-muted-foreground">
          {slow ? "Installing plugins…" : ""}
          <span className="sr-only">
            {pending && !slow ? (create ? "Creating the agent…" : "Saving…") : ""}
          </span>
        </p>
      </div>
    </form>
  );
}

/** What the chosen template brings, plus the warnings that would stop its agents starting: the
 *  validator's runtime warning (a local template while the factory's local runtime is off) and
 *  secrets that aren't set. */
function TemplateSummary({
  config,
  issues,
  missingSecrets,
}: {
  config: TemplateConfig;
  issues: TemplateIssue[];
  missingSecrets: string[];
}) {
  const runtimeWarnings = issues
    .filter((i) => i.severity === "warning" && i.path === "runtime")
    .map((i) => i.message);
  const parts = [
    config.runtime === "docker" ? "Docker" : "Unsandboxed",
    config.model && `model ${config.model}`,
    config.skills.length > 0 && `skills: ${config.skills.join(", ")}`,
    config.plugins.length > 0 && `plugins: ${config.plugins.length}`,
    config.secrets.length > 0 && `secrets: ${config.secrets.join(", ")}`,
  ].filter(Boolean);
  return (
    <div id="template-summary" className="grid gap-1 text-[0.8125rem] leading-[1.125rem]">
      <p className="text-muted-foreground">{parts.join(" · ")}</p>
      {runtimeWarnings.map((w) => (
        <Warning key={w}>{w}</Warning>
      ))}
      {missingSecrets.map((s) => (
        <Warning key={s}>
          Secret <span className="font-mono">{s}</span> isn't set. The agent won't start until you{" "}
          <Link to="/settings/secrets" search={{ addSecret: s }} className={linkClass}>
            add it<span className="sr-only"> in Settings</span>
          </Link>
          .
        </Warning>
      ))}
    </div>
  );
}

function Warning({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-start gap-1.5">
      <TriangleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-warning" />
      <span>{children}</span>
    </p>
  );
}
