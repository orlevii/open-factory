/**
 * The marketplace registry (spec §7.1, §7.4, §7.5, §9.3, §9.4): preview, add, check, update, fetch at a ref,
 * remove and Undo, with one read-only checkout per commit under `state/library/marketplaces/<name>/<sha>/`.
 * Writes run under `libraryLock`; slow fetches run outside it. A marketplace update moves only the Library's
 * commit: it never calls the config change flow and restarts no agent (spec §8.3). Nothing runs Claude Code.
 */
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, readlink, rename } from "node:fs/promises";
import path from "node:path";
import { type Db, type MarketplaceRow, schema } from "@open-factory/db";
import {
  acceptedPins,
  checkBranchName,
  checkGitUrl,
  cutGraphemes,
  MARKETPLACE_PATTERN,
  MSG,
  normalizeRepo,
  OFFICIAL_MARKETPLACES,
  RESERVED_MARKETPLACES,
} from "@open-factory/shared";
import { eq } from "drizzle-orm";
import { ApiError, FieldError } from "../errors.ts";
import { resolveHostFolder } from "../host-path.ts";

import {
  CHECKOUT_CAP_BYTES,
  COMMIT_PATTERN,
  checkErrorText,
  isDir,
  isRecord,
  META_KEEP_MS,
  SUBJECT_MAX,
  sha256,
  tagSha,
  touchDir,
  UNDO_MS,
  usersLine,
} from "./common.ts";
import { checkSkillFolder, type ForbiddenContext } from "./forbidden.ts";
import { GitError, runGit } from "./git.ts";
import {
  CommitMismatchError,
  checkoutSize,
  fetchCommit,
  type GitFetchOptions,
  installCheckout,
  removeTree,
  repoUrl,
  resolveRef,
} from "./git-fetch.ts";
import { LIBRARY_KEY, libraryLock } from "./locks.ts";
import { CODE_KEYS, CODE_PATHS } from "./plugin-contents.ts";
import { hasRangedDependency, readManifestUnder } from "./plugin-settings.ts";
import { classifyPluginSource } from "./plugin-sources.ts";

export const MARKETPLACE_MSG = {
  badName: "Marketplace name isn't allowed.",
  reservedName: "That marketplace name is reserved.",
  nameTaken: "A marketplace with that name exists.",
  previewExpired: "Preview expired. Add the marketplace again.",
  noCatalog: "This source has no marketplace catalog.",
  catalogLarge: "The catalog is larger than 1 MB.",
  catalogInvalid: "The catalog isn't valid JSON.",
  overSize: "Marketplace is over 50 MB.",
  otherCommit: "The repo returned another commit.",
  noUpdate: "Check for updates again.",
  stillAdding: "This marketplace is still being added.",
  undoOver: "Undo is over.",
  addFailed: "Couldn't add this marketplace.",
  checkFailed: "Couldn't check for updates.",
  gitUrl: "Use an https git URL.",
  pinBranch: (name: string) => `Pin ${name} to a commit or a tag.`,
  noTag: (name: string, ref: string) => `${name} has no commit or tag ${ref}.`,
  liveOnly: "A local folder is read live.",
  unpinnable: "Can't be pinned: it follows its own source.",
  rangedDependency:
    "Can't be pinned: a dependency names a version range, which Claude Code resolves to the newest matching tag.",
  refusedSource: (plugin: string, mkt: string, kind: string) =>
    `Plugin ${plugin}@${mkt} uses a ${kind} source, which Open Factory doesn't install.`,
} as const;

const CATALOG_MAX_BYTES = 1024 * 1024;
const FILE_WALK_CAP = 2000;

export type MarketplaceSource = MarketplaceRow["source"];
export type MarketplaceBody =
  | { kind: "github"; repo: string }
  | { kind: "git"; url: string }
  | { kind: "directory"; path: string };

export interface PreviewPlugin {
  name: string;
  description?: string;
  version?: string;
  /** Whether a marketplace pin holds this plugin (spec §7.4). */
  pinnable: boolean;
  /** "refused" for a source Open Factory won't install, "cant_pin" for one that follows its own source (spec §10.2). */
  state: "ok" | "refused" | "cant_pin";
  /** Why it can't be pinned, or why Open Factory won't install it (spec §7.4, §7.7). */
  refusedReason?: string;
}

export interface MarketplacePreview {
  previewId: string;
  name: string;
  source: MarketplaceSource;
  /** Null for a folder, which is read live. */
  commit: string | null;
  committedAt: string | null;
  subject: string | null;
  branch: string | null;
  /** False when Claude Code refuses a commit `ref` for this name (the official marketplace, G1). */
  commitPinnable: boolean;
  plugins: PreviewPlugin[];
}

export interface MarketplaceDetail {
  name: string;
  source: MarketplaceSource;
  branch: string | null;
  commit: string | null;
  committedAt: string | null;
  subject: string | null;
  tags: Record<string, string>;
  state: "adding" | "ready";
  updateCommit: string | null;
  updateAt: string | null;
  updateSubject: string | null;
  checkedAt: string | null;
  checkError: string | null;
  usedBy: { templates: number; agents: number };
  /** When the add started (ISO), while the row is "adding"; null otherwise. */
  since: string | null;
  /** When the queued or running check was queued (ISO); null when no check is pending. */
  checking: { since: string } | null;
}

export interface MarketplaceUpdateView {
  from: string;
  to: string;
  committedAt: string | null;
  subject: string | null;
  /** Plugins whose catalog entry or relative tree changed; the ones that run code differently come first. */
  changed: Array<{
    name: string;
    /** What changed: the catalog `version` or `source`, or the files of a relative plugin. */
    what: Array<"version" | "source" | "tree">;
    runsCodeChanged: boolean;
  }>;
  removed: string[];
  added: string[];
}

