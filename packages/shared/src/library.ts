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

/** `name@marketplace`: a plugin name of at most 64 characters, then a marketplace name. The one plugin-ref pattern. */
export const PLUGIN_REF_PATTERN = /^[A-Za-z0-9._-]{1,64}@[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

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
