import { type AgentSummary, ApiError, type ProjectSummary } from "@open-factory/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";
import { ErrorLine } from "@/components/error-line";
import { useOutcome } from "@/components/forms/form-outcome";
import { useFieldErrors } from "@/components/forms/use-field-errors";
import { InlineOutcome } from "@/components/inline-outcome";
import { MiddleTruncate } from "@/components/middle-truncate";
import { checkHostPath, PathField } from "@/components/path-field";
import {
  AdaptiveMenuContent,
  AdaptiveMenuItem,
  AdaptiveMenuSeparator,
  AdaptiveMenuTrigger,
} from "@/components/ui/adaptive-menu";
import { Button } from "@/components/ui/button";
import { agentsQueryOptions } from "@/features/session/api";
import {
  createProject,
  deleteProject,
  projectsQueryOptions,
  updateProject,
} from "@/features/settings/api";
import {
  AgentLinks,
  cappedList,
  InlineForm,
  MoreButton,
  RowLine,
  RowName,
  SettingsList,
  SettingsRow,
  SettingsRowMenu,
  SettingsSection,
  Usage,
  useFocusLater,
} from "@/features/settings/shared";
import { AddProjectForm } from "./forms/add-project-form";
import { fieldsOf } from "./forms/shared";

type Outcome = {
  tone: "success" | "error" | "pending";
  content: ReactNode;
  focusKey?: number;
  undo?: () => void;
};

const NO_SPAWNERS = new Map<string, string>();
/** Spawned agent -> the agent that spawned it, from the active list. */
const toSpawners = (agents: AgentSummary[]) =>
  new Map(
    agents.flatMap((a) =>
      a.kind === "ephemeral" && a.reportsTo.kind === "agent"
        ? [[a.handle, a.reportsTo.handle]]
        : [],
    ) as [string, string][],
  );

/** Why Remove is disabled. A live spawned grantee is named through its spawner (S7 UI design §7):
 *  "granted to @tech-lead-ab12, spawned by @lead". `spawners` maps a spawned agent to its spawner. */
function removeBlocker(p: ProjectSummary, spawners: Map<string, string>): string | undefined {
  const list = (s: string[]) => cappedList(s.map((x) => `@${x}`));
  const grantee = (x: string) => {
    const by = spawners.get(x);
    return by ? `@${x}, spawned by @${by}` : `@${x}`;
  };
  if (p.grantedTo.length) return `granted to ${cappedList(p.grantedTo.map(grantee))}`;
  if (p.archivedGrantedTo.length) {
    const many = p.archivedGrantedTo.length > 1;
    return `archived ${list(p.archivedGrantedTo)} still ${many ? "hold grants" : "holds a grant"}`;
  }
  return undefined;
}

/** "Template x now shows an error…" for the templates that list a removed project. */
function templatesNote(templates: string[]): string {
  if (templates.length === 0) return "";
  if (templates.length === 1) {
    return ` Template ${templates[0]} now shows an error until you remove the project from it or add it back.`;
  }
  const names = `${templates.slice(0, -1).join(", ")} and ${templates.at(-1)}`;
  return ` Templates ${names} now show an error until you remove the project from them or add it back.`;
}

function InUseMessage({ grantedTo, archived }: { grantedTo: string[]; archived: string[] }) {
  return (
    <>
      {grantedTo.length > 0 && (
        <>
          Granted to <AgentLinks handles={grantedTo} edit />. Remove the grant first.
        </>
      )}
      {grantedTo.length > 0 && archived.length > 0 && " "}
      {archived.length > 0 && (
        <>
          Archived agents <AgentLinks handles={archived} edit /> still hold a grant.
        </>
      )}
    </>
  );
}

const FIELDS = ["hostPath"] as const;

function ChangePathForm({
  project,
  onDone,
  onCancel,
}: {
  project: ProjectSummary;
  onDone(p: ProjectSummary): void;
  onCancel(): void;
}) {
  const [hostPath, setHostPath] = useState(project.hostPath);
  const o = useOutcome();
  const [pending, setPending] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);

  const f = useFieldErrors({
    form: formRef,
    fields: FIELDS,
    checks: { hostPath: () => checkHostPath(hostPath) },
  });

  async function submit() {
    o.clear();
    if (!f.submit()) return;
    setPending(true);
    try {
      onDone(await updateProject(project.name, hostPath.trim()));
    } catch (err) {
      setPending(false);
      if (!f.server(fieldsOf(err)))
        o.fail(err instanceof ApiError ? err.message : "Couldn't save the path. Try again.");
    }
  }

  return (
    <InlineForm
      label={`Change path of ${project.name}`}
      onSubmit={() => void submit()}
      onCancel={onCancel}
      submitLabel="Save path"
      pendingLabel="Saving…"
      pending={pending}
      outcome={o.outcome}
      ref={formRef}
    >
      <PathField
        name={`project-path-${project.name}`}
        label="Path"
        help="A folder on the factory's machine, like ~/code/web."
        error={f.errors.hostPath}
        value={hostPath}
        onChange={(e) => {
          setHostPath(e.target.value);
          f.change("hostPath");
        }}
        onBlur={(e) => f.blur("hostPath", e)}
      />
    </InlineForm>
  );
}