/** The database reads and writes of marketplaces, behind a seam so the rules run without Postgres. */
export interface MarketplacesStore {
  /** Every row, soft-deleted ones included, oldest first. */
  all(): Promise<MarketplaceRow[]>;
  insert(row: MarketplaceRow): Promise<void>;
  update(name: string, patch: Partial<MarketplaceRow>): Promise<MarketplaceRow | undefined>;
  delete(name: string): Promise<void>;
}

export function dbMarketplacesStore(db: Db): MarketplacesStore {
  return {
    all: async () =>
      (await db.select().from(schema.marketplaces)).sort(
        (a, b) => a.addedAt.getTime() - b.addedAt.getTime(),
      ),
    insert: async (row) => {
      await db.insert(schema.marketplaces).values(row);
    },
    update: async (name, patch) =>
      (
        await db
          .update(schema.marketplaces)
          .set(patch)
          .where(eq(schema.marketplaces.name, name))
          .returning()
      )[0],
    delete: async (name) => {
      await db.delete(schema.marketplaces).where(eq(schema.marketplaces.name, name));
    },
  };
}

export interface MarketplacesDeps {
  store: MarketplacesStore;
  /** Templates and agents that declare the marketplace or enable one of its plugins. */
  usedBy(name: string): Promise<{ templates: string[]; agents: string[] }>;
  /** Directories the loaded runtimes' `started.library` reference; a stale row's checkouts under them are kept. */
  inUse?: () => string[] | Promise<string[]>;
  /** Every pin a declaration holds: a commit, a tag, or null for Latest. Purge keeps these checkouts. */
  declaredRefs?: () => Promise<Array<{ marketplace: string; ref: string | null }>>;
  factoryHome: string;
  /** For `resolveHostFolder`; defaults to `os.homedir()`. */
  home?: string;
  forbidden: ForbiddenContext;
  /** `FACTORY_GITHUB_URL`. */
  githubUrl: string;
  now?: () => Date;
  gitBin?: string;
  undoMs?: number;
  /** The `library_changed` WS frame (spec §9.5); `addFailed` names a background add that failed. */
  publish?: (e?: { addFailed?: string }) => void;
  /** Starts a one-shot purge after `ms` (the sweep's, §9.4). */
  purgeAfter?: (ms: number) => void;
  log: (message: string, err: unknown) => void;
  /** Files read per plugin before a tree comparison fails closed; defaults to 2000. */
  fileWalkCap?: number;
}

interface PreviewMeta {
  name: string;
  source: MarketplaceSource;
  /** The fetch url (git, github); undefined for a folder. */
  url?: string;
  branch: string | null;
  commit: string | null;
  committedAt: string | null;
  subject: string | null;
  tags: Record<string, string>;
  at: number;
}

// Catalog ---------------------------------------------------------------------------------

export interface CatalogEntry {
  name: string;
  raw: Record<string, unknown>;
}

/** A catalog plugin name is a segment of a plugin key and of `--settings`, so only the key's own characters pass. */
const CATALOG_PLUGIN_NAME = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * Reads `.claude-plugin/marketplace.json` from a directory: `lstat`, a regular file, at most 1 MB. An entry whose name
 * isn't a valid plugin name is left out: third-party text never reaches a key, a route or a `--settings` entry.
 */
export async function readCatalog(dir: string): Promise<{ name: string; plugins: CatalogEntry[] }> {
  const file = path.join(dir, ".claude-plugin", "marketplace.json");
  const st = await lstat(file).catch(() => undefined);
  if (!st?.isFile()) throw new ApiError(400, "no_catalog", MARKETPLACE_MSG.noCatalog);
  if (st.size > CATALOG_MAX_BYTES) {
    throw new ApiError(400, "catalog_too_large", MARKETPLACE_MSG.catalogLarge);
  }
  let doc: unknown;
  try {
    doc = JSON.parse(await readFile(file, "utf8"));
  } catch {
    throw new ApiError(400, "bad_catalog", MARKETPLACE_MSG.catalogInvalid);
  }
  if (!isRecord(doc) || typeof doc.name !== "string" || !Array.isArray(doc.plugins)) {
    throw new ApiError(400, "bad_catalog", MARKETPLACE_MSG.catalogInvalid);
  }
  const plugins: CatalogEntry[] = [];
  for (const p of doc.plugins) {
    if (isRecord(p) && typeof p.name === "string" && CATALOG_PLUGIN_NAME.test(p.name))
      plugins.push({ name: p.name, raw: p });
  }
  return { name: doc.name, plugins };
}

/** A directory's content digest (names, modes, bytes, link targets), without `.git`; `capped` when the walk stopped. */
async function treeDigest(dir: string, cap: number): Promise<{ digest: string; capped: boolean }> {
  const h = createHash("sha256");
  let walked = 0;
  let capped = false;
  const walk = async (d: string, rel: string): Promise<void> => {
    const entries = await readdir(d, { withFileTypes: true }).catch(() => []);
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (e.name === ".git") continue;
      if (walked >= cap) {
        capped = true;
        return;
      }
      walked++;
      const p = path.join(d, e.name);
      const r = `${rel}/${e.name}`;
      const st = await lstat(p);
      if (st.isDirectory()) {
        h.update(`d ${r}\n`);
        await walk(p, r);
      } else if (st.isSymbolicLink()) {
        h.update(`l ${r} ${await readlink(p)}\n`);
      } else {
        h.update(`f ${r} ${st.mode & 0o111 ? "x" : "-"} ${sha256(await readFile(p))}\n`);
      }
    }
  };
  if (await isDir(dir)) await walk(dir, "");
  else h.update("missing");
  return { digest: h.digest("hex"), capped };
}

