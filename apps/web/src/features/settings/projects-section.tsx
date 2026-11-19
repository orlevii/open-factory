import { ApiError, nameSchema, type ProjectSummary } from "@open-factory/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";
import { FormField } from "@/components/form-field";
import { InlineOutcome } from "@/components/inline-outcome";
import { MiddleTruncate } from "@/components/middle-truncate";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  createProject,
  deleteProject,
  projectsQueryOptions,
  updateProject,
} from "@/features/settings/api";
import {
  AgentLinks,
  InlineForm,
  MoreButton,
  RowLine,
  RowName,
  SettingsList,
  SettingsSection,
  Usage,
  useFocusLater,
} from "@/features/settings/shared";

type Outcome = {
  tone: "success" | "error" | "pending";
  content: ReactNode;
  focusKey?: number;
  undo?: () => void;
};

const PATH_HELP = "Absolute path to a folder on this machine, usually a git repository.";
const checkPath = (p: string) =>
  p.trim() === ""
    ? "Enter a path."
    : p.trim().startsWith("/")
      ? undefined
      : "Enter an absolute path.";

function removeBlocker(p: ProjectSummary): string | undefined {
  const list = (s: string[]) => s.map((x) => `@${x}`).join(", ");
  if (p.grantedTo.length) return `granted to ${list(p.grantedTo)}`;
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
          Granted to <AgentLinks slugs={grantedTo} edit />. Remove the grant first.
        </>
      )}
      {grantedTo.length > 0 && archived.length > 0 && " "}
      {archived.length > 0 && (
        <>
          Archived agents <AgentLinks slugs={archived} edit /> still hold a grant.
        </>
      )}
    </>
  );
}

/** Server field errors (`400 validation_error` with `fields`) for this form's fields. */
const fieldsOf = (err: unknown): Record<string, string> | undefined =>
  err instanceof ApiError && err.code === "validation_error"
    ? ((err.body.fields ?? {}) as Record<string, string>)
    : undefined;

function AddProjectForm({
  existing,
  onDone,
  onCancel,
}: {
  existing: string[];
  onDone(p: ProjectSummary): void;
  onCancel(): void;
}) {
  const [name, setName] = useState("");
  const [hostPath, setHostPath] = useState("");
  const [errors, setErrors] = useState<{ name?: string; hostPath?: string }>({});
  const [formError, setFormError] = useState<string>();
  const [pending, setPending] = useState(false);

  const checkName = (n: string) => {
    if (!nameSchema.safeParse(n).success) {
      return "Use 2–40 lowercase letters, numbers and inner hyphens, starting with a letter.";
    }
    return existing.includes(n) ? `A project named ${n} already exists.` : undefined;
  };
  const focus = (f: "name" | "hostPath") =>
    document.getElementById(f === "name" ? "field-project-name" : "field-project-path")?.focus();

  async function submit() {
    const found = { name: checkName(name), hostPath: checkPath(hostPath) };
    setErrors(found);
    setFormError(undefined);
    if (found.name || found.hostPath) return focus(found.name ? "name" : "hostPath");
    setPending(true);
    try {
      onDone(await createProject({ name, hostPath: hostPath.trim() }));
    } catch (err) {
      const fields = fieldsOf(err);
      if (err instanceof ApiError && err.code === "project_exists") {
        setErrors({ name: err.message });
        focus("name");
      } else if (fields && (fields.name || fields.hostPath)) {
        setErrors({ name: fields.name, hostPath: fields.hostPath });
        focus(fields.name ? "name" : "hostPath");
      } else {
        setFormError(
          err instanceof ApiError ? err.message : "Couldn't add the project. Try again.",
        );
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <InlineForm
      label="Add project"
      onSubmit={() => void submit()}
      onCancel={onCancel}
      submitLabel="Add project"
      pendingLabel="Adding…"
      pending={pending}
      formError={formError}
    >
      <FormField
        name="project-name"
        label="Name"
        error={errors.name}
        value={name}
        onChange={(e) => {
          setName(e.target.value);
          setErrors((x) => ({ ...x, name: undefined }));
        }}
        onBlur={() => setErrors((x) => ({ ...x, name: checkName(name) }))}
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        className="font-mono"
      />
      <FormField
        name="project-path"
        label="Path"
        help={PATH_HELP}
        error={errors.hostPath}
        value={hostPath}
        onChange={(e) => {
          setHostPath(e.target.value);
          setErrors((x) => ({ ...x, hostPath: undefined }));
        }}
        onBlur={() => setErrors((x) => ({ ...x, hostPath: checkPath(hostPath) }))}
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        className="font-mono"
      />
    </InlineForm>
  );
}

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
  const [error, setError] = useState<string>();
  const [formError, setFormError] = useState<string>();
  const [pending, setPending] = useState(false);
  const field = `project-path-${project.name}`;
  const focus = () => document.getElementById(`field-${field}`)?.focus();

  async function submit() {
    const e = checkPath(hostPath);
    setError(e);
    setFormError(undefined);
    if (e) return focus();
    setPending(true);
    try {
      onDone(await updateProject(project.name, hostPath.trim()));
    } catch (err) {
      const fields = fieldsOf(err);
      if (fields?.hostPath) {
        setError(fields.hostPath);
        focus();
      } else {
        setFormError(err instanceof ApiError ? err.message : "Couldn't save the path. Try again.");
      }
    } finally {
      setPending(false);
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
      formError={formError}
    >
      <FormField
        name={field}
        label="Path"
        help={PATH_HELP}
        error={error}
        value={hostPath}
        onChange={(e) => {
          setHostPath(e.target.value);
          setError(undefined);
        }}
        onBlur={() => setError(checkPath(hostPath))}
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        className="font-mono"
      />
    </InlineForm>
  );
}

export function ProjectsSection() {
  const qc = useQueryClient();
  const { data } = useQuery(projectsQueryOptions);
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
      {data &&
        (projects.length === 0 ? (
          <p className="text-sm text-muted-foreground">No projects yet.</p>
        ) : (
          <SettingsList>
            {projects.map((p) => {
              const blocker = removeBlocker(p);
              return (
                <li key={p.name} data-name={p.name} className="grid gap-1 px-2 py-1.5">
                  <RowLine
                    actions={
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <MoreButton
                            id={`project-menu-${p.name}`}
                            label={`Actions for ${p.name}`}
                          />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent
                          align="end"
                          onCloseAutoFocus={(e) => {
                            const target = menuHandsOff.current;
                            menuHandsOff.current = false;
                            if (target === false) return;
                            e.preventDefault();
                            if (target) document.getElementById(target)?.focus();
                          }}
                        >
                          <DropdownMenuItem
                            onSelect={() => {
                              menuHandsOff.current = `field-project-path-${p.name}`;
                              setRow(p.name, undefined);
                              setChanging(p.name);
                            }}
                          >
                            Change path
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            disabled={Boolean(blocker) || removing === p.name}
                            // Focus goes back to ⋯ while it runs, then to the outcome's Undo.
                            onSelect={() => void remove(p)}
                          >
                            {blocker ? `Remove (${blocker})` : "Remove"}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
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
                              ? "Saved. Granted agents restart when idle to use the new path. Reminders they scheduled in this session are lost."
                              : "Saved.",
                          focusKey: Date.now(),
                        });
                        void refresh();
                      }}
                    />
                  )}
                </li>
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
