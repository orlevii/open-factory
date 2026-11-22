import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { credentialsQueryOptions } from "@/features/settings/api";
import { templatesQueryOptions } from "@/features/templates/api";

export type MissingPrerequisite = "credential" | "template" | "valid-template" | null;

/** What an agent needs before it can be created, first missing one wins: a credential, then a
 *  template, then a template without errors. `loading` until both lists have answered. */
export function usePrerequisites(): {
  missing: MissingPrerequisite;
  invalidTemplate?: string;
  loading: boolean;
  failed: boolean;
} {
  const credentials = useQuery(credentialsQueryOptions);
  // Templates are rescanned on every GET, so a fix on disk shows on the next visit.
  const templates = useQuery(templatesQueryOptions);
  if (!credentials.data || !templates.data) {
    return {
      missing: null,
      loading: credentials.isPending || templates.isPending,
      failed: credentials.isError || templates.isError,
    };
  }
  const base = { loading: false, failed: false };
  if (credentials.data.length === 0) return { ...base, missing: "credential" };
  const list = templates.data.templates;
  if (list.length === 0) return { ...base, missing: "template" };
  if (!list.some((t) => t.errors === 0)) {
    return { ...base, missing: "valid-template", invalidTemplate: list[0]?.name };
  }
  return { ...base, missing: null };
}

const linkClass =
  "text-foreground underline underline-offset-4 decoration-muted-foreground hover:decoration-ring";

/** The one line that names the first missing prerequisite and links to its fix. `prefix` is the
 *  Agents empty state's "No agents yet."; with nothing missing it offers New agent. */
export function PrerequisiteLine({
  missing,
  invalidTemplate,
  prefix,
}: {
  missing: MissingPrerequisite;
  invalidTemplate?: string;
  prefix?: string;
}) {
  const lead = prefix ? `${prefix} ` : "";
  return (
    <p className="text-sm text-muted-foreground">
      {lead}
      {missing === "credential" && (
        <>
          <Link to="/settings/credentials" className={linkClass}>
            Add a Claude credential in Settings
          </Link>{" "}
          first.
        </>
      )}
      {missing === "template" && (
        <>
          Start by{" "}
          <Link to="/templates/new" className={linkClass}>
            creating a template
          </Link>
          .
        </>
      )}
      {missing === "valid-template" && invalidTemplate && (
        <>
          No template is ready: fix the errors in{" "}
          <Link
            to="/templates/$name"
            params={{ name: invalidTemplate }}
            className={`font-mono text-[0.8125rem] ${linkClass}`}
          >
            {invalidTemplate}
          </Link>
          .
        </>
      )}
      {missing === null && (
        <>
          <Link to="/agents/new" className={linkClass}>
            Create one
          </Link>{" "}
          from a template.
        </>
      )}
    </p>
  );
}
