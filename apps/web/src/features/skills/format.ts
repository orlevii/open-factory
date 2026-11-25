import { type RowState, rowStateOf } from "@open-factory/shared";
import { visibleControls } from "@/components/untrusted-text";

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

/** A plugin version: a hex one (a marketplace that versions by commit) shows as the commit it is. */
export const versionLabel = (v: string) =>
  visibleControls(/^[0-9a-f]{7,40}$/.test(v) ? `commit ${v.slice(0, 7)}` : v);

type Summary = {
  hooks: number;
  mcp: number;
  codeParts: number;
  dependencies: number;
  skills: number;
  commands: number;
  agents: number;
  outputStyles: number;
  unshown: number;
};

/** A plugin's contents by kind, hooks first, with zero kinds left out (spec §10.2). */
export function contentKinds(s: Summary): string[] {
  const kinds: [number, string, string][] = [
    [s.hooks, "hook", "hooks"],
    [s.mcp, "MCP server", "MCP servers"],
    [s.codeParts, "code part", "code parts"],
    [s.dependencies, "dependency", "dependencies"],
    [s.skills, "skill", "skills"],
    [s.commands, "command", "commands"],
    [s.agents, "agent", "agents"],
    [s.outputStyles, "output style", "output styles"],
  ];
  return kinds.filter(([n]) => n > 0).map(([n, one, many]) => count(n, one, many));
}

/** A pin as a declaration holds it: `commit:<sha>`, `tag:<name>`, `latest` or `live`. */
export function parsePluginPin(
  pin: string,
): { kind: "commit"; sha: string } | { kind: "tag"; name: string } | { kind: "latest" | "live" } {
  if (pin.startsWith("commit:")) return { kind: "commit", sha: pin.slice(7) };
  if (pin.startsWith("tag:")) return { kind: "tag", name: pin.slice(4) };
  return { kind: pin === "live" ? "live" : "latest" };
}

type MarketplaceSource =
  | { source: "github"; repo: string }
  | { source: "git"; url: string }
  | { source: "directory"; path: string };

/** A marketplace's source: the repo, the host and path of its URL, or the folder path. */
export function marketplaceSourceLabel(s: MarketplaceSource): string {
  if (s.source === "github") return s.repo;
  if (s.source === "directory") return s.path;
  try {
    const u = new URL(s.url);
    return `${u.host}${u.pathname}`.replace(/\.git$/, "");
  } catch {
    return s.url;
  }
}

/** A catalog entry's one state (spec §10.2): "Can't use" for a refused source, "Can't be pinned" for one that follows its own source. */
export function pluginRowState(e: {
  state: "ok" | "missing" | "refused" | "cant_pin";
  pinnable: boolean;
}): RowState | undefined {
  return rowStateOf([
    ...(e.state === "missing" ? (["missing"] as const) : []),
    ...(e.state === "refused" ? (["refused"] as const) : []),
    ...(e.state === "cant_pin" || (e.state === "ok" && !e.pinnable) ? (["cant_pin"] as const) : []),
  ]);
}
