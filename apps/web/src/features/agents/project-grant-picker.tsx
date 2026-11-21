import type { ProjectSummary } from "@open-factory/shared";
import { Link } from "@tanstack/react-router";
import { CircleAlert } from "lucide-react";
import { MiddleTruncate } from "@/components/middle-truncate";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";

/** The projects an agent is granted: a native checkbox group. "From the template" until the user
 *  changes the set, then "Custom" with a way back to the template's default. */
export function ProjectGrantPicker({
  projects,
  value,
  custom,
  error,
  onChange,
  onUseDefault,
}: {
  projects: ProjectSummary[] | undefined;
  value: string[];
  custom: boolean;
  /** A server field error (e.g. a project removed while the form was open). */
  error?: string;
  onChange: (next: string[]) => void;
  onUseDefault: () => void;
}) {
  const noteId = "field-projects-note";
  const errorId = "field-projects-error";
  return (
    <fieldset
      className="grid min-w-0 gap-2"
      aria-describedby={error ? `${noteId} ${errorId}` : noteId}
      aria-invalid={error ? true : undefined}
    >
      <legend className="mb-1.5 flex items-baseline gap-2 text-[0.8125rem] font-medium">
        Projects
        <span id={noteId} className="font-normal text-muted-foreground">
          {custom ? "Custom" : "From the template"}
        </span>
      </legend>
      {!projects && <p className="text-[0.8125rem] text-muted-foreground">Loading…</p>}
      {projects && projects.length === 0 && (
        <p className="text-[0.8125rem] text-muted-foreground">
          No projects yet.{" "}
          <Link
            to="/settings"
            hash="projects"
            className="text-foreground underline underline-offset-4 decoration-muted-foreground hover:decoration-ring"
          >
            Add one in Settings
          </Link>
          .
        </p>
      )}
      {projects && projects.length > 0 && (
        <ul className="grid gap-1">
          {projects.map((p, i) => {
            const id = i === 0 ? "field-projects" : `field-projects-${p.name}`;
            const checked = value.includes(p.name);
            return (
              <li key={p.name} className="flex min-w-0 items-center gap-2">
                <Checkbox
                  id={id}
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
      {error && (
        <p
          id={errorId}
          className="flex items-start gap-1.5 text-[0.8125rem] leading-[1.125rem] text-destructive"
        >
          <CircleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          {error}
        </p>
      )}
      {custom && (
        <div>
          <Button type="button" variant="outline" size="sm" onClick={onUseDefault}>
            Use template default
          </Button>
        </div>
      )}
    </fieldset>
  );
}