/** What makes a plugin run code (spec §7.1): its hooks, servers, monitors, `bin/` and Node dependencies. */
async function codeDigest(
  dir: string,
  entry: Record<string, unknown>,
  cap: number,
): Promise<{ digest: string; capped: boolean }> {
  const h = createHash("sha256");
  let capped = false;
  for (const p of CODE_PATHS) {
    const full = path.join(dir, p);
    const st = await lstat(full).catch(() => undefined);
    if (!st) continue;
    if (st.isDirectory()) {
      const t = await treeDigest(full, cap);
      capped ||= t.capped;
      h.update(`${p} ${t.digest}\n`);
    } else h.update(`${p} ${st.isFile() ? sha256(await readFile(full)) : "link"}\n`);
  }
  const manifest = await readFile(path.join(dir, ".claude-plugin", "plugin.json"), "utf8")
    .then((t) => JSON.parse(t) as unknown)
    .catch(() => undefined);
  for (const src of [manifest, entry]) {
    if (!isRecord(src)) continue;
    for (const k of CODE_KEYS) if (k in src) h.update(`${k} ${JSON.stringify(src[k])}\n`);
  }
  return { digest: h.digest("hex"), capped };
}

/**
 * One catalog entry as the preview and the Plugins view show it (spec §7.4, §7.7): pinnable, or why not.
 * `ranged` is whether the plugin's manifest has a dependency with a version range (false when it isn't readable).
 */
export function previewPluginOf(
  marketplace: string,
  e: CatalogEntry,
  ranged = false,
): PreviewPlugin {
  const info = classifyPluginSource(e.raw);
  const base = {
    name: e.name,
    ...(typeof e.raw.description === "string"
      ? { description: cutGraphemes(e.raw.description, SUBJECT_MAX) }
      : {}),
    ...(typeof e.raw.version === "string" ? { version: e.raw.version } : {}),
  };
  if (info.kind === "refused") {
    return {
      ...base,
      pinnable: false,
      state: "refused",
      refusedReason: MARKETPLACE_MSG.refusedSource(e.name, marketplace, info.label),
    };
  }
  if (info.kind === "external" && !info.pinnable) {
    return {
      ...base,
      pinnable: false,
      state: "cant_pin",
      refusedReason: MARKETPLACE_MSG.unpinnable,
    };
  }
  if (ranged) {
    return {
      ...base,
      pinnable: false,
      state: "cant_pin",
      refusedReason: MARKETPLACE_MSG.rangedDependency,
    };
  }
  return { ...base, pinnable: true, state: "ok" };
}

// Service ---------------------------------------------------------------------------------

export class MarketplacesService {
  private readonly previews = new Map<string, PreviewMeta>();
  private readonly pending = new Set<Promise<unknown>>();
  /** Names whose check is queued or running, with when it was queued (ISO). In memory only. */
  private readonly checking = new Map<string, string>();
  private readonly now: () => Date;
  private readonly undoMs: number;

  constructor(private readonly d: MarketplacesDeps) {
    this.now = d.now ?? (() => new Date());
    this.undoMs = d.undoMs ?? UNDO_MS;
  }

  // Paths ---------------------------------------------------------------------------------

  get previewRoot(): string {
    return path.join(this.d.factoryHome, "state", "library", "preview");
  }

  get root(): string {
    return path.join(this.d.factoryHome, "state", "library", "marketplaces");
  }

  private checkoutDir(name: string, commit: string): string {
    return path.join(this.root, name, commit);
  }

  private fetchOpts(label: string, signal?: AbortSignal): GitFetchOptions {
    return {
      allowFile: this.d.githubUrl.startsWith("file:"),
      gitBin: this.d.gitBin,
      label,
      signal,
    };
  }

  private urlOf(source: MarketplaceSource): string {
    if (source.source === "git") return source.url;
    if (source.source === "github") {
      const norm = normalizeRepo(source.repo) as { owner: string; repo: string };
      return repoUrl(this.d.githubUrl, norm);
    }
    throw new ApiError(409, "not_git", MARKETPLACE_MSG.liveOnly);
  }

  private labelOf(source: MarketplaceSource): string {
    return source.source === "github"
      ? source.repo
      : source.source === "git"
        ? source.url
        : source.path;
  }

  /** Resolves when the background work (adds that re-fetch) has finished. */
  async idle(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }

  private background(fn: () => Promise<void>): void {
    const p = fn()
      .catch((e) => this.d.log("marketplace background work failed", e))
      .finally(() => this.pending.delete(p));
    this.pending.add(p);
  }

  // Reads ---------------------------------------------------------------------------------

  /** Every row, soft-deleted included (for the sweep). */
  rows(): Promise<MarketplaceRow[]> {
    return this.d.store.all();
  }

  private async get(name: string, o: { deleted?: boolean } = {}): Promise<MarketplaceRow> {
    const row = (await this.d.store.all()).find((r) => r.name === name);
    if (!row || (row.deletedAt !== null) !== (o.deleted ?? false)) {
      throw new ApiError(404, "not_found", "Not found");
    }
    return row;
  }

  private async detail(row: MarketplaceRow): Promise<MarketplaceDetail> {
    const users = await this.d.usedBy(row.name);
    const iso = (v: Date | null) => (v ? v.toISOString() : null);
    const checking = this.checkingSince(row.name);
    return {
      name: row.name,
      source: row.source,
      branch: row.branch,
      commit: row.commit,
      committedAt: iso(row.committedAt),
      subject: row.subject,
      tags: row.tags,
      state: row.state,
      updateCommit: row.updateCommit,
      updateAt: iso(row.updateAt),
      updateSubject: row.updateSubject,
      checkedAt: iso(row.checkedAt),
      checkError: row.checkError,
      usedBy: { templates: users.templates.length, agents: users.agents.length },
      since: row.state === "adding" ? iso(row.startedAt) : null,
      checking: checking ? { since: checking } : null,
    };
  }

