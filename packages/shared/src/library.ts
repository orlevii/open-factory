import { z } from "zod";
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

/**
 * Official names Claude reserves for Anthropic's own sources. Each is allowed only with its matching
 * source; any other source is refused (spec §5.1).
 */
export const OFFICIAL_MARKETPLACES: Record<string, { source: "github"; repo: string }> = {
  "claude-plugins-official": { source: "github", repo: "anthropics/claude-plugins-official" },
};

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
  "installing",
  "checking",
  "add_failed",
  "install_failed",
  "missing",
  "unusable",
  "check_failed",
  "update",
  "hidden",
  "not_pinned",
  "not_installed",
] as const;

export type RowState = (typeof ROW_STATE_ORDER)[number];

/** The one state a row shows when it holds several (spec §10.2). */
export function rowStateOf(states: readonly RowState[]): RowState | undefined {
  return ROW_STATE_ORDER.find((s) => states.includes(s));
}

// Request bodies (spec §9.2). Field messages are the server's short forms (spec §10.4).

const folderPath = z.string().min(1).refine(isHostPathShape, MSG.hostPathStart);
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
  hostDir: z.string(),
  groups: z.array(skillGroupSchema),
});

const SKILL_MD_BYTES = 256 * 1024;

/** `GET /api/library/skills/:group/:name`: one skill, its files (executables marked) and SKILL.md. */
export const skillDetailSchema = skillRowSchema.extend({
  group: z.string(),
  files: z.array(z.object({ path: z.string(), executable: z.boolean() })).max(2000),
  skillMd: z.string().refine((s) => new TextEncoder().encode(s).length <= SKILL_MD_BYTES),
});

/** `GET /api/library/sources/:id`: the source, its picked skills, update info, check error and users. */
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
