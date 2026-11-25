import type { ProjectSummary } from "@open-factory/shared";
import { Link } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { FieldShell } from "@/components/field-shell";
import { MiddleTruncate } from "@/components/middle-truncate";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";

/** The projects an agent is granted: a checkbox group (Radix checkboxes) on `FieldShell legend`. With
 *  `onAddProject` (a sheet that can stack Add project), a ghost "Add project" sits under the list; without it,
 *  the empty state links to Settings. */
export function ProjectGrantPicker({
  projects,
  value,
  error,
  help,
  onChange,
  onAddProject,
}: {
  projects: ProjectSummary[] | undefined;
  value: string[];
  /** A server field error (e.g. a project removed while the form was open). */
  error?: string;
  /** The note's muted line (chosen projects that were removed since). */
  help?: string;
  onChange: (next: string[]) => void;
  onAddProject?: () => void;
}) {
  return (
    <FieldShell
      name="projects"
      label="Projects"
      legend
      error={error}
      help={help}
      below={
        onAddProject && (
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              inForm
              data-skip-validate
              onClick={onAddProject}
            >
              <Plus aria-hidden="true" data-icon="inline-start" />
              Add project
            </Button>
          </div>
        )
      }
    >
      {() => (
        <>
          {!projects && <p className="text-[0.8125rem] text-muted-foreground">Loading…</p>}
          {projects && projects.length === 0 && (
            <p className="text-[0.8125rem] text-muted-foreground">
              No projects yet.
              {!onAddProject && (
                <>
                  {" "}
                  <Link
                    to="/settings/projects"
                    className="text-foreground underline underline-offset-4 decoration-muted-foreground hover:decoration-ring"
                  >
                    Add one in Settings
                  </Link>
                  .
                </>
              )}
            </p>
          )}
          {projects && projects.length > 0 && (
            <ul className="grid gap-1">
              {projects.map((p, i) => {
                const id = i === 0 ? "field-projects" : `field-projects-${i}`;
                const checked = value.includes(p.name);
                return (
                  <li key={p.name} className="flex min-w-0 items-center gap-2">
                    <Checkbox
                      id={id}
                      data-project={p.name}
                      checked={checked}
                      onCheckedChange={() =>
                        onChange(checked ? value.filter((n) => n !== p.name) : [...value, p.name])
                      }
                    />
                    <label
                      htmlFor={id}
                      className="flex min-w-0 flex-1 items-baseline gap-3 text-[0.8125rem]"
                    >
                      <span className="shrink-0 font-mono">{p.name}</span>
                      <span className="min-w-0 font-mono text-muted-foreground">
                        <MiddleTruncate text={p.hostPath} />
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </FieldShell>
  );
}
