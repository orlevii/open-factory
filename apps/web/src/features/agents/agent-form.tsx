import {
  type AgentSummary,
  ApiError,
  type CreateAgentBody,
  createAgentBodySchema,
  type PatchAgentBody,
  slugSchema,
  type TemplateConfig,
} from "@open-factory/shared";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Loader2, TriangleAlert } from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { FieldShell } from "@/components/field-shell";
import { FormField } from "@/components/form-field";
import { InlineOutcome } from "@/components/inline-outcome";
import { NativeSelect } from "@/components/native-select";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { agentsListQueryOptions } from "@/features/agents/api";
import { ProjectGrantPicker } from "@/features/agents/project-grant-picker";
import { ShowOutput } from "@/features/agents/show-output";
import {
  credentialsQueryOptions,
  projectsQueryOptions,
  secretsQueryOptions,
} from "@/features/settings/api";
import { templateQueryOptions, templatesQueryOptions } from "@/features/templates/api";

const FIELDS = [
  "template",
  "slug",
  "displayName",
  "description",
  "reportsTo",
  "credential",
  "projects",
] as const;
type Field = (typeof FIELDS)[number];
type Errors = Partial<Record<Field, string>>;
type Values = {
  template: string;
  slug: string;
  displayName: string;
  description: string;
  /** "" is "No manager". */
  reportsTo: string;
  credential: string;
  projects: string[];
};

const KIND_LABEL = { oauth_token: "OAuth token", api_key: "API key" } as const;
/** Indentation inside <option>: ordinary spaces collapse there. */
const indent = (depth: number) => " ".repeat(depth * 4);
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

const fromAgent = (a: AgentSummary): Values => ({
  template: a.template,
  slug: a.slug,
  displayName: a.displayName,
  description: a.description,
  reportsTo: a.reportsTo ?? "",
  credential: a.credential,
  projects: a.projects,
});

/** Every slug in use, archived agents included; undefined until both lists answered. */
function useTakenSlugs(enabled: boolean): Set<string> | undefined {
  const active = useQuery({ ...agentsListQueryOptions("exclude"), enabled });
  const archived = useQuery({ ...agentsListQueryOptions("only"), enabled });
  // Stable between renders: an effect depends on it.
  return useMemo(
    () =>
      active.data && archived.data
        ? new Set([...active.data, ...archived.data].map((a) => a.slug))
        : undefined,
    [active.data, archived.data],
  );
}

/** The New agent and Edit agent form. Fields validate on blur and all together on submit; server
 *  field errors land under their fields. */
