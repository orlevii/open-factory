/** "190 agents", with a non-breaking space: only a number and its noun are kept together (spec §10.2). */
export const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "Used by 3 templates · 2 agents", with zero kinds left out, or "Not used". */
export function usedByText(templates: number, agents: number): string {
  const parts = [
    ...(templates > 0 ? [count(templates, "template")] : []),
    ...(agents > 0 ? [count(agents, "agent")] : []),
  ];
  return parts.length === 0 ? "Not used" : `Used by ${parts.join(" · ")}`;
}

type SourceFields = {
  kind: "folder" | "github";
  path: string | null;
  repo: string | null;
  subpath: string | null;
  pin: string | null;
};

/** A source's name: the repo and subpath, or the folder path. */
export const sourceLabel = (s: Pick<SourceFields, "kind" | "path" | "repo" | "subpath">) =>
  s.kind === "github"
    ? s.subpath
      ? `${s.repo ?? ""}/${s.subpath}`
      : (s.repo ?? "")
    : (s.path ?? "");

/** A GitHub source shows its pin as a short sha (none while it is still being added); a folder is always live. */
export const pinLabel = (s: Pick<SourceFields, "kind" | "pin">) =>
  s.kind === "folder" ? "Live" : s.pin ? s.pin.slice(0, 7) : undefined;
