import { z } from "zod";
import type { ConfigDoc } from "./config.ts";
import { isHostPathShape } from "./host.ts";
import { MSG } from "./messages.ts";
import { hostSkillSchema } from "./names.ts";

/** A marketplace's name (spec §5.1). The reserved and official names below are checked on top of it. */
export const MARKETPLACE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Names Claude Code never allows as a marketplace (spec §5.1). */
export const RESERVED_MARKETPLACES: readonly string[] = [
  "inline",
  "skills-dir",
  "synced",
  "builtin",
  "claude-plugin-test",
];

/** How a marketplace declaration pins it (spec §7.4): a commit, a tag, no `ref` (Latest), or a live folder. */
export type PinKind = "commit" | "tag" | "latest";

/**
 * Official names Claude reserves for Anthropic's own sources. Each is allowed only with its matching
 * source; any other source is refused (spec §5.1). `pins` records the pin kinds Claude Code accepts for the
 * name (G1, Claude Code 2.1.331: a commit `ref` is refused ("follow a branch or tag"), and the repo has no
 * tags), so the marketplace is Latest only in practice (spec §7.4).
 */
export const OFFICIAL_MARKETPLACES: Record<
  string,
  { source: "github"; repo: string; pins: readonly PinKind[] }
> = {
  "claude-plugins-official": {
    source: "github",
    repo: "anthropics/claude-plugins-official",
    pins: ["tag", "latest"],
  },
};

/** The pin kinds Claude Code accepts for a marketplace name. */
export const acceptedPins = (name: string): readonly PinKind[] =>
  OFFICIAL_MARKETPLACES[name]?.pins ?? ["commit", "tag", "latest"];

/** A plugin name: one segment of a plugin key and of `--settings`, so only the key's own characters. The one validator. */
export const PLUGIN_NAME_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

/** `name@marketplace`: a plugin name (`PLUGIN_NAME_PATTERN`), then a marketplace name (`MARKETPLACE_PATTERN`). */
export const PLUGIN_REF_PATTERN = new RegExp(
  `^${PLUGIN_NAME_PATTERN.source.slice(1, -1)}@${MARKETPLACE_PATTERN.source.slice(1, -1)}$`,
);

const hasControl = (s: string): boolean =>
  [...s].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f);

/** `owner/repo` or `https://github.com/owner/repo[.git]`, with no userinfo, query or fragment. */
const REPO_FORM =
  /^(?:https:\/\/github\.com\/)?([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100})$/;

/** Normalises a GitHub repo to lower-case `owner` and `repo`, or returns null when the input isn't one. */
export function normalizeRepo(input: string): { owner: string; repo: string } | null {
  const m = REPO_FORM.exec(input);
  if (!m) return null;
  const repo = (m[2] ?? "").replace(/\.git$/, "").toLowerCase();
  if (repo === "" || repo === "." || repo === "..") return null;
  return { owner: (m[1] ?? "").toLowerCase(), repo };
}

/**
 * A repo subpath: "" is the repo root. Returns the path without a trailing slash, or null for a path
 * that is absolute or has an empty, `.` or `..` segment, a backslash or a control character.
 */
export function normalizeSubpath(input: string): string | null {
  if (input === "") return "";
  if (input.startsWith("/") || input.includes("\\") || hasControl(input)) return null;
  const trimmed = input.endsWith("/") ? input.slice(0, -1) : input;
  if (trimmed.split("/").some((p) => p === "" || p === "." || p === "..")) return null;
  return trimmed;
}