  /** When a check was queued for the marketplace (ISO), while one is queued or running; the list shows it as "Checking…". */
  checkingSince(name: string): string | undefined {
    return this.checking.get(name);
  }

  async detailOf(name: string): Promise<MarketplaceDetail> {
    return this.detail(await this.get(name));
  }

  /**
   * The read-only directory of a marketplace at `commit` (default: the Library's commit; a recorded tag
   * resolves through `tags`), the folder itself for a directory marketplace, or null when Skills hasn't read it.
   */
  async checkout(name: string, commit?: string): Promise<string | null> {
    if (!MARKETPLACE_PATTERN.test(name)) return null;
    const row = (await this.d.store.all()).find((r) => r.name === name && r.deletedAt === null);
    if (row?.state !== "ready") return null;
    if (row.source.source === "directory") return row.source.path;
    const ref = commit ?? row.commit;
    if (!ref) return null;
    const sha = COMMIT_PATTERN.test(ref) ? ref : tagSha(row.tags, ref);
    if (!sha || !COMMIT_PATTERN.test(sha)) return null;
    const dir = this.checkoutDir(name, sha);
    return (await isDir(dir)) ? dir : null;
  }

  // Preview -------------------------------------------------------------------------------

  async preview(b: MarketplaceBody): Promise<MarketplacePreview> {
    return b.kind === "directory" ? this.previewDirectory(b.path) : this.previewGit(b);
  }

  private async checkName(name: string, source: MarketplaceSource, rows: MarketplaceRow[]) {
    if (!MARKETPLACE_PATTERN.test(name) || RESERVED_MARKETPLACES.includes(name)) {
      throw new ApiError(400, "bad_name", MARKETPLACE_MSG.badName);
    }
    const official = OFFICIAL_MARKETPLACES[name];
    if (
      official &&
      !(source.source === "github" && source.repo.toLowerCase() === official.repo.toLowerCase())
    ) {
      throw new ApiError(400, "reserved_name", MARKETPLACE_MSG.reservedName);
    }
    const now = this.now().getTime();
    const taken = rows.find(
      (r) => r.name === name && (r.deletedAt === null || r.deletedAt.getTime() + this.undoMs > now),
    );
    if (taken) throw new ApiError(409, "name_taken", MARKETPLACE_MSG.nameTaken);
  }

  /** The preview rows of a checkout at `dir`; a relative plugin with a ranged dependency can't be pinned. */
  private pluginsOf(name: string, entries: CatalogEntry[], dir: string): Promise<PreviewPlugin[]> {
    return Promise.all(
      entries.map(async (e) => {
        const info = classifyPluginSource(e.raw);
        const manifest =
          info.kind === "relative" ? await readManifestUnder(dir, info.path) : undefined;
        return previewPluginOf(name, e, hasRangedDependency(manifest));
      }),
    );
  }

  private commitPinnable(name: string): boolean {
    return acceptedPins(name).includes("commit");
  }

  private async previewDirectory(input: string): Promise<MarketplacePreview> {
    const real = await resolveHostFolder("path", input, this.d.home);
    await checkSkillFolder(real, this.d.forbidden);
    const catalog = await readCatalog(real);
    const source: MarketplaceSource = { source: "directory", path: real };
    await this.checkName(catalog.name, source, await this.d.store.all());
    const previewId = randomUUID();
    this.previews.set(previewId, {
      name: catalog.name,
      source,
      branch: null,
      commit: null,
      committedAt: null,
      subject: null,
      tags: {},
      at: this.now().getTime(),
    });
    return {
      previewId,
      name: catalog.name,
      source,
      commit: null,
      committedAt: null,
      subject: null,
      branch: null,
      commitPinnable: this.commitPinnable(catalog.name),
      plugins: await this.pluginsOf(catalog.name, catalog.plugins, real),
    };
  }

  private async previewGit(
    b: Exclude<MarketplaceBody, { kind: "directory" }>,
  ): Promise<MarketplacePreview> {
    let source: MarketplaceSource;
    if (b.kind === "github") {
      const norm = normalizeRepo(b.repo);
      if (!norm) throw new FieldError("repo", MSG.repoFormat);
      source = { source: "github", repo: `${norm.owner}/${norm.repo}` };
    } else {
      if (!checkGitUrl(b.url)) throw new FieldError("url", MARKETPLACE_MSG.gitUrl);
      source = { source: "git", url: b.url };
    }
    const url = this.urlOf(source);
    const o = this.fetchOpts(this.labelOf(source));
    const previewId = randomUUID();
    const dir = path.join(this.previewRoot, previewId);
    try {
      const ref = await resolveRef(url, null, o);
      const log = await fetchCommit(url, ref.sha, dir, o);
      await this.checkSize(dir);
      const catalog = await readCatalog(dir);
      await this.checkName(catalog.name, source, await this.d.store.all());
      const subject = cutGraphemes(log.subject, SUBJECT_MAX);
      const tags = await this.tagsAt(url, ref.sha);
      this.previews.set(previewId, {
        name: catalog.name,
        source,
        url,
        branch: ref.branch,
        commit: ref.sha,
        committedAt: log.committedAt,
        subject,
        tags,
        at: this.now().getTime(),
      });
      return {
        previewId,
        name: catalog.name,
        source,
        commit: ref.sha,
        committedAt: log.committedAt,
        subject,
        branch: ref.branch,
        commitPinnable: this.commitPinnable(catalog.name),
        plugins: await this.pluginsOf(catalog.name, catalog.plugins, dir),
      };
    } catch (e) {
      await removeTree(dir).catch(() => {});
      throw this.fieldFor(e, b.kind === "github" ? "repo" : "url");
    }
  }

