import {
  type AgentSummary,
  ApiError,
  type CreateAgentBody,
  type CredentialSummary,
  createAgentBodySchema,
  MSG,
  type PatchAgentBody,
  slugSchema,
  type TemplateConfig,
} from "@open-factory/shared";
import { useQuery } from "@tanstack/react-query";
import { type RefObject, useEffect, useMemo, useRef, useState } from "react";
import { useOutcome } from "@/components/forms/form-outcome";
import { useFieldErrors } from "@/components/forms/use-field-errors";
import { agentsListQueryOptions, type ModelEffort } from "@/features/agents/api";
import { templateConfigQueryOptions } from "@/features/config/api";
import { readAt, readString, setAt } from "@/features/config/tolerant";
import {
  credentialsQueryOptions,
  projectsQueryOptions,
  secretsQueryOptions,
  usersQueryOptions,
} from "@/features/settings/api";
import { type DraftKey, useSheetDraft } from "@/features/sheets/drafts";
import { mergeServer } from "@/features/sheets/merge-server";
import { templateQueryOptions, templatesQueryOptions } from "@/features/templates/api";
import { FORM_MSG } from "@/lib/form-messages.ts";
import { sessionQueryOptions } from "@/lib/session";

export const FIELDS = [
  "template",
  "slug",
  "displayName",
  "color",
  "description",
  "reportsTo",
  "credential",
  "projects",
  "manageOrg",
] as const;
export type Field = (typeof FIELDS)[number];
export type Touched = Partial<Record<Field, boolean>>;
export type Values = {
  template: string;
  slug: string;
  displayName: string;
  /** Identity colour 1..12, null is Auto. */
  color: number | null;
  description: string;
  /** The manager's handle, an agent's or a human's; "" until one is chosen. */
  reportsTo: string;
  credential: string;
  projects: string[];
  manageOrg: boolean;
  /** This agent's own model and effort, "" to inherit the template's. */
  model: string;
  effort: string;
};
/** What a draft holds: the values and (New agent) the fields the user made theirs. */
type Stored = Values & { touched: Touched };
/** An edit draft also keeps the server copy it was edited against, so untouched fields follow the server later. */
type EditDraft = { values: Stored; base: Stored };
export type SubmitResult = "ok" | "invalid" | "failed" | "nothing";

/**
 * Edit agent saves in two writes (the agent, then its model and effort). When the second fails the first has landed:
 * `agent` is what it saved (the form's base moves to it), and `message` says which part is saved.
 */
export class PartialSaveError extends Error {
  constructor(
    public readonly agent: AgentSummary | undefined,
    message: string,
  ) {
    super(message);
    this.name = "PartialSaveError";
  }
}
/** The fields an edit can send, in the order a sentence names them. */
export const PATCH_FIELDS = [
  "displayName",
  "color",
  "description",
  "reportsTo",
  "credential",
  "projects",
  "manageOrg",
] as const satisfies readonly (keyof PatchAgentBody)[];
export type PatchField = (typeof PATCH_FIELDS)[number];

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const storedOf = (a: AgentSummary): Stored => ({
  template: a.template,
  slug: a.slug,
  displayName: a.displayName,
  color: a.color,
  description: a.description,
  reportsTo: a.reportsTo.handle,
  credential: a.credential ?? "",
  projects: a.projects,
  manageOrg: a.manageOrg,
  model: a.model.source === "agent" ? (a.model.value ?? "") : "",
  effort: a.effort.source === "agent" ? (a.effort.value ?? "") : "",
  touched: {},
});

/** Model and effort as the config scope's overlay: only what this agent overrides. */
const overlayOf = (v: ModelEffort): unknown => {
  let o: unknown = {};
  if (v.model) o = setAt(o, ["template", "model"], v.model);
  if (v.effort) o = setAt(o, ["template", "effort"], v.effort);
  return o;
};
const overrideOf = (o: unknown, field: keyof ModelEffort): string => {
  const r = readString(readAt(o, ["template", field]));
  return r.ok ? (r.value ?? "") : "";
};