/** git's `check-ref-format` rules for a branch name, in TypeScript. */
export function checkBranchName(b: string): boolean {
  if (b === "" || b === "@" || b.startsWith("-") || b.includes("..") || b.includes("@{"))
    return false;
  if (hasControl(b) || /[ ~^:?*[\\]/.test(b)) return false;
  if (b.startsWith("/") || b.endsWith("/") || b.includes("//") || b.endsWith(".")) return false;
  return b.split("/").every((part) => !part.startsWith(".") && !part.endsWith(".lock"));
}

const COMMIT_SHA = /^[0-9a-f]{40}$/;

const REF_MAX = 64;
const HEX_LOOKING = /^[0-9a-fA-F]{7,}$/;

/**
 * Whether a declaration's `ref` has the shape of a pin (spec §7.4): a 40-hex (lower-case) commit, or a tag name by
 * the §6.2 ref-format rules, at most 64 characters. A `refs/…` ref is refused, and so is a hex-looking string that
 * isn't a full commit (an abbreviated or upper-case sha, which git would resolve by prefix, not as a tag). Whether a
 * name is a recorded tag is the "Skills hasn't read" warning, which needs the registry.
 */
export function checkPinRef(ref: string): boolean {
  if (COMMIT_SHA.test(ref)) return true;
  if (ref.length > REF_MAX || HEX_LOOKING.test(ref) || ref.startsWith("refs/")) return false;
  return checkBranchName(ref);
}

/** A marketplace's pin: what its declaration (`extraKnownMarketplaces[name]`) holds it at (spec §8.1). */
export type Pin =
  | { kind: "commit"; sha: string }
  | { kind: "tag"; name: string }
  | { kind: "latest" }
  | { kind: "live" };

/** The pin of a marketplace declaration: a folder is live; a 40-hex `ref` is a commit, another one a tag; none is Latest. */
export function pinOf(declaration: unknown): Pin {
  const source =
    typeof declaration === "object" && declaration !== null
      ? (declaration as { source?: unknown }).source
      : undefined;
  const src =
    typeof source === "object" && source !== null ? (source as Record<string, unknown>) : {};
  if (src.source === "directory") return { kind: "live" };
  const ref = src.ref;
  if (typeof ref !== "string") return { kind: "latest" };
  return COMMIT_SHA.test(ref) ? { kind: "commit", sha: ref } : { kind: "tag", name: ref };
}

/** The enabled plugin keys of a config doc: the `enabledPlugins` entries set to `true` (spec §7.4). */
export function effectivePlugins(doc: Pick<ConfigDoc, "settings">): string[] {
  const enabled = doc.settings.enabledPlugins;
  if (typeof enabled !== "object" || enabled === null || Array.isArray(enabled)) return [];
  return Object.entries(enabled)
    .filter(([, v]) => v === true)
    .map(([k]) => k);
}

/** A git URL the factory stores: https only, with no userinfo (even empty), `?` or `#` (spec §7.1). */
export function checkGitUrl(u: string): boolean {
  if (!u.startsWith("https://") || /[\s?#]/.test(u) || hasControl(u)) return false;
  if (/^https:\/\/[^/]*@/.test(u)) return false;
  try {
    const url = new URL(u);
    return (
      url.protocol === "https:" && url.username === "" && url.password === "" && url.hostname !== ""
    );
  } catch {
    return false;
  }
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * Cuts text to at most `max` graphemes, counting the trailing "…", on grapheme boundaries. Short
 * text comes back unchanged.
 */
export function cutGraphemes(s: string, max: number): string {
  const parts = [...graphemes.segment(s)].map((p) => p.segment);
  if (parts.length <= max) return s;
  return max <= 0 ? "" : `${parts.slice(0, max - 1).join("")}…`;
}

/** A row's state, by the spec §10.2 precedence (the first one is the winner). Each has a word and an icon. */
export const ROW_STATE_ORDER = [
  "adding",
  "checking",
  "missing",
  "unusable",
  "refused",
  "check_failed",
  "update",
  "hidden",
  "cant_pin",
] as const;

export type RowState = (typeof ROW_STATE_ORDER)[number];

/** The one state a row shows when it holds several (spec §10.2). */
export function rowStateOf(states: readonly RowState[]): RowState | undefined {
  return ROW_STATE_ORDER.find((s) => states.includes(s));
}

// Request bodies (spec §9.2). Field messages are the server's short forms (spec §10.4).

const folderPath = z.string().refine(isHostPathShape, MSG.hostPathStart);
const repoField = z.string().refine((r) => normalizeRepo(r) !== null, MSG.repoFormat);
const subpathField = z.string().refine((p) => normalizeSubpath(p) !== null, MSG.subpathNotFolder);
const branchField = z.string().refine(checkBranchName, MSG.branchMissing);
const skillNames = z.array(hostSkillSchema).min(1);

/** `POST /api/library/sources/preview`. */
export const skillSourcePreviewBodySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("folder"), path: folderPath }),
  z.object({
    kind: z.literal("github"),
    repo: repoField,
    subpath: subpathField.optional(),
    branch: branchField.optional(),
  }),
]);