export function ProjectsSection() {
  const qc = useQueryClient();
  const query = useQuery({ ...projectsQueryOptions, refetchOnMount: false }); // the settings loader just fetched it;
  const { data } = query;
  // Only needed to name a spawned grantee's spawner; a failed list leaves the plain handles.
  const { data: spawners } = useQuery({
    ...agentsQueryOptions,
    select: toSpawners,
    enabled: (data ?? []).some((p) => p.grantedTo.length > 0),
  });
  const focusLater = useFocusLater();
  const [adding, setAdding] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>();
  const [rowOutcome, setRowOutcome] = useState<Record<string, Outcome>>({});
  const [changing, setChanging] = useState<string>();
  const [removing, setRemoving] = useState<string>();
  // Set when a menu item opens a form or dialog: the menu then hands focus to that field (or
  // leaves it to the dialog) instead of pulling it back to ⋯.
  const menuHandsOff = useRef<string | false>(false);

  const refresh = () => qc.invalidateQueries({ queryKey: projectsQueryOptions.queryKey });
  const upsert = (p: ProjectSummary) =>
    qc.setQueryData(projectsQueryOptions.queryKey, (old) =>
      old?.some((x) => x.name === p.name)
        ? old.map((x) => (x.name === p.name ? p : x))
        : [...(old ?? []), p].sort((a, b) => a.name.localeCompare(b.name)),
    );
  const setRow = (name: string, o: Outcome | undefined) =>
    setRowOutcome((x) => {
      const next = { ...x };
      if (o) next[name] = o;
      else delete next[name];
      return next;
    });

  async function undoRemove(p: ProjectSummary) {
    setOutcome({ tone: "pending", content: `Restoring ${p.name}…`, focusKey: Date.now() });
    try {
      upsert(await createProject({ name: p.name, hostPath: p.hostPath }));
      setOutcome({ tone: "success", content: `Restored ${p.name}.`, focusKey: Date.now() });
      void refresh();
    } catch (err) {
      setOutcome({
        tone: "error",
        content: err instanceof ApiError ? err.message : `Couldn't restore ${p.name}. Try again.`,
        focusKey: Date.now(),
      });
    }
  }

  async function remove(p: ProjectSummary) {
    if (removing) return;
    setRemoving(p.name);
    setRow(p.name, { tone: "pending", content: `Removing ${p.name}…` });
    try {
      await deleteProject(p.name);
      qc.setQueryData(projectsQueryOptions.queryKey, (old) =>
        old?.filter((x) => x.name !== p.name),
      );
      setRow(p.name, undefined);
      // Nothing could hold a grant, so re-adding the same name and path loses nothing.
      setOutcome({
        tone: "success",
        content: `Removed ${p.name}.${templatesNote(p.templates)}`,
        undo: () => void undoRemove(p),
        focusKey: Date.now(),
      });
      void refresh();
    } catch (err) {
      const body = err instanceof ApiError ? err.body : {};
      const list = (k: string) =>
        Array.isArray(body[k]) ? (body[k] as unknown[]).map(String) : [];
      setRow(p.name, {
        tone: "error",
        content:
          err instanceof ApiError && err.code === "project_in_use" ? (
            <InUseMessage grantedTo={list("grantedTo")} archived={list("archivedGrantedTo")} />
          ) : err instanceof ApiError ? (
            err.message
          ) : (
            `Couldn't remove ${p.name}. Try again.`
          ),
        focusKey: Date.now(),
      });
      void refresh();
    } finally {
      setRemoving(undefined);
    }
  }

  const projects = data ?? [];
  return (
    <SettingsSection
      id="projects"
      title="Projects"
      description={
        <>
          Folders on this machine that agents can be granted. Granted agents see them at{" "}
          <code className="font-mono text-[0.8125rem]">./projects/&lt;name&gt;</code>.
        </>
      }
    >
      {!data && query.isError && (
        <ErrorLine text="Couldn't load projects." onRetry={() => void query.refetch()} />
      )}
      {data &&
        (projects.length === 0 ? (
          <p className="text-sm text-muted-foreground">No projects yet.</p>
        ) : (
          <SettingsList>
            {projects.map((p) => {
              const blocker = removeBlocker(p, spawners ?? NO_SPAWNERS);
              return (
                <SettingsRow
                  key={p.name}
                  data-name={p.name}
                  className="grid grid-cols-[minmax(0,1fr)] gap-1 px-2 py-1.5"
                >
                  <RowLine
                    actions={
                      <SettingsRowMenu title={p.name}>
                        <AdaptiveMenuTrigger asChild>
                          <MoreButton
                            id={`project-menu-${p.name}`}
                            label={`Actions for ${p.name}`}
                          />
                        </AdaptiveMenuTrigger>
                        <AdaptiveMenuContent
                          align="end"
                          onCloseAutoFocus={(e) => {
                            const target = menuHandsOff.current;
                            menuHandsOff.current = false;
                            if (target === false) return;
                            e.preventDefault();
                            if (target) document.getElementById(target)?.focus();
                          }}
                        >
                          <AdaptiveMenuItem
                            onSelect={() => {
                              menuHandsOff.current = `field-project-path-${p.name}`;
                              setRow(p.name, undefined);
                              setChanging(p.name);
                            }}
                          >
                            Change path
                          </AdaptiveMenuItem>
                          <AdaptiveMenuSeparator />
                          <AdaptiveMenuItem
                            variant="destructive"
                            disabled={Boolean(blocker) || removing === p.name}
                            // Focus goes back to ⋯ while it runs, then to the outcome's Undo.
                            onSelect={() => void remove(p)}
                          >
                            {blocker ? `Remove (${blocker})` : "Remove"}
                          </AdaptiveMenuItem>
                        </AdaptiveMenuContent>
                      </SettingsRowMenu>
                    }
                  >
                    <RowName>{p.name}</RowName>
                    <span className="flex min-w-0 basis-full font-mono text-[0.8125rem] text-muted-foreground md:basis-auto md:flex-1">
                      <MiddleTruncate text={p.hostPath} />
                    </span>
                    <Usage
                      active={p.grantedTo}
                      archived={p.archivedGrantedTo}
                      verb="Granted to"
                      none="Not granted"
                    />
                  </RowLine>
                  <InlineOutcome
                    tone={rowOutcome[p.name]?.tone}
                    focusKey={rowOutcome[p.name]?.focusKey}
                  >
                    {rowOutcome[p.name]?.content}
                  </InlineOutcome>
                  {changing === p.name && (
                    <ChangePathForm
                      project={p}
                      onCancel={() => {
                        setChanging(undefined);
                        focusLater(`project-menu-${p.name}`);
                      }}
                      onDone={(r) => {
                        upsert(r);
                        setChanging(undefined);
                        setRow(p.name, {
                          tone: "success",
                          content:
                            r.grantedTo.length > 0
                              ? "Saved. Granted agents restart when idle to use the new path. Their crons from this session stop."
                              : "Saved.",
                          focusKey: Date.now(),
                        });
                        void refresh();
                      }}
                    />
                  )}
                </SettingsRow>
              );
            })}
          </SettingsList>
        ))}
      {/* Empty, it takes no space; it stays mounted so its text is announced. */}
      <div id="projects-outcome" className="[&:not(:has([tabindex]))]:-mt-3">
        <InlineOutcome tone={outcome?.tone} focusKey={outcome?.focusKey} undo={outcome?.undo}>
          {outcome?.content}
        </InlineOutcome>
      </div>
      {adding ? (
        <AddProjectForm
          frame="inline"
          existing={projects.map((p) => p.name)}
          onCancel={() => {
            setAdding(false);
            focusLater("projects-add");
          }}
          onDone={(p) => {
            upsert(p);
            setAdding(false);
            setOutcome({ tone: "success", content: `Added ${p.name}.`, focusKey: Date.now() });
            void refresh();
          }}
        />
      ) : (
        <div>
          <Button
            id="projects-add"
            type="button"
            variant="ghost"
            onClick={() => {
              setOutcome(undefined);
              setAdding(true);
            }}
          >
            <Plus aria-hidden="true" data-icon="inline-start" />
            Add project
          </Button>
        </div>
      )}
    </SettingsSection>
  );
}