export function AgentForm(props: Props) {
  const { mode } = props;
  const create = mode === "create";
  const agent = mode === "edit" ? props.initial : undefined;

  const [baseline, setBaseline] = useState<Values | undefined>(agent && fromAgent(agent));
  const [values, setValues] = useState<Values>(
    agent
      ? fromAgent(agent)
      : {
          template: props.initial?.template ?? "",
          slug: "",
          displayName: "",
          description: "",
          reportsTo: "",
          credential: "",
          projects: [],
        },
  );
  const [custom, setCustom] = useState(agent?.grantsOverridden ?? false);
  const [projectsTouched, setProjectsTouched] = useState(false);
  const touched = useRef<Partial<Record<Field, boolean>>>({});
  const [errors, setErrors] = useState<Errors>({});
  const [outcome, setOutcome] = useState<{
    tone: "success" | "error";
    content: ReactNode;
  }>();
  const [pending, setPending] = useState(false);
  const [slow, setSlow] = useState(false);
  const form = useRef<HTMLFormElement>(null);

  const templates = useQuery({ ...templatesQueryOptions, enabled: create });
  const detail = useQuery({
    ...templateQueryOptions(values.template),
    enabled: values.template !== "",
    retry: false,
  });
  const config: TemplateConfig | undefined = detail.data?.config;
  const activeAgents = useQuery(agentsListQueryOptions("exclude"));
  const taken = useTakenSlugs(create);
  const credentials = useQuery(credentialsQueryOptions);
  const projects = useQuery(projectsQueryOptions);
  const secrets = useQuery({ ...secretsQueryOptions, enabled: create });

  // A credential has to be picked; with exactly one there is nothing to choose.
  useEffect(() => {
    const first = credentials.data?.[0];
    if (create && first && values.credential === "") {
      setValues((v) => (v.credential === "" ? { ...v, credential: first.name } : v));
    }
  }, [create, credentials.data, values.credential]);

  // New agent: the chosen template fills the fields the user hasn't edited. The slug takes the
  // template's name when that slug is free and valid.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-apply only when the template or the taken slugs change
  useEffect(() => {
    if (!create || !config) return;
    setValues((v) => {
      const next = { ...v };
      if (!touched.current.displayName) next.displayName = config.displayName;
      if (!touched.current.description) next.description = config.description;
      if (!custom) next.projects = config.projects;
      if (!touched.current.slug && taken) {
        const free = !taken.has(config.name) && slugSchema.safeParse(config.name).success;
        next.slug = free ? config.name : "";
      }
      return next;
    });
  }, [create, config, taken]);

  // "Installing plugins…" after 3 s of creating, only when the template installs any.
  const pluginCount = create ? (config?.plugins.length ?? 0) : 0;
  useEffect(() => {
    if (!pending || pluginCount === 0) {
      setSlow(false);
      return;
    }
    const t = setTimeout(() => setSlow(true), 3000);
    return () => clearTimeout(t);
  }, [pending, pluginCount]);

  function check(f: Field, v: Values): string | undefined {
    switch (f) {
      case "template": {
        if (!create) return undefined;
        if (v.template === "") return "Choose a template.";
        const t = templates.data?.templates.find((x) => x.name === v.template);
        // A name that isn't listed (a stale ?template=) shows as unchosen, so it is.
        if (templates.data && !t) return "Choose a template.";
        if (t && t.errors > 0) return `Template ${v.template} has errors. Fix them first.`;
        return undefined;
      }
      case "slug": {
        if (!create) return undefined;
        if (v.slug === "") return "Enter a slug.";
        const r = slugSchema.safeParse(v.slug);
        return r.success ? undefined : r.error.issues[0]?.message;
      }
      case "displayName": {
        if (createAgentBodySchema.shape.displayName.safeParse(v.displayName).success) return;
        return v.displayName.trim() === ""
          ? "Enter a display name."
          : "Keep the display name to 80 characters or fewer.";
      }
      case "description":
        return createAgentBodySchema.shape.description.safeParse(v.description).success
          ? undefined
          : "Keep the description to 500 characters or fewer.";
      case "credential":
        return v.credential === "" ? "Choose a credential." : undefined;
      default:
        return undefined;
    }
  }

  const set = <K extends keyof Values>(f: K, v: Values[K]) => {
    touched.current[f] = true;
    setValues((s) => ({ ...s, [f]: v }));
    setErrors((e) => ({ ...e, [f]: undefined }));
    // A success line describes the saved state; editing makes it stale.
    setOutcome((o) => (o?.tone === "success" ? undefined : o));
  };
  const focusAfterPending = useRef<Errors>(undefined);
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when a request settles
  useEffect(() => {
    if (pending || !focusAfterPending.current) return;
    focusFirst(focusAfterPending.current);
    focusAfterPending.current = undefined;
  }, [pending]);
  const blur = (f: Field) => setErrors((e) => ({ ...e, [f]: check(f, values) }));
  const focusFirst = (e: Errors) => {
    const first = FIELDS.find((f) => e[f]);
    if (first) form.current?.querySelector<HTMLElement>(`#field-${first}`)?.focus();
  };

  const setProjects = (next: string[]) => {
    setProjectsTouched(true);
    // Back to exactly the template's set is the template default again, not an override.
    const sameAsTemplate =
      config !== undefined &&
      next.length === config.projects.length &&
      config.projects.every((p) => next.includes(p));
    setCustom(!sameAsTemplate);
    set("projects", next);
  };
  const applyTemplateDefault = () => {
    setProjectsTouched(true);
    setCustom(false);
    setErrors((e) => ({ ...e, projects: undefined }));
    // The template's set when it's known; the server resolves it either way (projects: null).
    if (config) set("projects", config.projects);
  };

  function body(): CreateAgentBody | PatchAgentBody | null {
    const displayName = values.displayName.trim();
    const description = values.description.trim();
    const reportsTo = values.reportsTo || null;
    if (create) {
      return {
        template: values.template,
        slug: values.slug,
        displayName,
        description,
        reportsTo,
        credential: values.credential,
        ...(custom ? { projects: values.projects } : {}),
      };
    }
    const base = baseline as Values;
    const patch: PatchAgentBody = {};
    if (displayName !== base.displayName) patch.displayName = displayName;
    if (description !== base.description) patch.description = description;
    if (reportsTo !== (base.reportsTo || null)) patch.reportsTo = reportsTo;
    if (values.credential !== base.credential) patch.credential = values.credential;
    if (projectsTouched) patch.projects = custom ? values.projects : null;
    return Object.keys(patch).length > 0 ? patch : null;
  }

  async function submit(ev: FormEvent) {
    ev.preventDefault();
    if (pending || noCredentials) return;
    const found: Errors = {};
    for (const f of FIELDS) {
      const m = check(f, values);
      if (m) found[f] = m;
    }
    setErrors(found);
    setOutcome(undefined);
    if (Object.keys(found).length > 0) return focusFirst(found);
    const b = body();
    if (!b) {
      setOutcome({ tone: "success", content: "Nothing to save: no field changed." });
      return;
    }
    setPending(true);
    try {
      if (props.mode === "create") {
        await props.onSubmit(b as CreateAgentBody);
      } else {
        const wasRunning = agent?.status === "working" || agent?.status === "idle";
        const saved = await props.onSubmit(b as PatchAgentBody);
        setBaseline(fromAgent(saved));
        setProjectsTouched(false);
        setCustom(saved.grantsOverridden);
        setOutcome({
          tone: "success",
          content:
            saved.restartPending || wasRunning
              ? "Saved. The agent restarts when idle to apply the changes. Reminders it scheduled in this session are lost."
              : "Saved.",
        });
      }
    } catch (err) {
      if (err instanceof ApiError) {
        const fields = (err.body.fields ?? {}) as Record<string, string>;
        const e: Errors = {};
        for (const f of FIELDS) if (fields[f]) e[f] = fields[f];
        if (Object.keys(e).length > 0) {
          setErrors(e);
          // The fieldset is still disabled here; focus once it's enabled again.
          focusAfterPending.current = e;
        } else {
          setOutcome({
            tone: "error",
            content: (
              <>
                {err.message}
                {err.code === "plugin_install_failed" && <ShowOutput output={err.body.output} />}
              </>
            ),
          });
        }
      } else {
        setOutcome({
          tone: "error",
          content: create
            ? "Couldn't create the agent. Check that the server is running, then try again."
            : "Couldn't save. Check that the server is running, then try again.",
        });
      }
    } finally {
      setPending(false);
    }
  }

  // Manager options: active agents in tree order. On Edit the agent and everything under it are
  // left out, because picking one of them would make a cycle.
  const managerOptions = (() => {
    const list = activeAgents.data ?? [];
    if (!agent) return list;
    const excluded = new Set([agent.slug]);
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
    return list.filter((a) => !excluded.has(a.slug));
  })();
  const managerMissing =
    values.reportsTo !== "" &&
    activeAgents.data !== undefined &&
    !managerOptions.some((a) => a.slug === values.reportsTo);

  const noCredentials = credentials.data !== undefined && credentials.data.length === 0;
  const missingSecrets =
    create && config && secrets.data
      ? config.secrets.filter((s) => !secrets.data.some((x) => x.name === s))
      : [];

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
                <NativeSelect
                  id={a.id}
                  aria-invalid={a.invalid || undefined}
                  aria-describedby={[a.describedBy, config ? "template-summary" : undefined]
                    .filter(Boolean)
                    .join(" ")}
                  disabled={!templates.data}
                  value={values.template}
                  onChange={(e) => set("template", e.target.value)}
                  onBlur={() => blur("template")}
                >
                  {!templates.data ? (
                    <option value="">Loading…</option>
                  ) : (
                    <>
                      <option value="" disabled>
                        Choose a template
                      </option>
                      {templates.data.templates.map((t) => (
                        <option key={t.name} value={t.name} disabled={t.errors > 0}>
                          {t.errors > 0 ? `${t.name} (has errors)` : t.name}
                        </option>
                      ))}
                    </>
                  )}
                </NativeSelect>
                {config && <TemplateSummary config={config} missingSecrets={missingSecrets} />}
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
            value={values.slug}
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
          value={values.displayName}
          onChange={(e) => set("displayName", e.target.value)}
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
              value={values.description}
              onChange={(e) => set("description", e.target.value)}
              onBlur={() => blur("description")}
              className="bg-card dark:bg-card"
            />
          )}
        </FieldShell>
        <FieldShell name="reportsTo" label="Manager" error={errors.reportsTo}>
          {(a) => (
            <NativeSelect
              id={a.id}
              aria-invalid={a.invalid || undefined}
              aria-describedby={a.describedBy}
              disabled={!activeAgents.data}
              value={values.reportsTo}
              onChange={(e) => set("reportsTo", e.target.value)}
            >
              {!activeAgents.data ? (
                <option value={values.reportsTo}>Loading…</option>
              ) : (
                <>
                  <option value="">No manager (reports to the humans)</option>
                  {managerOptions.map((m) => (
                    <option key={m.slug} value={m.slug}>
                      {`${indent(m.depth)}${m.displayName} (@${m.slug})`}
                    </option>
                  ))}
                  {managerMissing && (
                    <option value={values.reportsTo} disabled>
                      {`@${values.reportsTo} (archived)`}
                    </option>
                  )}
                </>
              )}
            </NativeSelect>
          )}
        </FieldShell>
        {noCredentials ? (
          <div className="grid gap-1.5">
            <p className="text-[0.8125rem] font-medium">Credential</p>
            <p className="text-[0.8125rem] text-muted-foreground">
              <Link to="/settings" hash="credentials" className={linkClass}>
                Add a Claude credential in Settings
              </Link>{" "}
              first.
            </p>
          </div>
        ) : (
          <FieldShell name="credential" label="Credential" error={errors.credential}>
            {(a) => (
              <NativeSelect
                id={a.id}
                aria-invalid={a.invalid || undefined}
                aria-describedby={a.describedBy}
                disabled={!credentials.data}
                value={values.credential}
                onChange={(e) => set("credential", e.target.value)}
                onBlur={() => blur("credential")}
              >
                {!credentials.data ? (
                  <option value={values.credential}>Loading…</option>
                ) : (
                  credentials.data.map((c) => (
                    <option key={c.name} value={c.name}>
                      {`${c.name}: ${KIND_LABEL[c.kind]}`}
                    </option>
                  ))
                )}
              </NativeSelect>
            )}
          </FieldShell>
        )}
        <ProjectGrantPicker
          projects={projects.data}
          value={values.projects}
          custom={custom}
          error={errors.projects}
          onChange={setProjects}
          onUseDefault={applyTemplateDefault}
        />
      </fieldset>
      <div className="grid gap-2">
        <InlineOutcome tone={outcome?.tone}>{outcome?.content}</InlineOutcome>
        <div>
          <Button
            type="submit"
            size="lg"
            aria-disabled={pending || noCredentials || undefined}
            className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
          >
            {pending && <Loader2 aria-hidden="true" className="motion-safe:animate-spin" />}
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

/** What the chosen template brings, plus the warnings that would stop its agents starting. */
function TemplateSummary({
  config,
  missingSecrets,
}: {
  config: TemplateConfig;
  missingSecrets: string[];
}) {
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
      {config.runtime === "docker" && (
        <Warning>
          Agents from this template can't start yet: the Docker runtime isn't available.
        </Warning>
      )}
      {missingSecrets.map((s) => (
        <Warning key={s}>
          Secret <span className="font-mono">{s}</span> isn't set. The agent won't start until you{" "}
          <Link to="/settings" search={{ addSecret: s }} hash="secrets" className={linkClass}>
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