/** `POST /api/library/sources`: a folder source, or a GitHub source from an earlier preview. */
export const skillSourceAddBodySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("folder"), path: folderPath, skills: skillNames }),
  z.object({ kind: z.literal("github"), previewId: z.string().min(1), skills: skillNames }),
]);

// Responses (spec §9.1).

export const skillStateSchema = z.enum(["ok", "missing", "hidden", "unusable"]);

export const usedBySchema = z.object({
  templates: z.number().int().nonnegative(),
  agents: z.number().int().nonnegative(),
});

export const skillRowSchema = z.object({
  name: z.string(),
  description: z.string(),
  state: skillStateSchema,
  stateDetail: z.string().optional(),
  /** A GitHub skill whose cache holds no code yet: the page offers Fetch again. */
  fetchAgain: z.boolean().optional(),
  usedBy: usedBySchema,
});

/** A source group's summary: what the source is, its pin and how many skills it holds. */
export const sourceSummarySchema = z.object({
  id: z.string(),
  kind: z.enum(["folder", "github"]),
  path: z.string().nullable(),
  repo: z.string().nullable(),
  subpath: z.string().nullable(),
  branch: z.string().nullable(),
  pin: z.string().nullable(),
  state: z.enum(["adding", "ready"]),
  skillCount: z.number().int().nonnegative(),
  /** When a GitHub add started (ISO), while the source is "adding"; null otherwise. */
  since: z.string().nullable(),
  /** A check is queued or running; `since` is when it was queued (ISO). In memory on the server. */
  checking: z.object({ since: z.string() }).nullable(),
  /** The last check found a newer commit. */
  update: z.boolean(),
  /** The last check couldn't reach the source. */
  checkFailed: z.boolean(),
});

/** One group of `GET /api/library/skills`. `group` is the URL form: `host`, `source:<id>`, `template:<name>`, `unknown`. */
export const skillGroupSchema = z.discriminatedUnion("kind", [
  z.object({ group: z.string(), kind: z.literal("host"), skills: z.array(skillRowSchema) }),
  z.object({
    group: z.string(),
    kind: z.literal("source"),
    source: sourceSummarySchema,
    skills: z.array(skillRowSchema),
  }),
  z.object({
    group: z.string(),
    kind: z.literal("template"),
    template: z.string(),
    skills: z.array(skillRowSchema),
  }),
  z.object({ group: z.string(), kind: z.literal("unknown"), skills: z.array(skillRowSchema) }),
]);

export const skillGroupsResponseSchema = z.object({
  /** The host Claude folder (`FACTORY_HOST_CLAUDE_DIR`), not its `skills` folder: the page appends `/skills`. */
  hostDir: z.string(),
  groups: z.array(skillGroupSchema),
});

export type SkillGroupsResponse = z.infer<typeof skillGroupsResponseSchema>;

/** One command hook a skill's frontmatter declares: `matcher` is "" when it has none. */
const hookDeclSchema = z.object({ event: z.string(), matcher: z.string(), command: z.string() });

const SKILL_MD_BYTES = 256 * 1024;

export const skillFileEntrySchema = z.object({ path: z.string(), executable: z.boolean() });