  /** Git failures reach the human as the one repo field message, but a commit mismatch and the rest pass through. */
  private fieldFor(e: unknown, field: string): unknown {
    if (e instanceof CommitMismatchError) {
      return new ApiError(400, "commit_mismatch", MARKETPLACE_MSG.otherCommit);
    }
    return e instanceof GitError ? new FieldError(field, MSG.repoUnreachable) : e;
  }

  private async checkSize(dir: string): Promise<void> {
    try {
      await checkoutSize(dir, CHECKOUT_CAP_BYTES);
    } catch (e) {
      if (e instanceof Error && e.message === "over_cap") {
        throw new ApiError(400, "too_large", MARKETPLACE_MSG.overSize);
      }
      throw e;
    }
  }

  // Tags (spec §7.4) ----------------------------------------------------------------------

  private async lsRemote(url: string, patterns: string[]): Promise<Map<string, string>> {
    const { stdout } = await runGit(["ls-remote", url, ...patterns], {
      allowFile: this.d.githubUrl.startsWith("file:"),
      gitBin: this.d.gitBin,
    });
    const out = new Map<string, string>();
    for (const line of stdout.split("\n")) {
      const [sha, ref] = line.split("\t");
      if (!sha || !ref || !COMMIT_PATTERN.test(sha)) continue;
      // The peeled line (`^{}`) is the commit an annotated tag points at, so it wins.
      if (ref.endsWith("^{}") || !out.has(ref)) out.set(ref, sha);
    }
    return out;
  }

  /** `{ [tag]: sha }` of the remote's tags that point at `sha` (an annotated tag resolves through `^{}`). */
  private async tagsAt(url: string, sha: string): Promise<Record<string, string>> {
    const refs = await this.lsRemote(url, ["refs/tags/*"]);
    const peeled = new Map<string, string>();
    for (const [ref, s] of refs) {
      const name = ref.slice("refs/tags/".length).replace(/\^\{\}$/, "");
      if (ref.endsWith("^{}") || !peeled.has(name)) peeled.set(name, s);
    }
    return Object.fromEntries(
      [...peeled].filter(([name, s]) => s === sha && checkBranchName(name)),
    );
  }

  // Add -----------------------------------------------------------------------------------

  async add(
    previewId: string,
    by: string,
  ): Promise<{ status: 201 | 202; marketplace: MarketplaceDetail }> {
    const meta = this.previews.get(previewId);
    if (!meta) throw new FieldError("previewId", MARKETPLACE_MSG.previewExpired);
    const dir = path.join(this.previewRoot, previewId);
    const done = await libraryLock.run(LIBRARY_KEY, async () => {
      if (this.previews.get(previewId) !== meta) {
        throw new FieldError("previewId", MARKETPLACE_MSG.previewExpired);
      }
      const rows = await this.d.store.all();
      await this.checkName(meta.name, meta.source, rows);
      // A row past its Undo window that no purge has reached yet still holds the primary key.
      const stale = rows.find((r) => r.name === meta.name);
      if (stale) await this.dropRow(stale);
      const now = this.now();
      const live = meta.commit === null;
      const adding = !live && !(await isDir(dir));
      const row = this.newRow(meta, by, now, adding ? "adding" : "ready");
      if (!live && !adding) {
        const dest = this.checkoutDir(meta.name, meta.commit as string);
        if (!(await isDir(dest))) await installCheckout(dir, "", dest);
      }
      await this.d.store.insert(row);
      this.previews.delete(previewId);
      if (!adding) await removeTree(dir).catch(() => {});
      return {
        status: adding ? (202 as const) : (201 as const),
        marketplace: await this.detail(row),
      };
    });
    if (done.status === 202) this.background(() => this.finishAdding(meta.name));
    this.d.publish?.();
    return done;
  }

  private newRow(m: PreviewMeta, by: string, now: Date, state: "adding" | "ready"): MarketplaceRow {
    return {
      name: m.name,
      source: m.source,
      branch: m.branch,
      commit: m.commit,
      committedAt: m.committedAt ? new Date(m.committedAt) : null,
      subject: m.subject,
      updateCommit: null,
      updateAt: null,
      updateSubject: null,
      checkedAt: null,
      checkError: null,
      tags: m.tags,
      state,
      startedAt: now,
      addedBy: by,
      addedAt: now,
      deletedAt: null,
    };
  }

  /** Fetches the pinned commit of an "adding" row and marks it ready; a failure removes the row and tells the web. */
  private async finishAdding(name: string): Promise<void> {
    const row = await this.get(name).catch(() => undefined);
    if (row?.state !== "adding" || row.commit === null) return;
    const tmp = path.join(this.previewRoot, `add-${randomUUID()}`);
    let failed = false;
    try {
      await fetchCommit(
        this.urlOf(row.source),
        row.commit,
        tmp,
        this.fetchOpts(this.labelOf(row.source)),
      );
      await this.checkSize(tmp);
      await readCatalog(tmp);
      await libraryLock.run(LIBRARY_KEY, async () => {
        if ((await this.get(name).catch(() => undefined))?.state !== "adding") return;
        const dest = this.checkoutDir(name, row.commit as string);
        if (!(await isDir(dest))) await installCheckout(tmp, "", dest);
        await this.d.store.update(name, { state: "ready" });
      });
    } catch (e) {
      this.d.log(`adding marketplace ${name} failed`, e);
      await libraryLock.run(LIBRARY_KEY, async () => {
        // Only a row still "adding" is ours to remove.
        if ((await this.get(name).catch(() => undefined))?.state !== "adding") return;
        await this.d.store.delete(name);
        failed = true;
        await removeTree(path.join(this.root, name)).catch(() => {});
      });
    } finally {
      await removeTree(tmp).catch(() => {});
    }
    this.d.publish?.(failed ? { addFailed: name } : undefined);
  }

