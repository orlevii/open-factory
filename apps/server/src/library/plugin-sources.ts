/**
 * Plugin sources in a marketplace catalog (spec §7.4, §7.5, §7.7): which entries a pin can hold, which are
 * refused, and the read-only checkout of an external `sha` source. Everything git runs through the hardened
 * `runGit` (spec §6.2); nothing here runs Claude Code.
 */
import { createHash, randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";
import { checkGitUrl, normalizeRepo, normalizeSubpath } from "@open-factory/shared";
import { GitError } from "./git.ts";
import { checkoutSize, fetchCommit, installCheckout, removeTree, repoUrl } from "./git-fetch.ts";

const SHA = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const CHECKOUT_CAP_BYTES = 50 * 1024 * 1024;

/** An external plugin source of a catalog entry. `sha` (`sha256` for an archive) is what holds it to one version. */
export type ExternalSource =
  | { source: "github"; repo: string; sha?: string }
  | { source: "url"; url: string; sha?: string }
  | { source: "git-subdir"; url: string; path: string; sha?: string }
  | { source: "archive"; url: string; sha256?: string };

export type PluginSourceInfo =
  | { kind: "relative"; path: string }
  | { kind: "external"; source: ExternalSource; pinnable: boolean }
  /** `label` is the source kind the message names ("npm", "command", "headersHelper", …). */
  | { kind: "refused"; label: string };

const refused = (label: string): PluginSourceInfo => ({ kind: "refused", label });
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** A source value that git could read as an option, or that carries a control character, is never passed on. */
const safeArg = (v: string) =>
  v !== "" && !v.startsWith("-") && [...v].every((c) => c.charCodeAt(0) > 0x1f && c !== "\x7f");

/**
 * Classifies a catalog entry's `source` (spec §7.4, §7.7). A relative path is held by a marketplace pin; an
 * external source is held only with a `sha` (an archive with a `sha256`); `npm`, `command`, `headersHelper` and
 * an archive without `sha256` are refused.
 */
export function classifyPluginSource(entry: Record<string, unknown>): PluginSourceInfo {
  const src = entry.source;
  if (JSON.stringify(entry).includes('"headersHelper"')) return refused("headersHelper");
  if (typeof src === "string") {
    if (!src.startsWith("./")) return refused("unknown");
    const rel = normalizeSubpath(src.slice(2));
    return rel === null ? refused("path") : { kind: "relative", path: rel };
  }
  if (!isRecord(src)) return refused("unknown");
  const kind = str(src.source);
  const sha = str(src.sha);
  const held = sha !== undefined && SHA.test(sha);
  switch (kind) {
    case "github": {
      const repo = str(src.repo);
      if (!repo || !safeArg(repo) || !normalizeRepo(repo)) return refused("github");
      return {
        kind: "external",
        source: { source: "github", repo, ...(sha ? { sha } : {}) },
        pinnable: held,
      };
    }
    case "url": {
      const url = str(src.url);
      if (!url || !gitUrlOk(url)) return refused("url");
      return {
        kind: "external",
        source: { source: "url", url, ...(sha ? { sha } : {}) },
        pinnable: held,
      };
    }
    case "git-subdir": {
      const url = str(src.url);
      const sub = normalizeSubpath(str(src.path) ?? "");
      if (!url || !gitUrlOk(url) || sub === null || sub === "" || !safeArg(sub)) {
        return refused("git-subdir");
      }
      return {
        kind: "external",
        source: { source: "git-subdir", url, path: sub, ...(sha ? { sha } : {}) },
        pinnable: held,
      };
    }
    case "archive": {
      const url = str(src.url);
      const sha256 = str(src.sha256);
      if (!url || !sha256 || !SHA256.test(sha256)) return refused("archive");
      return { kind: "external", source: { source: "archive", url, sha256 }, pinnable: true };
    }
    default:
      return refused(kind && safeArg(kind) ? kind : "unknown");
  }
}

/** A git URL a source may name: `owner/repo` (read from the GitHub base) or an https URL without userinfo, `?` or `#`. */
function gitUrlOk(u: string): boolean {
  return safeArg(u) && (normalizeRepo(u) !== null || checkGitUrl(u));
}

function gitUrlOf(value: string, githubUrl: string): string {
  const norm = normalizeRepo(value);
  return norm ? repoUrl(githubUrl, norm) : value;
}

export interface PluginSourceOptions {
  factoryHome: string;
  /** `FACTORY_GITHUB_URL`. */
  githubUrl: string;
  gitBin?: string;
  signal?: AbortSignal;
}

export const pluginSourcesRoot = (factoryHome: string) =>
  path.join(factoryHome, "state", "library", "plugin-sources");

/**
 * The read-only checkout of an external `git` source at `sha`, `state/library/plugin-sources/<hash>/<sha>/`
 * (spec §7.5). Fetched once; a second call returns the same directory. Refuses userinfo, `?`, `#` and any
 * argument that starts with a dash; an archive isn't fetched (git can't read one).
 */
export async function readPluginSource(
  src: ExternalSource,
  sha: string,
  o: PluginSourceOptions,
): Promise<string> {
  if (!SHA.test(sha)) throw new GitError("git failed: invalid commit.", "");
  if (src.source === "archive") throw new Error("Open Factory doesn't fetch archives.");
  const value = src.source === "github" ? src.repo : src.url;
  const subpath = src.source === "git-subdir" ? src.path : "";
  if (!gitUrlOk(value) || (subpath !== "" && !safeArg(subpath))) {
    throw new GitError("git failed: invalid source.", "");
  }
  const sub = normalizeSubpath(subpath);
  if (sub === null) throw new GitError("git failed: invalid source.", "");
  const url = gitUrlOf(value, o.githubUrl);
  const hash = createHash("sha256").update(`${url}\0${sub}`).digest("hex").slice(0, 32);
  const dest = path.join(pluginSourcesRoot(o.factoryHome), hash, sha);
  if ((await stat(dest).catch(() => undefined))?.isDirectory()) return dest;

  const tmp = path.join(o.factoryHome, "state", "library", "preview", `plugin-${randomUUID()}`);
  try {
    await fetchCommit(url, sha, tmp, {
      allowFile: o.githubUrl.startsWith("file:"),
      gitBin: o.gitBin,
      signal: o.signal,
      label: value,
    });
    await checkoutSize(tmp, CHECKOUT_CAP_BYTES).catch((e) => {
      throw e instanceof Error && e.message === "over_cap"
        ? new Error("This plugin source is larger than 50 MB.")
        : e;
    });
    try {
      await installCheckout(tmp, sub, dest);
    } catch (e) {
      // A concurrent read of the same source won the rename.
      if (!(await stat(dest).catch(() => undefined))?.isDirectory()) throw e;
    }
  } finally {
    await removeTree(tmp).catch(() => {});
  }
  return dest;
}