/** `GET /api/library/skills/:group/:name`: one skill, its files (executables marked) and SKILL.md. */
export const skillDetailSchema = skillRowSchema.extend({
  group: z.string(),
  files: z.array(skillFileEntrySchema).max(2000),
  /** The command hooks its frontmatter declares (spec R12). */
  hooks: z.array(hookDeclSchema),
  /** Who uses it, by template: the template, and how many of its agents list the skill ("dev · 190 agents"). */
  usedByTemplates: z.array(z.object({ name: z.string(), agents: z.number().int().nonnegative() })),
  skillMd: z
    .string()
    .refine((s) => new TextEncoder().encode(s).length <= SKILL_MD_BYTES, MSG.skillMdSize),
  /** `skillMd` was cut at 256 KB. */
  skillMdCut: z.boolean(),
});

/** `GET /api/library/skills/:group/:name/file?path=`'s query. */
export const skillFileQuerySchema = z.object({ path: z.string().min(1) });

/** One text file of a skill. */
export const skillFileTextSchema = z.object({ path: z.string(), text: z.string() });

/** A source, its picked skills, update info, check error and users (a count each of templates and agents). */
export const sourceDetailSchema = z.object({
  id: z.string(),
  kind: z.enum(["folder", "github"]),
  path: z.string().nullable(),
  repo: z.string().nullable(),
  subpath: z.string().nullable(),
  branch: z.string().nullable(),
  pin: z.string().nullable(),
  committedAt: z.string().nullable(),
  subject: z.string().nullable(),
  state: z.enum(["adding", "ready"]),
  skills: z.array(z.string()),
  updateCommit: z.string().nullable(),
  updateAt: z.string().nullable(),
  updateSubject: z.string().nullable(),
  checkedAt: z.string().nullable(),
  checkError: z.string().nullable(),
  usedBy: usedBySchema,
});

/** A skill a preview or Find more skills found, and why it can't be picked (spec §9.2). */
export const foundSkillSchema = z.object({
  name: z.string(),
  description: z.string(),
  pickable: z.boolean(),
  reason: z.enum(["taken", "unusable", "link"]).optional(),
  /** With reason "taken": "Host" or the source's label. */
  takenBy: z.string().optional(),
  /** With reason "unusable". */
  detail: z.string().optional(),
});

/** `POST /api/library/sources/preview` and `POST …/:id/find`. */
export const sourcePreviewSchema = z.object({
  previewId: z.string().optional(),
  commit: z.string().optional(),
  committedAt: z.string().optional(),
  subject: z.string().optional(),
  branch: z.string().optional(),
  found: z.array(foundSkillSchema),
});

export const skillNamesBodySchema = z.object({ skills: skillNames });

/** `POST …/:id/update`: the commit the last check found. */
export const sourceUpdateBodySchema = z.object({ commit: z.string().min(1) });

/** `DELETE /api/library/sources/:id`: the Undo window's end (ISO). */
export const sourceRemovedSchema = z.object({ undoUntil: z.string() });

/** The update view of a source whose check found a newer commit (spec §6.3): what moving a GitHub source to the commit its check found would change. */
export const sourceUpdateViewSchema = z.object({
  from: z.string(),
  to: z.string(),
  committedAt: z.string().nullable(),
  subject: z.string().nullable(),
  compareUrl: z.string().url().optional(),
  changed: z.array(
    z.object({
      name: z.string(),
      runsCodeChanged: z.boolean(),
      hooks: z.object({ added: z.array(hookDeclSchema), removed: z.array(hookDeclSchema) }),
      execFiles: z.array(z.string()),
    }),
  ),
  removed: z.array(z.string()),
  added: z.array(z.string()),
  unusable: z.array(z.object({ name: z.string(), detail: z.string() })),
});

/** `GET /api/library/sources/:id`: the detail, with the update view when a check found a newer commit. */
export const sourceViewSchema = sourceDetailSchema.extend({
  update: sourceUpdateViewSchema.nullable(),
});