  /** Removes a row past its window; its checkouts stay when a loaded runtime still references them (the sweep retries). */
  private async dropRow(row: MarketplaceRow): Promise<void> {
    await this.d.store.delete(row.name);
    const dir = path.join(this.root, row.name);
    const held = (await this.d.inUse?.()) ?? [];
    if (held.some((p) => p === dir || p.startsWith(dir + path.sep))) {
      for (const sha of await readdir(dir).catch(() => [] as string[])) {
        const sub = path.join(dir, sha);
        if (held.some((p) => p === sub || p.startsWith(sub + path.sep))) continue;
        await removeTree(sub).catch(() => {});
      }
      return;
    }
    await removeTree(dir).catch(() => {});
  }

  // Check ---------------------------------------------------------------------------------

  /** The staged copy of an update commit, fetched if it isn't there (or was swept). */
  private async updatePreview(row: MarketplaceRow, commit: string): Promise<string> {
    const final = path.join(this.previewRoot, `upd-mkt-${row.name}-${commit}`);
    if (await isDir(final)) {
      await touchDir(final);
      return final;
    }
    const tmp = `${final}.tmp-${randomUUID()}`;
    try {
      await fetchCommit(
        this.urlOf(row.source),
        commit,
        tmp,
        this.fetchOpts(this.labelOf(row.source)),
      );
      await this.checkSize(tmp);
      await readCatalog(tmp);
      await mkdir(path.dirname(final), { recursive: true });
      await rename(tmp, final).catch(async () => {
        if (!(await isDir(final))) throw new Error("preview rename failed");
      });
    } finally {
      await removeTree(tmp).catch(() => {});
    }
    return final;
  }

  private async logOf(co: string): Promise<{ committedAt: string; subject: string }> {
    const { stdout } = await runGit(["log", "-1", "--format=%cI%x00%s"], {
      cwd: co,
      allowFile: false,
      gitBin: this.d.gitBin,
    });
    const [committedAt = "", subject = ""] = stdout.replace(/\n$/, "").split("\0");
    return { committedAt, subject };
  }

  /** One marketplace's check: marks it checking unless a queued check already owns the mark. */
  async check(name: string): Promise<MarketplaceDetail> {
    const owns = !this.checking.has(name);
    if (owns) {
      this.checking.set(name, this.now().toISOString());
      this.d.publish?.();
    }
    let row: MarketplaceRow;
    try {
      row = await this.runCheck(name);
    } finally {
      if (owns) this.checking.delete(name);
      this.d.publish?.();
    }
    return this.detail(row);
  }

  /** ls-remote on the recorded branch; a newer commit is fetched into a preview; tags are recorded. */
  private async runCheck(name: string): Promise<MarketplaceRow> {
    const row = await this.get(name);
    if (row.source.source === "directory" || row.state !== "ready") return row;
    let patch: Partial<MarketplaceRow>;
    try {
      const url = this.urlOf(row.source);
      const ref = await resolveRef(url, row.branch, this.fetchOpts(this.labelOf(row.source)));
      const tags = { ...row.tags, ...(await this.tagsAt(url, ref.sha)) };
      if (ref.sha === row.commit) {
        patch = { updateCommit: null, updateAt: null, updateSubject: null, tags };
      } else {
        const co = await this.updatePreview(row, ref.sha);
        const meta = await this.logOf(co);
        patch = {
          updateCommit: ref.sha,
          updateAt: new Date(meta.committedAt),
          updateSubject: cutGraphemes(meta.subject, SUBJECT_MAX),
          tags,
        };
      }
      patch = { ...patch, checkError: null };
    } catch (e) {
      patch = { checkError: checkErrorText(e, MARKETPLACE_MSG.checkFailed) };
    }
    const next = await libraryLock.run(LIBRARY_KEY, async () => {
      const cur = (await this.d.store.all()).find((r) => r.name === name);
      // Gone, or an update moved the commit while we fetched: the result is for another commit.
      if (!cur || cur.deletedAt !== null || cur.commit !== row.commit) return cur;
      return this.d.store.update(name, { ...patch, checkedAt: this.now() });
    });
    return next ?? row;
  }

  /** Check for updates over every git or GitHub marketplace, 4 at a time, in the background (`idle()` waits). */
  async startCheckAll(): Promise<void> {
    const queue = (await this.d.store.all())
      .filter(
        (r) =>
          r.deletedAt === null &&
          r.state === "ready" &&
          r.source.source !== "directory" &&
          !this.checking.has(r.name),
      )
      .map((r) => r.name);
    const names = [...queue];
    const since = this.now().toISOString();
    for (const n of names) this.checking.set(n, since);
    const worker = async () => {
      for (let n = queue.shift(); n !== undefined; n = queue.shift()) {
        try {
          await this.check(n);
        } catch (e) {
          // The row keeps its last result.
          this.d.log(`checking marketplace ${n} failed`, e);
        }
      }
    };
    try {
      this.background(async () => {
        try {
          await Promise.all(Array.from({ length: Math.min(4, queue.length) }, worker));
        } finally {
          for (const n of names) this.checking.delete(n);
        }
      });
    } catch (e) {
      for (const n of names) this.checking.delete(n);
      throw e;
    }
  }

