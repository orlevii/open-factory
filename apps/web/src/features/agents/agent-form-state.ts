import {
  type AgentSummary,
  ApiError,
  type CreateAgentBody,
  type CredentialSummary,
  createAgentBodySchema,
  type PatchAgentBody,
  slugSchema,
  type TemplateConfig,
} from "@open-factory/shared";
import { useQuery } from "@tanstack/react-query";
import {
  createElement,
  Fragment,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { agentsListQueryOptions } from "@/features/agents/api";
import { ShowOutput } from "@/features/agents/show-output";
import {
  credentialsQueryOptions,
  projectsQueryOptions,
  secretsQueryOptions,
} from "@/features/settings/api";
import { type DraftKey, useSheetDraft } from "@/features/sheets/drafts";
import { mergeServer } from "@/features/sheets/merge-server";
import { templateQueryOptions, templatesQueryOptions } from "@/features/templates/api";
import { FORM_MSG } from "@/lib/form-messages.ts";

export const FIELDS = [
  "template",
  "slug",
  "displayName",
  "description",
  "reportsTo",
  "credential",
  "projects",
] as const;
export type Field = (typeof FIELDS)[number];
export type Errors = Partial<Record<Field, string>>;
export type Touched = Partial<Record<Field, boolean>>;
export type Values = {
  template: string;
  slug: string;
  displayName: string;
  description: string;
  /** "" is "No manager". */
  reportsTo: string;
  credential: string;
  projects: string[];
};
/** What a draft holds: the values, whether the grants are the user's own, and (New agent) the fields the user made theirs. */
type Stored = Values & { custom: boolean; touched: Touched };
/** An edit draft also keeps the server copy it was edited against, so untouched fields follow the server later. */
type EditDraft = { values: Stored; base: Stored };
export type SubmitResult = "ok" | "invalid" | "failed" | "nothing";
/** The fields an edit can send, in the order a sentence names them. */
export const PATCH_FIELDS = [
  "displayName",
  "description",
  "reportsTo",
  "credential",
  "projects",
] as const satisfies readonly (keyof PatchAgentBody)[];
export type PatchField = (typeof PATCH_FIELDS)[number];

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const storedOf = (a: AgentSummary): Stored => ({
  template: a.template,
  slug: a.slug,
  displayName: a.displayName,
  description: a.description,
  reportsTo: a.reportsTo ?? "",
  credential: a.credential ?? "",
  projects: a.projects,
  custom: a.grantsOverridden,
  touched: {},
});

const blank = (prefill?: { template?: string }): Stored => ({
  template: prefill?.template ?? "",
  slug: "",
  displayName: "",
  description: "",
  reportsTo: "",
  credential: "",
  projects: [],
  custom: false,
  touched: {},
});

/**
 * The agent form's state (§6.1): values live in the sheet draft, validate on blur and all together on submit, and
 * server field errors land under their fields. New agent: the chosen template fills the fields the user hasn't
 * edited, and a credential has to be picked unless there is exactly one. Edit agent: an untouched field follows the
 * server (`mergeServer`, in render) and a touched one keeps the user's value; `submit` sends only the diff.
 */
export function useAgentFormState({
  mode,
  agent,
  draftKey,
  prefill,
  slugFor,
}: {
  mode: "create" | "edit";
  agent?: AgentSummary;
  draftKey: DraftKey;
  prefill?: { template?: string };
  /** New agent: the address derived from the display name, used until the user edits the slug (§6.3). */
  slugFor?: (displayName: string) => string;
}) {
  const create = mode === "create";

  // The server copy as stored values; a new identity only when the agent itself changed.
  const server = useMemo(() => (agent ? storedOf(agent) : undefined), [agent]);
  const draft = useSheetDraft<Stored | EditDraft>(draftKey, () =>
    server ? { values: server, base: server } : blank(prefill),
  );
  // The start values are read once. A restored edit draft starts from its values merged onto the server copy as it is
  // now; a prefill applies to a New agent draft that has no template yet.
  const [start] = useState<{ values: Stored; base: Stored | undefined }>(() => {
    if (server) {
      const d = draft.start as EditDraft;
      return { values: mergeServer(d.values, d.base, server), base: server };
    }
    const v = draft.start as Stored;
    return {
      values: !v.template && prefill?.template ? { ...v, template: prefill.template } : v,
      base: undefined,
    };
  });
  const [values, setValues] = useState<Stored>(start.values);
  /** The server copy the values were edited against; a field equal to it is untouched. */
  const [base, setBase] = useState<Stored | undefined>(start.base);
  // Live: a refreshed agent updates the fields the user hasn't touched; edited fields are kept. Adjusted while rendering
  // (a new server copy is a new prop), so the form never paints the stale merge.
  const [seen, setSeen] = useState(server);
  if (server && base && server !== seen) {
    setValues(mergeServer(values, base, server));
    setBase(server);
    setSeen(server);
  }
  /** The latest values for handlers: two updates in one event must both land, and the draft never lags a render. */
  const latest = useRef(values);
  useEffect(() => {
    latest.current = values;
  });
  const { save: saveDraft, clear: clearDraft } = draft;
  const update = (patch: Partial<Stored>) => {
    const next = { ...latest.current, ...patch };
    latest.current = next;
    setValues(next);
    saveDraft(base ? { values: next, base } : next);
  };

  // No banner when the restored draft holds nothing the server copy doesn't (a later refetch caught up with it).
  const [restored, setRestored] = useState(
    draft.restored && !(start.base && same(start.values, start.base)),
  );
  const [errors, setErrors] = useState<Errors>({});
  const [outcome, setOutcome] = useState<{ tone: "success" | "error"; content: ReactNode }>();
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  /** Submit attempts, so a slow flag belongs to one attempt and a resubmit starts without it. */
  const [attempt, setAttempt] = useState(0);
  const [firedFor, setFiredFor] = useState<number | null>(null);

  const templates = useQuery({ ...templatesQueryOptions, enabled: create });
  const detail = useQuery({
    ...templateQueryOptions(values.template),
    enabled: values.template !== "",
    retry: false,
  });
  const config: TemplateConfig | undefined = detail.data?.config;
  // The last template that landed keeps prefilling while the next one loads, so switching
  // templates doesn't blank the fields in between.
  const [landed, setLanded] = useState(config);
  if (config && config !== landed) setLanded(config);
  const templatePrefill = config ?? landed;
  const activeAgents = useQuery(agentsListQueryOptions("exclude"));
  const credentialsQuery = useQuery(credentialsQueryOptions);
  const credentials: CredentialSummary[] | undefined = credentialsQuery.data;
  // New agent preselects the first credential the list answered with. If that one goes away while the sheet is open
  // (or a restored draft's does), nothing is picked for the user when there are several to choose from.
  const [preselected, setPreselected] = useState<string>();
  if (create && preselected === undefined && credentials)
    setPreselected(credentials[0]?.name ?? "");
  const projectList = useQuery(projectsQueryOptions);
  const secrets = useQuery({ ...secretsQueryOptions, enabled: create });

  // References a restored draft (or an edit made earlier) holds that no longer point at anything read as empty, with
  // the reason under the field. Edit leaves a value alone while it is still the saved one: an archived manager stays.
  const staleNotes: Partial<Record<Field, string>> = {};
  // Compares with `base`, the server copy the values were edited against (possibly stale until the next refetch merges).
  const changed = (f: keyof Values) => create || !base || !same(values[f], base[f]);
  if (
    values.reportsTo &&
    changed("reportsTo") &&
    activeAgents.data &&
    !activeAgents.data.some(
      (a) =>
        a.slug === values.reportsTo &&
        a.kind === "persistent" &&
        !a.archivedAt &&
        !a.terminatedAt &&
        a.slug !== agent?.slug,
    )
  )
    staleNotes.reportsTo = FORM_MSG.agentEnded;
  if (
    values.credential &&
    changed("credential") &&
    credentials &&
    !credentials.some((c) => c.name === values.credential)
  )
    staleNotes.credential = FORM_MSG.credentialDeleted;
  const goneProjects =
    create && values.custom && projectList.data
      ? values.projects.filter((p) => !projectList.data?.some((x) => x.name === p))
      : [];
  if (goneProjects.length > 0) staleNotes.projects = FORM_MSG.projectsRemoved;

  // What the form shows and submits. New agent: the chosen template fills the fields the user
  // hasn't edited. A credential has to be picked; with exactly one there is nothing to choose.
  const base0: Values = {
    ...values,
    reportsTo: staleNotes.reportsTo ? "" : values.reportsTo,
    credential: staleNotes.credential ? "" : values.credential,
    projects:
      goneProjects.length > 0
        ? values.projects.filter((p) => !goneProjects.includes(p))
        : values.projects,
  };
  function defaultCredential(): string {
    if (!credentials) return "";
    if (credentials.length === 1) return credentials[0]?.name ?? "";
    if (staleNotes.credential) return "";
    // `preselected` is set in the render the list first answers; that render reads the list's first one directly.
    const pre = preselected ?? credentials[0]?.name;
    return pre && credentials.some((c) => c.name === pre) ? pre : "";
  }
  const displayName =
    !create || values.touched.displayName || !templatePrefill
      ? base0.displayName
      : templatePrefill.displayName;
  const shown: Values = !create
    ? base0
    : {
        ...base0,
        displayName,
        description:
          values.touched.description || !templatePrefill
            ? base0.description
            : templatePrefill.description,
        credential: base0.credential || defaultCredential(),
        projects: values.custom || !templatePrefill ? base0.projects : templatePrefill.projects,
        slug: values.touched.slug || !slugFor ? base0.slug : slugFor(displayName),
      };
  // The detail lands asynchronously, so a field the user enters while it is still on the way is theirs as it stands:
  // filling it would mix the prefill into what they are about to type.
  const awaitingPrefill = create && values.template !== "" && !config;
  const claim = (f: "displayName" | "description") => {
    if (!awaitingPrefill || latest.current.touched[f]) return;
    update({ touched: { ...latest.current.touched, [f]: true }, [f]: shown[f] });
  };

  // "Installing plugins…" after 3 s of creating, only when the template installs any.
  const pluginCount = create ? (config?.plugins.length ?? 0) : 0;
  useEffect(() => {
    if (!pending || pluginCount === 0) return;
    const t = setTimeout(() => setFiredFor(attempt), 3000);
    return () => clearTimeout(t);
  }, [pending, pluginCount, attempt]);
  const slow = pending && pluginCount > 0 && firedFor === attempt;

  function check(f: Field, v: Values): string | undefined {
    switch (f) {
      case "template": {
        if (!create) return undefined;
        if (v.template === "") return "Choose a template.";
        const t = templates.data?.templates.find((x) => x.name === v.template);
        // A name that isn't listed (a stale ?template=) shows as unchosen, so it is.
        if (templates.data && !t) return "Choose a template.";
        if (t && t.errors > 0) return FORM_MSG.templateErrors;
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
        return v.displayName.trim() === "" ? "Enter a display name." : FORM_MSG.displayNameLength;
      }
      case "description":
        return createAgentBodySchema.shape.description.safeParse(v.description).success
          ? undefined
          : FORM_MSG.descriptionLength;
      case "credential":
        return v.credential === "" ? "Choose a credential." : undefined;
      default:
        return undefined;
    }
  }

  const set = <K extends keyof Values>(f: K, v: Values[K]) => {
    update({
      [f]: v,
      ...(create && !latest.current.touched[f]
        ? { touched: { ...latest.current.touched, [f]: true } }
        : {}),
    });
    setErrors((e) => ({ ...e, [f]: undefined }));
    // A success line describes the saved state; editing makes it stale.
    setOutcome((o) => (o?.tone === "success" ? undefined : o));
  };
  const blur = (f: Field) => setErrors((e) => ({ ...e, [f]: check(f, shown) }));

  const setProjects = (next: string[]) => {
    // Back to exactly the template's set is the template default again, not an override.
    const sameAsTemplate =
      config !== undefined &&
      next.length === config.projects.length &&
      config.projects.every((p) => next.includes(p));
    update({
      projects: next,
      custom: !sameAsTemplate,
      ...(create && !latest.current.touched.projects
        ? { touched: { ...latest.current.touched, projects: true } }
        : {}),
    });
    setErrors((e) => ({ ...e, projects: undefined }));
    setOutcome((o) => (o?.tone === "success" ? undefined : o));
  };
  const applyTemplateDefault = () => {
    setErrors((e) => ({ ...e, projects: undefined }));
    // The template's set when it's known; the server resolves it either way (projects: null).
    update({ custom: false, ...(config ? { projects: config.projects } : {}) });
    setOutcome((o) => (o?.tone === "success" ? undefined : o));
  };

  function body(): CreateAgentBody | PatchAgentBody | null {
    const displayName = shown.displayName.trim();
    const description = shown.description.trim();
    const reportsTo = shown.reportsTo || null;
    if (create) {
      return {
        template: shown.template,
        slug: shown.slug,
        displayName,
        description,
        reportsTo,
        credential: shown.credential,
        ...(values.custom ? { projects: shown.projects } : {}),
      };
    }
    const b = base as Stored;
    const patch: PatchAgentBody = {};
    if (displayName !== b.displayName) patch.displayName = displayName;
    if (description !== b.description) patch.description = description;
    if (reportsTo !== (b.reportsTo || null)) patch.reportsTo = reportsTo;
    if (shown.credential !== b.credential) patch.credential = shown.credential;
    if (values.custom !== b.custom || !same(shown.projects, b.projects))
      patch.projects = values.custom ? shown.projects : null;
    return Object.keys(patch).length > 0 ? patch : null;
  }

  // Edit: the fields a save would send now (the restart notice names them).
  const editPatch = create ? null : body();
  const changes: PatchField[] = editPatch
    ? PATCH_FIELDS.filter((f) => editPatch[f] !== undefined)
    : [];

  const noCredentials = credentials !== undefined && credentials.length === 0;
  const missingSecrets =
    create && config && secrets.data
      ? config.secrets.filter((s) => !secrets.data.some((x) => x.name === s))
      : [];

  /** `onSubmit` resolves to the saved agent on Edit (it becomes the new base); New agent's resolves to nothing. */
  async function submit(
    onSubmit: (
      b: CreateAgentBody | PatchAgentBody,
    ) => Promise<AgentSummary | undefined> | Promise<void>,
  ): Promise<SubmitResult> {
    // A ref, not `pending`: a second Enter can arrive before the first one's state has rendered.
    if (inFlight.current || noCredentials) return "nothing";
    const found: Errors = {};
    for (const f of FIELDS) {
      const m = check(f, shown);
      if (m) found[f] = m;
    }
    setErrors(found);
    setOutcome(undefined);
    if (Object.keys(found).length > 0) return "invalid";
    const b = body();
    if (!b) {
      setOutcome({ tone: "success", content: "Nothing to save: no field changed." });
      return "nothing";
    }
    inFlight.current = true;
    setAttempt((n) => n + 1);
    setPending(true);
    try {
      const saved = await onSubmit(b);
      if (create) {
        // Unmounted (the sheet was dismissed while creating): the draft stays; the sheet host clears it when no sheet
        // of this kind is open, or toasts "Open form" on a late failure.
        if (mounted.current) clearDraft();
      } else {
        // The saved copy is the new base; the fields stay as the user left them (they equal it). The sheet closes and
        // toasts the outcome, so there is no inline success line.
        if (saved) setBase(storedOf(saved));
        // Only this instance's draft: after a dismiss the key may hold a draft the user reopened and edited since.
        if (mounted.current) clearDraft();
      }
      return "ok";
    } catch (err) {
      if (err instanceof ApiError) {
        const fields = (err.body.fields ?? {}) as Record<string, string>;
        const e: Errors = {};
        for (const f of FIELDS) if (fields[f]) e[f] = fields[f];
        if (Object.keys(e).length > 0) {
          setErrors(e);
        } else {
          setOutcome({
            tone: "error",
            content: createElement(
              Fragment,
              null,
              err.message,
              err.code === "plugin_install_failed"
                ? createElement(ShowOutput, { output: err.body.output })
                : null,
            ),
          });
        }
      } else {
        setOutcome({
          tone: "error",
          content: FORM_MSG.unreachable,
        });
      }
      return "failed";
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  /** Clears the draft and puts the fields back to where a fresh open starts (the saved agent, or the context prefill). */
  function discard() {
    clearDraft();
    const fresh = base ?? blank(prefill);
    latest.current = fresh;
    setValues(fresh);
    setErrors({});
    setOutcome(undefined);
    setRestored(false);
  }

  return {
    values,
    shown,
    errors,
    touched: values.touched,
    custom: values.custom,
    set,
    blur,
    claim,
    setProjects,
    applyTemplateDefault,
    submit,
    pending,
    slow,
    outcome,
    config,
    missingSecrets,
    noCredentials,
    credentials,
    restored,
    discard,
    staleNotes,
    changes,
  };
}