// Marketplaces and plugins (spec §9.1, §9.3).

const gitUrlField = z.string().refine(checkGitUrl, "Use an https git URL.");
const pinRefField = z.string().refine(checkPinRef, "Use a commit or a tag.");

/** `POST /api/library/marketplaces/preview`: a GitHub repo, a git URL or a host folder. */
export const marketplacePreviewBodySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("github"), repo: repoField }),
  z.object({ kind: z.literal("git"), url: gitUrlField }),
  z.object({ kind: z.literal("directory"), path: folderPath }),
]);

/** `POST /api/library/marketplaces`: an earlier preview. */
export const marketplaceAddBodySchema = z.object({ previewId: z.string().min(1) });

/** `POST …/marketplaces/:name/update`: the commit the last check found. */
export const marketplaceUpdateBodySchema = z.object({ commit: z.string().min(1) });

/** `POST …/marketplaces/:name/fetch`: a 40-hex commit or a tag Skills hasn't read. */
export const marketplaceFetchBodySchema = z.object({ ref: pinRefField });

/** `POST /api/library/plugins/:key/diff`: two commits (or recorded tags) of the plugin's marketplace. */
export const pluginDiffBodySchema = z.object({ from: pinRefField, to: pinRefField });

/** `POST /api/library/plugins/:key/read`: the commit whose external source is fetched. */
export const pluginReadBodySchema = z.object({ commit: pinRefField.optional() });

/** `GET /api/library/plugins/:key` and `…/file`: a commit (default the Library's), or the host's copy. */
export const pluginReadQuerySchema = z.object({
  commit: pinRefField.optional(),
  from: z.literal("host").optional(),
});

export const pluginFileQuerySchema = pluginReadQuerySchema.extend({ path: z.string().min(1) });

export const pluginKeyParamsSchema = z.object({
  key: z.string().regex(PLUGIN_REF_PATTERN, "Not a plugin key."),
});

export const marketplaceNameParamsSchema = z.object({
  name: z.string().regex(MARKETPLACE_PATTERN, "Not a marketplace name."),
});

export const marketplaceSourceSchema = z.discriminatedUnion("source", [
  z.object({ source: z.literal("github"), repo: z.string() }),
  z.object({ source: z.literal("git"), url: z.string() }),
  z.object({ source: z.literal("directory"), path: z.string() }),
]);

export const previewPluginSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  version: z.string().optional(),
  pinnable: z.boolean(),
  /** "refused" is a source Open Factory won't install ("Can't use"); "cant_pin" follows its own source (spec §10.2). */
  state: z.enum(["ok", "refused", "cant_pin"]),
  refusedReason: z.string().optional(),
});

/** `POST /api/library/marketplaces/preview`. */
export const marketplacePreviewSchema = z.object({
  previewId: z.string(),
  name: z.string(),
  source: marketplaceSourceSchema,
  commit: z.string().nullable(),
  committedAt: z.string().nullable(),
  subject: z.string().nullable(),
  branch: z.string().nullable(),
  commitPinnable: z.boolean(),
  plugins: z.array(previewPluginSchema),
});

/** A registry row (spec §7.1) with its update info and users (counts). */
export const marketplaceDetailSchema = z.object({
  name: z.string(),
  source: marketplaceSourceSchema,
  branch: z.string().nullable(),
  commit: z.string().nullable(),
  committedAt: z.string().nullable(),
  subject: z.string().nullable(),
  tags: z.record(z.string(), z.string()),
  state: z.enum(["adding", "ready"]),
  updateCommit: z.string().nullable(),
  updateAt: z.string().nullable(),
  updateSubject: z.string().nullable(),
  checkedAt: z.string().nullable(),
  checkError: z.string().nullable(),
  usedBy: usedBySchema,
  /** When an add started (ISO), while the row is "adding" (spec §10.2); the web shows the elapsed time from it. */
  since: z.string().nullable(),
  /** A check is queued or running; `since` is when it was queued (ISO), as for a skill source. */
  checking: z.object({ since: z.string() }).nullable(),
});