  // Update --------------------------------------------------------------------------------

  async updateView(name: string): Promise<MarketplaceUpdateView> {
    const row = await this.get(name);
    if (row.source.source === "directory" || !row.updateCommit || !row.commit) {
      throw new ApiError(409, "no_update", MARKETPLACE_MSG.noUpdate);
    }
    const oldDir = this.checkoutDir(name, row.commit);
    const newDir = await this.updatePreview(row, row.updateCommit);
    const oldCat = (await isDir(oldDir)) ? await readCatalog(oldDir) : { name, plugins: [] };
    const newCat = await readCatalog(newDir);
    const cap = this.d.fileWalkCap ?? FILE_WALK_CAP;
    const oldBy = new Map(oldCat.plugins.map((p) => [p.name, p.raw]));
    const newBy = new Map(newCat.plugins.map((p) => [p.name, p.raw]));
    const changed: MarketplaceUpdateView["changed"] = [];
    for (const [pname, now] of newBy) {
      const was = oldBy.get(pname);
      if (!was) continue;
      const what: Array<"version" | "source" | "tree"> = [];
      if (JSON.stringify(was.version ?? null) !== JSON.stringify(now.version ?? null))
        what.push("version");
      if (JSON.stringify(was.source) !== JSON.stringify(now.source)) what.push("source");
      const a = classifyPluginSource(was);
      const b = classifyPluginSource(now);
      let runs = false;
      if (b.kind === "relative") {
        const oldPath = a.kind === "relative" ? path.join(oldDir, a.path) : undefined;
        const t = await treeDigest(path.join(newDir, b.path), cap);
        const before = oldPath ? await treeDigest(oldPath, cap) : undefined;
        if (!before || before.digest !== t.digest || t.capped) what.push("tree");
        if (what.includes("tree") || what.includes("source")) {
          const after = await codeDigest(path.join(newDir, b.path), now, cap);
          const prior = oldPath ? await codeDigest(oldPath, was, cap) : undefined;
          // Past the cap some files weren't read, so "nothing new runs" can't be claimed.
          runs = !prior || prior.digest !== after.digest || after.capped || t.capped;
        }
      } else if (what.includes("source")) {
        // An external source at another sha is code Skills hasn't read: assume it runs different code.
        runs = true;
      }
      if (what.length > 0) changed.push({ name: pname, what, runsCodeChanged: runs });
    }
    changed.sort(
      (x, y) =>
        Number(y.runsCodeChanged) - Number(x.runsCodeChanged) || x.name.localeCompare(y.name),
    );
    return {
      from: row.commit,
      to: row.updateCommit,
      committedAt: row.updateAt ? row.updateAt.toISOString() : null,
      subject: row.updateSubject,
      changed,
      removed: [...oldBy.keys()].filter((n) => !newBy.has(n)).sort(),
      added: [...newBy.keys()].filter((n) => !oldBy.has(n)).sort(),
    };
  }

  /** Moves the Library's commit to the one the last check found. No template pin changes and no agent restarts. */
  async update(name: string, commit: string, _by: string): Promise<MarketplaceDetail> {
    const first = await this.get(name);
    if (first.source.source === "directory" || first.updateCommit !== commit) {
      throw new ApiError(409, "stale_update", MARKETPLACE_MSG.noUpdate);
    }
    const co = await this.updatePreview(first, commit);
    // Git runs before the lock; the tags at this commit were recorded by the check that found it.
    const log = await this.logOf(co);
    const row = await libraryLock.run(LIBRARY_KEY, async () => {
      const cur = await this.get(name);
      if (cur.updateCommit !== commit) {
        throw new ApiError(409, "stale_update", MARKETPLACE_MSG.noUpdate);
      }
      const dest = this.checkoutDir(name, commit);
      if (!(await isDir(dest))) await installCheckout(co, "", dest);
      return (await this.d.store.update(name, {
        commit,
        committedAt: new Date(log.committedAt),
        subject: cutGraphemes(log.subject, SUBJECT_MAX),
        updateCommit: null,
        updateAt: null,
        updateSubject: null,
        checkError: null,
      })) as MarketplaceRow;
    });
    await removeTree(co).catch(() => {});
    this.d.publish?.();
    return this.detail(row);
  }

  // Fetch (spec §7.4) ---------------------------------------------------------------------