const blank = (prefill?: { template?: string }): Stored => ({
  template: prefill?.template ?? "",
  slug: "",
  displayName: "",
  color: null,
  description: "",
  reportsTo: "",
  credential: "",
  projects: [],
  manageOrg: false,
  model: "",
  effort: "",
  touched: {},
});

/**
 * The agent form's state (§6.1): values live in the sheet draft; validation timing, server field errors and focus
 * belong to `useFieldErrors` over `form`, and the form-level line to `useOutcome`. New agent: the chosen template fills the fields the user hasn't
 * edited, and a credential has to be picked unless there is exactly one. Edit agent: an untouched field follows the
 * server (`mergeServer`, in render) and a touched one keeps the user's value; `submit` sends only the diff.
 */
export function useAgentFormState({
  mode,
  agent,
  draftKey,
  prefill,
  slugFor,
  form,
}: {
  mode: "create" | "edit";
  agent?: AgentSummary;
  draftKey: DraftKey;
  prefill?: { template?: string };
  /** New agent: the address derived from the display name, used until the user edits the slug (§6.3). */
  slugFor?: (displayName: string) => string;
  /** The form root: `useFieldErrors` focuses the first invalid field in it. */
  form: RefObject<HTMLElement | null>;
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
  const o = useOutcome();
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const templates = useQuery({ ...templatesQueryOptions, enabled: create });
  const detail = useQuery({
    ...templateQueryOptions(values.template),
    enabled: values.template !== "",
    retry: false,
  });
  const config: TemplateConfig | undefined = detail.data?.config;
  // The template's own model and effort, for the inherit options: null while it loads, is broken or isn't chosen.
  const templateDoc =
    useQuery({
      ...templateConfigQueryOptions(values.template),
      enabled: values.template !== "",
    }).data?.doc ?? null;
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
  const me = useQuery(sessionQueryOptions).data?.user.handle;
  const users = useQuery(usersQueryOptions);

  // References a restored draft (or an edit made earlier) holds that no longer point at anything read as empty, with
  // the reason under the field. Edit leaves a value alone while it is still the saved one: an archived manager stays.
  const staleNotes: Partial<Record<Field, string>> = {};
  // Compares with `base`, the server copy the values were edited against (possibly stale until the next refetch merges).
  const changed = (f: keyof Values) => create || !base || !same(values[f], base[f]);
  // A manager is a live agent or an enabled user. Without the users list (loading, failed) a handle that is no agent
  // can't be judged, so it stands.
  if (
    values.reportsTo &&
    values.reportsTo !== me &&
    changed("reportsTo") &&
    activeAgents.data &&
    users.data &&
    !activeAgents.data.some(
      (a) =>
        a.slug === values.reportsTo &&
        a.kind === "persistent" &&
        !a.archivedAt &&
        !a.terminatedAt &&
        a.slug !== agent?.slug,
    ) &&
    !users.data.some((u) => u.handle === values.reportsTo && !u.disabledAt)
  )
    staleNotes.reportsTo = FORM_MSG.agentEnded;
  if (
    values.credential &&
    changed("credential") &&
    credentials &&
    !credentials.some((c) => c.name === values.credential)
  )
    staleNotes.credential = MSG.credentialDeleted;
  const goneProjects =
    create && values.touched.projects && projectList.data
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
        // New agent: the signed-in human manages it unless another manager was picked.
        reportsTo: base0.reportsTo || me || "",
        credential: base0.credential || defaultCredential(),
        projects:
          values.touched.projects || !templatePrefill ? base0.projects : templatePrefill.projects,
        slug: values.touched.slug || !slugFor ? base0.slug : slugFor(displayName),
      };
  // The detail lands asynchronously, so a field the user enters while it is still on the way is theirs as it stands:
  // filling it would mix the prefill into what they are about to type.
  const awaitingPrefill = create && values.template !== "" && !config;
  const claim = (f: "displayName" | "description") => {
    if (!awaitingPrefill || latest.current.touched[f]) return;
    update({ touched: { ...latest.current.touched, [f]: true }, [f]: shown[f] });
  };

  function check(f: Field, v: Values): string | undefined {
    switch (f) {
      case "template": {
        if (!create) return undefined;
        if (v.template === "") return FORM_MSG.chooseTemplate;
        const t = templates.data?.templates.find((x) => x.name === v.template);
        // A name that isn't listed (a stale ?template=) shows as unchosen, so it is.
        if (templates.data && !t) return FORM_MSG.chooseTemplate;
        if (t && t.errors > 0) return FORM_MSG.templateErrors;
        return undefined;
      }
      case "slug": {
        if (!create) return undefined;
        if (v.slug === "") return FORM_MSG.enterSlug;
        const r = slugSchema.safeParse(v.slug);
        return r.success ? undefined : r.error.issues[0]?.message;
      }
      case "displayName": {
        if (createAgentBodySchema.shape.displayName.safeParse(v.displayName).success) return;
        return v.displayName.trim() === "" ? FORM_MSG.enterDisplayName : FORM_MSG.displayNameLength;
      }
      case "description":
        return createAgentBodySchema.shape.description.safeParse(v.description).success
          ? undefined
          : FORM_MSG.descriptionLength;
      case "reportsTo":
        return v.reportsTo === "" ? FORM_MSG.chooseManager : undefined;
      case "credential":
        return v.credential === "" ? FORM_MSG.chooseCredential : undefined;
      default:
        return undefined;
    }
  }
  const f = useFieldErrors<Field>({
    form,
    fields: FIELDS,
    checks: Object.fromEntries(FIELDS.map((x) => [x, () => check(x, shown)])),
  });

  const set = <K extends Field>(field: K, v: Values[K]) => {
    update({
      [field]: v,
      ...(create && !latest.current.touched[field]
        ? { touched: { ...latest.current.touched, [field]: true } }
        : {}),
    });
    f.change(field);
    // The line describes the last submit; an edit makes it stale, and a notice it hid comes back.
    o.clear();
  };

  const setProjects = (next: string[]) => {
    update({
      projects: next,
      ...(create && !latest.current.touched.projects
        ? { touched: { ...latest.current.touched, projects: true } }
        : {}),
    });
    f.change("projects");
    o.clear();
  };

  // Model and effort: the scope's overlay and its functional update, over the two stored strings.
  const overlay = useMemo(
    () => overlayOf({ model: shown.model, effort: shown.effort }),
    [shown.model, shown.effort],
  );
  const setOverlay = (next: (prev: unknown) => unknown) => {
    const result = next(overlayOf({ model: latest.current.model, effort: latest.current.effort }));
    update({ model: overrideOf(result, "model"), effort: overrideOf(result, "effort") });
    o.clear();
  };
  /** What a save writes to the agent's config: New agent, anything chosen; Edit, only a change. */
  const modelEffortWrite = (): ModelEffort | undefined => {
    const write = { model: shown.model, effort: shown.effort };
    if (create) return write.model || write.effort ? write : undefined;
    const b = base as Stored;
    return write.model !== b.model || write.effort !== b.effort ? write : undefined;
  };
  const modelEffortChanged = !create && modelEffortWrite() !== undefined;

  function body(): CreateAgentBody | PatchAgentBody | null {
    const displayName = shown.displayName.trim();
    const description = shown.description.trim();
    if (create) {
      return {
        template: shown.template,
        slug: shown.slug,
        displayName,
        description,
        reportsTo: shown.reportsTo,
        credential: shown.credential,
        ...(values.touched.projects ? { projects: shown.projects } : {}),
        ...(shown.manageOrg ? { manageOrg: true } : {}),
      };
    }
    const b = base as Stored;
    const patch: PatchAgentBody = {};
    if (displayName !== b.displayName) patch.displayName = displayName;
    if (shown.color !== b.color) patch.color = shown.color;
    if (description !== b.description) patch.description = description;
    if (shown.reportsTo && shown.reportsTo !== b.reportsTo) patch.reportsTo = shown.reportsTo;
    if (shown.credential !== b.credential) patch.credential = shown.credential;
    if (!same(shown.projects, b.projects)) patch.projects = shown.projects;
    if (shown.manageOrg !== b.manageOrg) patch.manageOrg = shown.manageOrg;
    return Object.keys(patch).length > 0 ? patch : null;
  }

  // Edit: the fields a save would send now (the restart notice names them).
  const editPatch = create ? null : body();
  const changes: PatchField[] = editPatch
    ? PATCH_FIELDS.filter((f) => (editPatch as PatchAgentBody)[f] !== undefined)
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
      modelEffort: ModelEffort | undefined,
    ) => Promise<AgentSummary | undefined> | Promise<void>,
  ): Promise<SubmitResult> {
    // A ref, not `pending`: a second Enter can arrive before the first one's state has rendered.
    if (inFlight.current || noCredentials) return "nothing";
    o.clear();
    if (!f.submit()) return "invalid";
    const modelEffort = modelEffortWrite();
    // Edit with only a model or effort change has no agent patch: an empty one.
    const b = body() ?? (modelEffort ? {} : null);
    if (!b) {
      o.succeed("Nothing to save: no field changed.");
      return "nothing";
    }
    inFlight.current = true;
    setPending(true);
    let saved: AgentSummary | undefined;
    try {
      saved = (await onSubmit(b, modelEffort)) ?? undefined;
    } catch (err) {
      inFlight.current = false;
      // Re-enabled in the commit that focuses the field.
      setPending(false);
      if (err instanceof PartialSaveError) {
        // The agent part landed: it is the new base, so a retry sends only what is left.
        if (err.agent) setBase(storedOf(err.agent));
        o.fail(err.message);
        return "failed";
      }
      if (!(err instanceof ApiError)) o.fail(FORM_MSG.unreachable);
      else if (!f.server(err.body.fields as Record<string, string> | undefined)) {
        o.fail(err.message);
      }
      return "failed";
    }
    inFlight.current = false;
    setPending(false);
    // New agent: unmounted (the sheet was dismissed while creating), the draft stays; the sheet host clears it when no
    // sheet of this kind is open, or toasts "Open form" on a late failure.
    // Edit: the saved copy is the new base; the fields stay as the user left them (they equal it). The sheet closes
    // and toasts the outcome, so there is no inline success line.
    if (saved && !create) setBase(storedOf(saved));
    // Only this instance's draft: after a dismiss the key may hold a draft the user reopened and edited since.
    if (mounted.current) clearDraft();
    return "ok";
  }

  /** Clears the draft and puts the fields back to where a fresh open starts (the saved agent, or the context prefill). */
  function discard() {
    clearDraft();
    const fresh = base ?? blank(prefill);
    latest.current = fresh;
    setValues(fresh);
    f.reset();
    o.clear();
    setRestored(false);
  }

  return {
    values,
    shown,
    errors: f.errors,
    attempt: f.attempt,
    touched: values.touched,
    set,
    blur: f.blur,
    claim,
    setProjects,
    submit,
    pending,
    outcome: o.outcome,
    config,
    missingSecrets,
    noCredentials,
    credentials,
    restored,
    discard,
    staleNotes,
    changes,
    modelEffort: {
      value: overlay,
      base: templateDoc,
      onChange: setOverlay,
      disabledReason: create && values.template === "" ? FORM_MSG.chooseTemplateFirst : undefined,
    },
    modelEffortChanged,
  };
}