/** What moving a marketplace's Library commit would change (spec §7.1). */
export const marketplaceUpdateViewSchema = z.object({
  from: z.string(),
  to: z.string(),
  committedAt: z.string().nullable(),
  subject: z.string().nullable(),
  changed: z.array(
    z.object({
      name: z.string(),
      what: z.array(z.enum(["version", "source", "tree"])),
      runsCodeChanged: z.boolean(),
    }),
  ),
  removed: z.array(z.string()),
  added: z.array(z.string()),
});

/** `GET /api/library/marketplaces/:name`: the row, and the update view once a check found a newer commit. */
export const marketplaceViewSchema = marketplaceDetailSchema.extend({
  update: marketplaceUpdateViewSchema.nullable(),
});

export const marketplaceFetchedSchema = z.object({ sha: z.string() });

// Plugin contents (spec §7.8). Mirrors `readContents` in the server.

export const pluginHookRowSchema = z.object({
  event: z.string(),
  matcher: z.string(),
  type: z.string(),
  command: z.string(),
  timeout: z.number().nullable(),
});

export const pluginMcpRowSchema = z.object({
  name: z.string(),
  kind: z.string(),
  command: z.string().nullable(),
  args: z.array(z.string()),
  env: z.array(z.object({ name: z.string(), value: z.string().nullable() })),
  url: z.string().nullable(),
  headers: z.array(z.string()),
});

export const pluginCodePartSchema = z.object({
  kind: z.enum(["lsp", "statusLine", "monitors", "bin", "node"]),
  items: z.array(z.string()),
});

export const contentsSummarySchema = z.object({
  hooks: z.number().int().nonnegative(),
  mcp: z.number().int().nonnegative(),
  codeParts: z.number().int().nonnegative(),
  dependencies: z.number().int().nonnegative(),
  skills: z.number().int().nonnegative(),
  commands: z.number().int().nonnegative(),
  agents: z.number().int().nonnegative(),
  outputStyles: z.number().int().nonnegative(),
  needs: z.number().int().nonnegative(),
  unshown: z.number().int().nonnegative(),
});

export const pluginContentsSchema = z.object({
  manifest: z.object({
    name: z.string().nullable(),
    version: z.string().nullable(),
    description: z.string().nullable(),
    author: z.string().nullable(),
    homepage: z.string().nullable(),
    repository: z.string().nullable(),
  }),
  hooks: z.array(pluginHookRowSchema),
  mcp: z.array(pluginMcpRowSchema),
  dependencies: z.array(z.string()),
  codeParts: z.array(pluginCodePartSchema),
  needs: z.array(z.string()),
  provides: z.object({
    skills: z.array(z.string()),
    commands: z.array(z.string()),
    agents: z.array(z.string()),
    outputStyles: z.array(z.string()),
  }),
  unshown: z.array(z.string()),
  files: z.array(z.string()),
  summary: contentsSummarySchema,
});

const change = <T extends z.ZodType>(t: T) => z.object({ added: z.array(t), removed: z.array(t) });

export const contentsDiffSchema = z.object({
  hooks: change(pluginHookRowSchema),
  mcp: change(pluginMcpRowSchema),
  commands: change(z.string()),
  dependencies: change(z.string()),
  codeParts: change(pluginCodePartSchema),
  needs: change(z.string()),
  runsCode: z.boolean(),
});

/** A plugin's row state, a subset of the spec §10.2 states that apply to a catalog entry. */
export const pluginStateSchema = z.enum(["ok", "missing", "refused", "cant_pin"]);