  /**
   * Reads a pinned commit or tag Skills hasn't read into its own checkout. A tag is recorded on the row;
   * a name that is a branch (and not a tag) is refused.
   */
  async fetchAt(name: string, ref: string): Promise<{ sha: string }> {
    const row = await this.get(name);
    if (row.source.source === "directory") {
      throw new ApiError(409, "not_git", MARKETPLACE_MSG.liveOnly);
    }
    if (row.state !== "ready") throw new ApiError(409, "adding", MARKETPLACE_MSG.stillAdding);
    const url = this.urlOf(row.source);
    let sha: string;
    let tag: string | undefined;
    if (COMMIT_PATTERN.test(ref)) sha = ref;
    else {
      if (!checkBranchName(ref)) throw new FieldError("ref", MARKETPLACE_MSG.pinBranch(name));
      const refs = await this.lsRemote(url, [
        `refs/tags/${ref}`,
        `refs/tags/${ref}^{}`,
        `refs/heads/${ref}`,
      ]).catch((e) => {
        throw this.fieldFor(e, "ref");
      });
      // ls-remote tail-matches, so only a line equal to the requested ref counts.
      const found = refs.get(`refs/tags/${ref}^{}`) ?? refs.get(`refs/tags/${ref}`);
      if (!found) {
        throw refs.has(`refs/heads/${ref}`)
          ? new ApiError(400, "pin_branch", MARKETPLACE_MSG.pinBranch(name), {
              fields: { ref: MARKETPLACE_MSG.pinBranch(name) },
            })
          : new ApiError(404, "no_ref", MARKETPLACE_MSG.noTag(name, ref));
      }
      sha = found;
      tag = ref;
    }
    const dest = this.checkoutDir(name, sha);
    // The checkout and its tag are made under one hold of the lock, so a purge can't remove it in between.
    const tmp = path.join(this.previewRoot, `fetch-${randomUUID()}`);
    let fetched = false;
    try {
      for (;;) {
        if (!fetched && !(await isDir(dest))) {
          await fetchCommit(url, sha, tmp, this.fetchOpts(this.labelOf(row.source))).catch((e) => {
            throw this.fieldFor(e, "ref");
          });
          await this.checkSize(tmp);
          await readCatalog(tmp);
          fetched = true;
        }
        const done = await libraryLock.run(LIBRARY_KEY, async () => {
          if (!(await isDir(dest))) {
            if (!fetched) return false;
            await installCheckout(tmp, "", dest);
          }
          const cur = (await this.d.store.all()).find(
            (r) => r.name === name && r.deletedAt === null,
          );
          if (cur && tag !== undefined) {
            await this.d.store.update(name, { tags: { ...cur.tags, [tag]: sha } });
          }
          return true;
        });
        if (done) break;
      }
    } finally {
      await removeTree(tmp).catch(() => {});
    }
    this.d.publish?.();
    return { sha };
  }

  // Remove and Undo -----------------------------------------------------------------------

  async remove(name: string): Promise<{ undoUntil: string }> {
    const undoUntil = await libraryLock.run(LIBRARY_KEY, async () => {
      await this.get(name);
      const users = await this.d.usedBy(name);
      if (users.templates.length + users.agents.length > 0) {
        throw new ApiError(
          409,
          "in_use",
          `Templates use plugins from ${name} (${usersLine(users.templates, users.agents)}). Remove them first.`,
          { templates: users.templates.slice(0, 3), agents: users.agents.slice(0, 3) },
        );
      }
      const now = this.now();
      await this.d.store.update(name, { deletedAt: now });
      return new Date(now.getTime() + this.undoMs).toISOString();
    });
    this.d.publish?.();
    this.d.purgeAfter?.(this.undoMs);
    return { undoUntil };
  }

  async restore(name: string, _by: string): Promise<MarketplaceDetail> {
    const row = await libraryLock.run(LIBRARY_KEY, async () => {
      const cur = await this.get(name, { deleted: true });
      const until = (cur.deletedAt as Date).getTime() + this.undoMs;
      if (this.now().getTime() >= until)
        throw new ApiError(409, "undo_over", MARKETPLACE_MSG.undoOver);
      return (await this.d.store.update(name, { deletedAt: null })) as MarketplaceRow;
    });
    this.d.publish?.();
    return this.detail(row);
  }

  // Purge (called by the sweep, under the Library lock) -----------------------------------

  /** Forgets preview metadata older than a day; the sweep removes the directories (spec §9.4). */
  dropOldPreviewMeta(): void {
    const cutoff = this.now().getTime() - META_KEEP_MS;
    for (const [k, m] of this.previews) if (m.at < cutoff) this.previews.delete(k);
  }

  /**
   * One purge pass, run by the sweep while it holds the Library lock: rows past their Undo window (all of them
   * at boot, which also removes a row still `adding`), then every checkout no row, declaration or loaded
   * runtime references. `inUse` are the directories the runtimes' `started.library` reference. Returns whether a row went.
   */
  async purgeLocked(o: { boot: boolean; inUse: string[] }): Promise<boolean> {
    const within = (dir: string, p: string) => p === dir || p.startsWith(dir + path.sep);
    const held = (dir: string) => o.inUse.some((p) => within(dir, p));
    const now = this.now().getTime();
    let any = false;
    for (const r of await this.d.store.all()) {
      const expired =
        r.deletedAt !== null && (o.boot || r.deletedAt.getTime() + this.undoMs <= now);
      const unfinished = o.boot && r.state === "adding";
      if (!expired && !unfinished) continue;
      const dir = path.join(this.root, r.name);
      if (held(dir)) continue;
      try {
        await removeTree(dir);
        await this.d.store.delete(r.name);
        any = true;
      } catch (e) {
        this.d.log(`purging marketplace ${r.name} failed`, e);
      }
    }
    const rows = new Map((await this.d.store.all()).map((r) => [r.name, r]));
    const declared = await this.d.declaredRefs?.();
    for (const name of await readdir(this.root).catch(() => [] as string[])) {
      const row = rows.get(name);
      const nameDir = path.join(this.root, name);
      if (!row) {
        if (!held(nameDir)) {
          await removeTree(nameDir).catch((e) =>
            this.d.log(`removing checkouts of ${name} failed`, e),
          );
        }
        continue;
      }
      const keep = new Set<string>();
      if (row.commit) keep.add(row.commit);
      for (const d of declared ?? []) {
        if (d.marketplace !== name || d.ref === null) continue;
        keep.add(COMMIT_PATTERN.test(d.ref) ? d.ref : (tagSha(row.tags, d.ref) ?? d.ref));
      }
      for (const sha of await readdir(nameDir).catch(() => [] as string[])) {
        const dir = path.join(nameDir, sha);
        if (keep.has(sha) || held(dir)) continue;
        await removeTree(dir).catch((e) =>
          this.d.log(`removing checkout ${name}/${sha} failed`, e),
        );
      }
    }
    return any;
  }
}