/** Who uses a plugin and at which pin (`commit:<sha>`, `tag:<name>`, `latest` or `live`). */
export const pluginUsersSchema = z.object({
  templates: z.array(z.object({ name: z.string(), pin: z.string(), agents: z.number().int() })),
  /** Agents that enable it through their own overlay; it runs at their template's pin. */
  overlays: z.array(z.object({ agent: z.string(), template: z.string(), pin: z.string() })),
});

/** One catalog entry at the Library's commit (spec §9.1). */
export const pluginEntrySchema = z.object({
  key: z.string(),
  name: z.string(),
  description: z.string().optional(),
  version: z.string().optional(),
  pinnable: z.boolean(),
  refusedReason: z.string().optional(),
  state: pluginStateSchema,
  /** Null when the contents aren't readable here: an external source not fetched yet, or an unusable one. */
  contentsSummary: contentsSummarySchema.nullable(),
  /** An external `sha` source whose contents aren't read yet: the peek offers Read contents. */
  canRead: z.boolean(),
  usedBy: pluginUsersSchema,
});

/** A plugin installed on the host whose marketplace isn't registered (spec §7.6). */
export const hostPluginEntrySchema = z.object({
  key: z.string(),
  name: z.string(),
  marketplace: z.string(),
  version: z.string().nullable(),
  lastUpdated: z.string().nullable(),
  contentsSummary: contentsSummarySchema.nullable(),
  /** "Can't show: outside the host's plugin folder." and the like. */
  cantShow: z.string().optional(),
  /** "The host's record for acme can't be used: …": Add its marketplace is refused. */
  addRefusedReason: z.string().optional(),
});

/** `GET /api/library/plugins`. */
export const pluginsResponseSchema = z.object({
  marketplaces: z.array(
    z.object({
      name: z.string(),
      commit: z.string().nullable(),
      state: z.enum(["adding", "ready"]),
      /** When an add started (ISO), while the marketplace is "adding". */
      since: z.string().nullable(),
      plugins: z.array(pluginEntrySchema),
    }),
  ),
  host: z.array(hostPluginEntrySchema),
});

/** `GET /api/library/marketplaces`: each row with its plugins and users. */
export const marketplacesResponseSchema = z.object({
  marketplaces: z.array(
    marketplaceDetailSchema.extend({
      plugins: z.array(pluginEntrySchema),
      users: z.object({ templates: z.array(z.string()), agents: z.array(z.string()) }),
    }),
  ),
});

/** `GET /api/library/plugins/:key`: the full contents and provenance at one commit, or the host's copy. */
export const pluginDetailSchema = z.object({
  key: z.string(),
  name: z.string(),
  marketplace: z.string(),
  from: z.enum(["library", "host"]),
  /** The commit read; null for a live folder and for the host's copy. */
  commit: z.string().nullable(),
  version: z.string().nullable(),
  description: z.string().nullable(),
  pinnable: z.boolean(),
  refusedReason: z.string().optional(),
  state: pluginStateSchema,
  /** Where the code comes from: a path in the marketplace, or an external source (secrets-free). */
  source: z.object({
    kind: z.enum(["relative", "external", "refused", "host"]),
    detail: z.string(),
  }),
  contents: pluginContentsSchema.nullable(),
  /** Why there are no contents: "Contents not read yet", "Can't show: …". */
  contentsNote: z.string().nullable(),
  canRead: z.boolean(),
  /** "Also on this host (1.2.0)": the host's installed version of the same key. */
  hostVersion: z.string().nullable(),
  usedBy: pluginUsersSchema,
});

const diffSide = z.object({
  commit: z.string(),
  present: z.boolean(),
  version: z.string().nullable(),
  /** Parts that couldn't be read, which the diff can't show. */
  unshown: z.array(z.string()),
});

/** `POST /api/library/plugins/:key/diff`. */
export const pluginDiffSchema = z.object({
  key: z.string(),
  from: diffSide,
  to: diffSide,
  diff: contentsDiffSchema,
});

/** `GET /api/library/plugins/:key/file`. */
export const pluginFileTextSchema = z.object({ path: z.string(), text: z.string() });
