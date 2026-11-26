/**
 * Skill sources: preview, add, find more, check, update, refetch, remove and Undo (spec §6.1, §6.3, §9.2,
 * §9.4). Writes run under `libraryLock`; slow fetches run outside it. `onLibraryChanged` (the config
 * change flow, §8.3) and `publish` (the `library_changed` frame, §9.5) run only after the lock is released.
 */
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rename } from "node:fs/promises";
import path from "node:path";
import { type Db, type SkillSourceRow, schema } from "@open-factory/db";
import {
  cutGraphemes,
  HOST_SKILL_PATTERN,
  MSG,
  normalizeRepo,
  normalizeSubpath,
  type skillSourceAddBodySchema,
  type skillSourcePreviewBodySchema,
  type sourceDetailSchema,
} from "@open-factory/shared";
import { eq } from "drizzle-orm";
import type { z } from "zod";
import { ApiError, FieldError } from "../errors.ts";
import { resolveHostFolder } from "../host-path.ts";
import {
  CHECKOUT_CAP_BYTES,
  checkErrorText,
  isDir,
  META_KEEP_MS,
  SUBJECT_MAX,
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
  joinRepoPath,
  removeTree,
  repoUrl,
  resolveRef,
  treeShas,
} from "./git-fetch.ts";
import { inspect } from "./library-index.ts";
import { LIBRARY_KEY, libraryLock } from "./locks.ts";
import { type HookDecl, readSkillMd } from "./skill-md.ts";

export type SkillSourcePreviewBody = z.infer<typeof skillSourcePreviewBodySchema>;
export type SkillSourceAddBody = z.infer<typeof skillSourceAddBodySchema>;
export type SourceDetail = z.infer<typeof sourceDetailSchema>;

export const SOURCE_MSG = {
  previewExpired: "Preview expired. Find skills again.",
  pickNotAllowed: "A chosen skill can't be added.",
  nameTaken: "A chosen skill's name was taken.",
  folderOverSize: "Folder is over 50 MB.",
  repoOtherCommit: "The repo returned another commit.",
  noCache: "Fetch this source again first.",
  noUpdate: "Check for updates again.",
  emptiesSource: "This update removes every skill you picked. Remove the source instead.",
  undoOver: "Undo is over.",
  checkFailed: "Couldn't check for updates.",
  addFailed: "Couldn't add this source.",
  pinMoved: "This source changed. Try again.",
} as const;

const CHECK_CONCURRENCY = 4;
const FILE_WALK_CAP = 2000;
const BAD_NAME = "Name has characters skills can't use.";

export interface FoundSkill {
  name: string;
  description: string;
  pickable: boolean;
  reason?: "taken" | "unusable" | "link";
  /** With reason "taken": "Host" or the source's label. */
  takenBy?: string;
  /** With reason "unusable". */
  detail?: string;
}

export interface SourcePreview {
  previewId?: string;
  commit?: string;
  committedAt?: string;
  subject?: string;
  branch?: string;
  found: FoundSkill[];
}

export interface UpdateView {
  from: string;
  to: string;
  committedAt: string | null;
  subject: string | null;
  /** Only when `FACTORY_GITHUB_URL` is the default. */
  compareUrl?: string;
  /** Picked skills whose tree changed; the ones that run code differently come first. */
  changed: Array<{
    name: string;
    runsCodeChanged: boolean;
    hooks: { added: HookDecl[]; removed: HookDecl[] };
    /** Executable files added or changed. */
    execFiles: string[];
  }>;
  /** Picked skills gone at the new commit. */
  removed: string[];
  /** New folders at the new commit; never picked automatically. */
  added: string[];
  /** Picked skills that can't be used at the new commit. */
  unusable: Array<{ name: string; detail: string }>;
}

/** The database reads and writes of sources, behind a seam so the rules run without Postgres. */
export interface SourcesStore {
  /** Every row, soft-deleted ones included, oldest first. */
  all(): Promise<SkillSourceRow[]>;
  insert(row: SkillSourceRow): Promise<void>;
  update(id: string, patch: Partial<SkillSourceRow>): Promise<SkillSourceRow | undefined>;
  delete(id: string): Promise<void>;
}

export function dbSourcesStore(db: Db): SourcesStore {
  return {
    all: async () =>
      (await db.select().from(schema.skillSources)).sort(
        (a, b) => a.addedAt.getTime() - b.addedAt.getTime(),
      ),
    insert: async (row) => {
      await db.insert(schema.skillSources).values(row);
    },
    update: async (id, patch) =>
      (
        await db
          .update(schema.skillSources)
          .set(patch)
          .where(eq(schema.skillSources.id, id))
          .returning()
      )[0],
    delete: async (id) => {
      await db.delete(schema.skillSources).where(eq(schema.skillSources.id, id));
    },
  };
}

export interface SourcesDeps {
  store: SourcesStore;
  /** Who lists any of the skills: template names and agent slugs (`LibraryIndex.usedByAny`). */
  usedByAny(names: string[]): Promise<{ templates: string[]; agents: string[] }>;
  factoryHome: string;
  hostClaudeDir: string;
  /** For `resolveHostFolder`; defaults to `os.homedir()`. */
  home?: string;
  forbidden: ForbiddenContext;
  /** `FACTORY_GITHUB_URL`. */
  githubUrl: string;
  now?: () => Date;
  gitBin?: string;
  undoMs?: number;
  /** The config change flow (spec §8.3, wired in A9). */
  onLibraryChanged?: (e: {
    skills?: string[];
    by: string;
    before?: { skills: Record<string, string> };
  }) => Promise<void>;
  /** What the Library resolves these names to now; taken before a mutation and handed back as `before`. */
  captureLibrary?: (skills: string[]) => Promise<{ skills: Record<string, string> }>;
  /** The `library_changed` WS frame (spec §9.5); `addFailed` is the repo of a background add that failed. */
  publish?: (e?: { addFailed?: string }) => void;
  /** Starts a one-shot purge after `ms` (the sweep's, §9.4). */
  purgeAfter?: (ms: number) => void;
  log: (message: string, err: unknown) => void;
  /** Files `updateView` reads per skill before it fails closed; defaults to 2000. */
  fileWalkCap?: number;
}

interface PreviewMeta {
  repo: string;
  subpath: string;
  branch: string;
  commit: string;
  committedAt: string;
  subject: string;
  found: FoundSkill[];
  at: number;
}

const DEFAULT_GITHUB = "https://github.com";

const sourceLabel = (s: SkillSourceRow) => (s.kind === "github" ? (s.repo ?? "") : (s.path ?? ""));
const hookKey = (h: HookDecl) => JSON.stringify([h.event, h.matcher, h.command]);

/** Who made a Library change: a human principal. */
export type Who = { id: string; handle: string };

/** Hooks and executable files (by content hash) of a skill folder: what makes an update run different code. */
async function codeSurface(
  dir: string,
  cap: number,
): Promise<{ hooks: HookDecl[]; exec: Map<string, string>; capped: boolean }> {
  const hooks = (await readSkillMd(dir))?.hooks ?? [];
  const exec = new Map<string, string>();
  let walked = 0;
  let capped = false;
  const walk = async (d: string): Promise<void> => {
    const entries = await readdir(d, { withFileTypes: true }).catch(() => []);
    // Sorted, so what a capped walk misses doesn't depend on the file system's order.
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (e.name === ".git") continue;
      if (walked >= cap) {
        capped = true;
        return;
      }
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) {
        walked++;
        if ((await lstat(p)).mode & 0o111) {
          exec.set(
            path.relative(dir, p),
            createHash("sha256")
              .update(await readFile(p))
              .digest("hex"),
          );
        }
      }
    }
  };
  await walk(dir);
  return { hooks, exec, capped };
}

interface Candidate {
  name: string;
  description: string;
  state: "ok" | "unusable" | "link";
  detail?: string;
}

/**
 * The skills a root offers (spec §6.1): the root itself when it holds a `SKILL.md` (named `oneName`),
 * otherwise each direct subfolder holding one. Links and unusable folders are listed, not pickable.
 */
async function candidates(root: string, oneName: string): Promise<Candidate[]> {
  const one = async (name: string, dir: string, link: boolean): Promise<Candidate> => {
    if (!HOST_SKILL_PATTERN.test(name)) {
      return { name, description: "", state: "unusable", detail: BAD_NAME };
    }
    if (link) return { name, description: "", state: "link" };
    const f = await inspect(name, dir);
    return {
      name,
      description: f.description,
      state: f.state === "ok" ? "ok" : "unusable",
      ...(f.detail ? { detail: f.detail } : {}),
    };
  };
  if (await readSkillMd(root)) return [await one(oneName, root, false)];
  const out: Candidate[] = [];
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (e.name === ".git" || !(e.isDirectory() || e.isSymbolicLink())) continue;
    const dir = path.join(root, e.name);
    if (!(await readSkillMd(dir))) continue;
    out.push(await one(e.name, dir, e.isSymbolicLink()));
  }
  return out;
}

export class SourcesService {
  private readonly previews = new Map<string, PreviewMeta>();
  private readonly pending = new Set<Promise<unknown>>();
  /** Sources a check is queued or running for, and when it was queued (in memory: a restart ends every check). */
  private readonly checking = new Map<string, Date>();
  private readonly now: () => Date;
  private readonly undoMs: number;

  constructor(private readonly d: SourcesDeps) {
    this.now = d.now ?? (() => new Date());
    this.undoMs = d.undoMs ?? UNDO_MS;
  }

  // Paths ---------------------------------------------------------------------------------

  get previewRoot(): string {
    return path.join(this.d.factoryHome, "state", "library", "preview");
  }

  get githubRoot(): string {
    return path.join(this.d.factoryHome, "state", "library", "github");
  }

  private cacheDir(id: string, commit: string): string {
    return path.join(this.githubRoot, id, commit);
  }

  private fetchOpts(label: string, signal?: AbortSignal): GitFetchOptions {
    return {
      allowFile: this.d.githubUrl.startsWith("file:"),
      gitBin: this.d.gitBin,
      label,
      signal,
    };
  }

  private urlOf(repo: string): string {
    const [owner = "", name = ""] = repo.split("/");
    return repoUrl(this.d.githubUrl, { owner, repo: name });
  }

  /** Resolves when the background work (GitHub adds that re-fetch) has finished. */
  async idle(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }

  private background(fn: () => Promise<void>): void {
    const p = fn()
      .catch((e) => this.d.log("skill source background work failed", e))
      .finally(() => this.pending.delete(p));
    this.pending.add(p);
  }

  /** The Library's resolution of `skills` before a mutation (spec §8.3); undefined when nothing listens. */
  private async capture(skills: string[]) {
    try {
      return await this.d.captureLibrary?.(skills);
    } catch (e) {
      this.d.log("capturing the library failed", e);
      return undefined;
    }
  }

  private async after(
    skills: string[] | undefined,
    by: Who | undefined,
    o?: { addFailed?: string },
    before?: { skills: Record<string, string> },
  ): Promise<void> {
    this.d.publish?.(o);
    if (skills === undefined || !by) return;
    try {
      await this.d.onLibraryChanged?.({
        skills,
        by: `@${by.handle}`,
        ...(before ? { before } : {}),
      });
    } catch (e) {
      this.d.log("libraryChanged failed", e);
    }
  }

  // Reads ---------------------------------------------------------------------------------

  /** Every row, soft-deleted included (for the sweep). */
  rows(): Promise<SkillSourceRow[]> {
    return this.d.store.all();
  }

  private async live(): Promise<SkillSourceRow[]> {
    return (await this.d.store.all()).filter((s) => s.deletedAt === null);
  }

  private async get(id: string, o: { deleted?: boolean } = {}): Promise<SkillSourceRow> {
    const row = (await this.d.store.all()).find((s) => s.id === id);
    if (!row || (row.deletedAt !== null) !== (o.deleted ?? false)) {
      throw new ApiError(404, "not_found", "Not found");
    }
    return row;
  }

  private async detail(row: SkillSourceRow): Promise<SourceDetail> {
    const users = await this.d.usedByAny(row.skills);
    const iso = (v: Date | null) => (v ? v.toISOString() : null);
    return {
      id: row.id,
      kind: row.kind,
      path: row.path,
      repo: row.repo,
      subpath: row.subpath,
      branch: row.branch,
      pin: row.commit,
      committedAt: iso(row.committedAt),
      subject: row.subject,
      state: row.state,
      skills: row.skills,
      updateCommit: row.updateCommit,
      updateAt: iso(row.updateAt),
      updateSubject: row.updateSubject,
      checkedAt: iso(row.checkedAt),
      checkError: row.checkError,
      usedBy: { templates: users.templates.length, agents: users.agents.length },
    };
  }

  async detailOf(id: string): Promise<SourceDetail> {
    return this.detail(await this.get(id));
  }

  /** Who holds `name` already: a live source's label, or "Host". `except` is a source to ignore. */
  private async takenBy(name: string, rows: SkillSourceRow[], except?: string) {
    for (const s of rows) if (s.id !== except && s.skills.includes(name)) return sourceLabel(s);
    const hostDir = path.join(this.d.hostClaudeDir, "skills", name);
    if (HOST_SKILL_PATTERN.test(name) && (await readSkillMd(hostDir))) return "Host";
    return undefined;
  }

  private async found(cands: Candidate[], rows: SkillSourceRow[], except?: string) {
    const out: FoundSkill[] = [];
    for (const c of cands) {
      const takenBy = await this.takenBy(c.name, rows, except);
      const base = { name: c.name, description: c.description };
      if (c.state === "link") out.push({ ...base, pickable: false, reason: "link" });
      else if (c.state === "unusable") {
        out.push({ ...base, pickable: false, reason: "unusable", detail: c.detail });
      } else if (takenBy) out.push({ ...base, pickable: false, reason: "taken", takenBy });
      else out.push({ ...base, pickable: true });
    }
    return out;
  }

  // Preview -------------------------------------------------------------------------------

  async preview(b: SkillSourcePreviewBody, _by: Who): Promise<SourcePreview> {
    return b.kind === "folder" ? this.previewFolder(b.path) : this.previewGithub(b);
  }

  private async checkedFolder(input: string): Promise<string> {
    const real = await resolveHostFolder("path", input, this.d.home);
    await checkSkillFolder(real, this.d.forbidden);
    return real;
  }

  private async previewFolder(input: string): Promise<SourcePreview> {
    const real = await this.checkedFolder(input);
    const found = await this.found(await candidates(real, path.basename(real)), await this.live());
    return { found };
  }

  private async previewGithub(
    b: Extract<SkillSourcePreviewBody, { kind: "github" }>,
  ): Promise<SourcePreview> {
    const norm = normalizeRepo(b.repo);
    const subpath = normalizeSubpath(b.subpath ?? "");
    if (!norm) throw new FieldError("repo", MSG.repoFormat);
    if (subpath === null) throw new FieldError("subpath", MSG.subpathNotFolder);
    const repo = `${norm.owner}/${norm.repo}`;
    const url = repoUrl(this.d.githubUrl, norm);
    const o = this.fetchOpts(repo);
    const previewId = randomUUID();
    const dir = path.join(this.previewRoot, previewId);
    try {
      const ref = await resolveRef(url, b.branch ?? null, o).catch((e) => {
        throw e instanceof GitError && b.branch !== undefined && e.message.startsWith("No branch")
          ? new FieldError("branch", MSG.branchMissing)
          : e;
      });
      const meta = await fetchCommit(url, ref.sha, dir, o);
      await this.checkCheckout(dir, subpath);
      const root = path.join(dir, subpath);
      const found = await this.found(
        await candidates(root, path.basename(subpath) || norm.repo),
        await this.live(),
      );
      this.previews.set(previewId, {
        repo,
        subpath,
        branch: ref.branch,
        commit: ref.sha,
        committedAt: meta.committedAt,
        subject: cutGraphemes(meta.subject, SUBJECT_MAX),
        found,
        at: this.now().getTime(),
      });
      return {
        previewId,
        commit: ref.sha,
        committedAt: meta.committedAt,
        subject: cutGraphemes(meta.subject, SUBJECT_MAX),
        branch: ref.branch,
        found,
      };
    } catch (e) {
      await removeTree(dir).catch(() => {});
      throw this.fieldFor(e);
    }
  }

  /**
   * Git failures reach the human as the one repo field message, except the two form-level outcomes of spec §10.4
   * (a commit mismatch; the size cap is `checkCheckout`'s); the rest pass through.
   */
  private fieldFor(e: unknown): unknown {
    if (e instanceof CommitMismatchError)
      return new ApiError(400, "commit_mismatch", SOURCE_MSG.repoOtherCommit);
    return e instanceof GitError ? new FieldError("repo", MSG.repoUnreachable) : e;
  }

  /** The checkout is within the size cap and holds the subpath as a real folder. */
  private async checkCheckout(dir: string, subpath: string): Promise<void> {
    try {
      await checkoutSize(dir, CHECKOUT_CAP_BYTES);
    } catch (e) {
      if (e instanceof Error && e.message === "over_cap") {
        throw new ApiError(400, "too_large", SOURCE_MSG.folderOverSize);
      }
      throw e;
    }
    const st = await lstat(path.join(dir, subpath)).catch(() => undefined);
    if (!st?.isDirectory()) throw new FieldError("subpath", MSG.subpathNotFolder);
  }

  // Add -----------------------------------------------------------------------------------

  async add(b: SkillSourceAddBody, by: Who): Promise<{ status: 201 | 202; source: SourceDetail }> {
    const out = await (b.kind === "folder" ? this.addFolder(b, by.id) : this.addGithub(b, by.id));
    await this.after(undefined, undefined);
    return out;
  }

  /** Every pick is pickable and free; the sources' rows are the ones the lock just read. */
  private async checkPicks(skills: string[], found: FoundSkill[], rows: SkillSourceRow[]) {
    for (const n of skills) {
      const f = found.find((x) => x.name === n);
      if (!f || (!f.pickable && f.reason !== "taken")) {
        throw new ApiError(400, "validation_error", SOURCE_MSG.pickNotAllowed, {
          fields: { skills: SOURCE_MSG.pickNotAllowed },
        });
      }
      if (await this.takenBy(n, rows)) {
        throw new ApiError(409, "name_taken", SOURCE_MSG.nameTaken);
      }
    }
  }

  private async addFolder(b: Extract<SkillSourceAddBody, { kind: "folder" }>, by: string) {
    return libraryLock.run(LIBRARY_KEY, async () => {
      const real = await this.checkedFolder(b.path);
      const rows = await this.live();
      const found = await this.found(await candidates(real, path.basename(real)), []);
      await this.checkPicks(b.skills, found, rows);
      const now = this.now();
      const row = this.newRow({ kind: "folder", path: real, skills: b.skills, by, now });
      await this.d.store.insert(row);
      return { status: 201 as const, source: await this.detail(row) };
    });
  }

  private newRow(o: {
    kind: "folder" | "github";
    skills: string[];
    by: string;
    now: Date;
    id?: string;
    path?: string;
    github?: PreviewMeta;
    trees?: Record<string, string>;
    state?: "adding" | "ready";
  }): SkillSourceRow {
    const g = o.github;
    return {
      id: o.id ?? randomUUID(),
      kind: o.kind,
      path: o.path ?? null,
      repo: g?.repo ?? null,
      subpath: g?.subpath ?? null,
      branch: g?.branch ?? null,
      commit: g?.commit ?? null,
      committedAt: g ? new Date(g.committedAt) : null,
      subject: g?.subject ?? null,
      trees: o.trees ?? null,
      updateCommit: null,
      updateAt: null,
      updateSubject: null,
      checkedAt: null,
      checkError: null,
      skills: [...o.skills].sort(),
      state: o.state ?? "ready",
      startedAt: o.now,
      addedById: o.by,
      addedAt: o.now,
      deletedAt: null,
    };
  }

  /**
   * `{ [skill]: tree sha }` for the picked skills of a checkout at `commit`. A skill git can't find fails
   * the call, or with `tolerateMissing` is left out (it isn't at this commit).
   */
  private async treesOf(
    co: string,
    commit: string,
    subpath: string,
    skills: string[],
    o: { tolerateMissing?: boolean } = {},
  ) {
    const one = (await readSkillMd(path.join(co, subpath))) !== null;
    const out: Record<string, string> = {};
    for (const n of skills) {
      const p = one ? subpath : joinRepoPath(subpath, n);
      try {
        out[n] = (await treeShas(co, commit, [p]))[p] as string;
      } catch (e) {
        if (!o.tolerateMissing) throw e;
      }
    }
    return out;
  }

  private async addGithub(b: Extract<SkillSourceAddBody, { kind: "github" }>, by: string) {
    const meta = this.previews.get(b.previewId);
    if (!meta) throw new FieldError("previewId", SOURCE_MSG.previewExpired);
    const dir = path.join(this.previewRoot, b.previewId);
    const id = randomUUID();
    const done = await libraryLock.run(LIBRARY_KEY, async () => {
      if (this.previews.get(b.previewId) !== meta) {
        throw new FieldError("previewId", SOURCE_MSG.previewExpired);
      }
      await this.checkPicks(b.skills, meta.found, await this.live());
      const now = this.now();
      if (await isDir(dir)) {
        const dest = this.cacheDir(id, meta.commit);
        await installCheckout(dir, meta.subpath, dest);
        const trees = await this.treesOf(dir, meta.commit, meta.subpath, b.skills);
        const row = this.newRow({
          kind: "github",
          github: meta,
          skills: b.skills,
          by,
          now,
          id,
          trees,
        });
        await this.d.store.insert(row);
        this.previews.delete(b.previewId);
        await removeTree(dir).catch(() => {});
        return { status: 201 as const, source: await this.detail(row) };
      }
      const row = this.newRow({
        kind: "github",
        github: meta,
        skills: b.skills,
        by,
        now,
        id,
        state: "adding",
      });
      await this.d.store.insert(row);
      this.previews.delete(b.previewId);
      return { status: 202 as const, source: await this.detail(row) };
    });
    if (done.status === 202) this.background(() => this.finishAdding(id));
    return done;
  }

  /** Fetches the pinned commit of an "adding" row, installs it and marks the row ready; a failure removes the row. */
  private async finishAdding(id: string): Promise<void> {
    const row = await this.get(id).catch(() => undefined);
    if (row?.state !== "adding" || row.commit === null) return;
    const subpath = row.subpath ?? "";
    const tmp = path.join(this.previewRoot, `add-${id}`);
    let failed = false;
    try {
      await fetchCommit(
        this.urlOf(row.repo ?? ""),
        row.commit,
        tmp,
        this.fetchOpts(row.repo ?? ""),
      );
      await this.checkCheckout(tmp, subpath);
      const trees = await this.treesOf(tmp, row.commit, subpath, row.skills);
      await libraryLock.run(LIBRARY_KEY, async () => {
        const now = await this.get(id).catch(() => undefined);
        if (now?.state !== "adding") return;
        await installCheckout(tmp, subpath, this.cacheDir(id, row.commit as string));
        await this.d.store.update(id, { state: "ready", trees });
      });
    } catch (e) {
      this.d.log(`adding ${row.repo} failed`, e);
      await libraryLock.run(LIBRARY_KEY, async () => {
        // Only a row still "adding" is ours to remove; it may have been removed or finished meanwhile.
        if ((await this.get(id).catch(() => undefined))?.state !== "adding") return;
        await this.d.store.delete(id);
        failed = true;
        await removeTree(path.join(this.githubRoot, id)).catch(() => {});
      });
    } finally {
      await removeTree(tmp).catch(() => {});
    }
    await this.after(undefined, undefined, failed ? { addFailed: row.repo ?? "" } : undefined);
  }

  /** Boot: finishes the GitHub adds a restart interrupted, or removes them (spec §10.4). */
  async bootRepair(): Promise<void> {
    for (const s of await this.live()) {
      if (s.state === "adding") await this.finishAdding(s.id);
    }
  }

  /** `bootRepair` without holding up boot (a fetch may take minutes); `idle()` waits for it. */
  repairInBackground(): void {
    this.background(() => this.bootRepair());
  }

  // Find more skills ----------------------------------------------------------------------

  /** The skills at the source's current pin or folder, with the picked ones marked as taken by it. */
  async find(id: string): Promise<SourcePreview> {
    const row = await this.get(id);
    const { root, one } = await this.rootOf(row);
    const found = await this.found(await candidates(root, one), await this.live());
    return { found, ...(row.commit ? { commit: row.commit } : {}) };
  }

  private async rootOf(row: SkillSourceRow): Promise<{ root: string; one: string }> {
    if (row.kind === "folder") {
      const root = row.path ?? "";
      return { root, one: path.basename(root) };
    }
    const root = this.cacheDir(row.id, row.commit ?? "");
    if (!(await isDir(root))) {
      throw new ApiError(409, "missing_cache", SOURCE_MSG.noCache);
    }
    return { root, one: path.basename(row.subpath ?? "") || path.basename(row.repo ?? "") };
  }

  async addSkills(id: string, skills: string[], by: Who): Promise<SourceDetail> {
    const first = await this.get(id);
    const { root, one } = await this.rootOf(first);
    const fresh = skills.filter((n) => !first.skills.includes(n));
    const notPickable = async (rows: SkillSourceRow[]) => {
      const found = await this.found(await candidates(root, one), rows, id);
      if (fresh.some((n) => !found.find((x) => x.name === n)?.pickable)) {
        throw new ApiError(400, "validation_error", SOURCE_MSG.pickNotAllowed, {
          fields: { skills: SOURCE_MSG.pickNotAllowed },
        });
      }
    };
    // Names are checked before the fetch, so an absent one is a 400 and not a git failure.
    await notPickable(await this.live());
    // The tree shas of new skills need git, which the installed cache (no .git) can't answer.
    let trees: Record<string, string> = {};
    let tmp: string | undefined;
    if (first.kind === "github" && fresh.length > 0) {
      tmp = path.join(this.previewRoot, `find-${randomUUID()}`);
    }
    try {
      if (tmp && first.commit) {
        await fetchCommit(
          this.urlOf(first.repo ?? ""),
          first.commit,
          tmp,
          this.fetchOpts(first.repo ?? ""),
        ).catch((e) => {
          throw this.fieldFor(e);
        });
        trees = await this.treesOf(tmp, first.commit, first.subpath ?? "", fresh);
      }
      const row = await libraryLock.run(LIBRARY_KEY, async () => {
        const cur = await this.get(id);
        // An update or refetch that moved the pin since the read makes the trees and the picks stale.
        if (cur.commit !== first.commit) throw new ApiError(409, "pin_moved", SOURCE_MSG.pinMoved);
        await notPickable(await this.live());
        const merged = [...new Set([...cur.skills, ...fresh])].sort();
        const next = await this.d.store.update(id, {
          skills: merged,
          ...(cur.kind === "github" ? { trees: { ...(cur.trees ?? {}), ...trees } } : {}),
        });
        return next as SkillSourceRow;
      });
      await this.after(undefined, undefined);
      return this.detail(row);
    } finally {
      if (tmp) await removeTree(tmp).catch(() => {});
    }
  }

  // Check ---------------------------------------------------------------------------------

  /** The staged copy of an update commit, fetched if it isn't there (or was swept). */
  private async updatePreview(row: SkillSourceRow, commit: string): Promise<string> {
    const final = path.join(this.previewRoot, `upd-${row.id}-${commit}`);
    if (await isDir(final)) {
      await touchDir(final);
      return final;
    }
    const tmp = `${final}.tmp-${randomUUID()}`;
    try {
      await fetchCommit(this.urlOf(row.repo ?? ""), commit, tmp, this.fetchOpts(row.repo ?? ""));
      await this.checkCheckout(tmp, row.subpath ?? "");
      await mkdir(path.dirname(final), { recursive: true });
      await rename(tmp, final).catch(async () => {
        if (!(await isDir(final))) throw new Error("preview rename failed");
      });
    } finally {
      await removeTree(tmp).catch(() => {});
    }
    return final;
  }

  /** When a check was queued for the source (ISO), while one is queued or running; the list shows it as "Checking…". */
  checkingSince(id: string): string | undefined {
    return this.checking.get(id)?.toISOString();
  }

  /** One source's check. The `library_changed` frame goes out after the checking mark is cleared, so the web's refetch sees the result. */
  async check(id: string): Promise<SourceDetail> {
    const owns = !this.checking.has(id);
    if (owns) {
      this.checking.set(id, this.now());
      this.d.publish?.();
    }
    try {
      return await this.runCheck(id);
    } finally {
      if (owns) this.checking.delete(id);
      this.d.publish?.();
    }
  }

  private async runCheck(id: string): Promise<SourceDetail> {
    const row = await this.get(id);
    if (row.kind !== "github" || row.state !== "ready") return this.detail(row);
    let patch: Partial<SkillSourceRow>;
    try {
      const ref = await resolveRef(
        this.urlOf(row.repo ?? ""),
        row.branch,
        this.fetchOpts(row.repo ?? ""),
      );
      if (ref.sha === row.commit) {
        patch = { updateCommit: null, updateAt: null, updateSubject: null };
      } else {
        const co = await this.updatePreview(row, ref.sha);
        const meta = await this.logOf(co);
        patch = {
          updateCommit: ref.sha,
          updateAt: new Date(meta.committedAt),
          updateSubject: cutGraphemes(meta.subject, SUBJECT_MAX),
        };
      }
      patch = { ...patch, checkError: null };
    } catch (e) {
      patch = { checkError: checkErrorText(e, SOURCE_MSG.checkFailed) };
    }
    const next = await libraryLock.run(LIBRARY_KEY, async () => {
      const cur = (await this.d.store.all()).find((r) => r.id === id);
      // The row went away, or an update moved its pin while we fetched: the result is for another pin.
      if (!cur || cur.deletedAt !== null || cur.commit !== row.commit) return cur;
      return this.d.store.update(id, { ...patch, checkedAt: this.now() });
    });
    return this.detail(next ?? row);
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

  /**
   * Marks every GitHub source that is ready as checking, at once (so the list shows the whole queue, not four at a time).
   * Returns only the ones this call marked: a source a running check already owns stays with that check, so a second
   * Check for updates neither re-marks it nor checks it twice.
   */
  private async markChecking(): Promise<string[]> {
    const queue = (await this.live())
      .filter((s) => s.kind === "github" && s.state === "ready" && !this.checking.has(s.id))
      .map((s) => s.id);
    const since = this.now();
    for (const id of queue) this.checking.set(id, since);
    if (queue.length > 0) this.d.publish?.();
    return queue;
  }

  private async drainChecks(queue: string[]): Promise<void> {
    const worker = async () => {
      for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
        try {
          await this.runCheck(id);
        } catch {
          // The source keeps its last result; the mark below is cleared either way.
        } finally {
          this.checking.delete(id);
          this.d.publish?.();
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CHECK_CONCURRENCY, queue.length) }, worker));
  }

  async checkAll(): Promise<void> {
    await this.drainChecks(await this.markChecking());
  }

  /** Check for updates: the sources are marked before this returns, the checks run in the background (`idle()` waits for them). */
  async startCheckAll(): Promise<void> {
    const queue = await this.markChecking();
    this.background(() => this.drainChecks(queue));
  }

  // Update --------------------------------------------------------------------------------

  /** Where picked skill `name` lives under a root: the root itself for a one-skill source. */
  private async skillDirIn(root: string, name: string): Promise<string> {
    return (await readSkillMd(root)) ? root : path.join(root, name);
  }

  async updateView(id: string): Promise<UpdateView> {
    const row = await this.get(id);
    if (row.kind !== "github" || !row.updateCommit || !row.commit) {
      throw new ApiError(409, "no_update", SOURCE_MSG.noUpdate);
    }
    const subpath = row.subpath ?? "";
    const co = await this.updatePreview(row, row.updateCommit);
    const newRoot = path.join(co, subpath);
    const oldRoot = this.cacheDir(row.id, row.commit);
    const oldKnown = await isDir(oldRoot);
    const view: UpdateView = {
      from: row.commit,
      to: row.updateCommit,
      committedAt: row.updateAt ? row.updateAt.toISOString() : null,
      subject: row.updateSubject,
      changed: [],
      removed: [],
      added: [],
      unusable: [],
    };
    if (this.d.githubUrl === DEFAULT_GITHUB) {
      view.compareUrl = `${DEFAULT_GITHUB}/${row.repo}/compare/${row.commit}...${row.updateCommit}`;
    }
    const nowTrees = await this.treesOf(co, row.updateCommit, subpath, row.skills, {
      tolerateMissing: true,
    });
    for (const n of row.skills) {
      const dir = await this.skillDirIn(newRoot, n);
      const tree = nowTrees[n];
      if (tree === undefined || !(await readSkillMd(dir))) {
        view.removed.push(n);
        continue;
      }
      const f = await inspect(n, dir);
      if (f.state !== "ok") {
        view.unusable.push({ name: n, detail: f.detail ?? "Unusable" });
        continue;
      }
      if (row.trees?.[n] === tree) continue;
      const cap = this.d.fileWalkCap ?? FILE_WALK_CAP;
      const after = await codeSurface(dir, cap);
      const before = oldKnown
        ? await codeSurface(await this.skillDirIn(oldRoot, n), cap)
        : { hooks: [], exec: new Map<string, string>(), capped: false };
      const had = new Set(before.hooks.map(hookKey));
      const has = new Set(after.hooks.map(hookKey));
      const hooks = {
        added: after.hooks.filter((h) => !had.has(hookKey(h))),
        removed: before.hooks.filter((h) => !has.has(hookKey(h))),
      };
      const execFiles = [...after.exec]
        .filter(([p, hash]) => before.exec.get(p) !== hash)
        .map(([p]) => p)
        .sort();
      view.changed.push({
        name: n,
        // Past the cap some files weren't read, so "nothing new runs" can't be claimed.
        runsCodeChanged: hooks.added.length > 0 || execFiles.length > 0 || after.capped,
        hooks,
        execFiles,
      });
    }
    view.changed.sort((a, b) => Number(b.runsCodeChanged) - Number(a.runsCodeChanged));
    const picked = new Set(row.skills);
    view.added = (await candidates(newRoot, ""))
      .map((c) => c.name)
      .filter((n) => !picked.has(n) && n !== "");
    return view;
  }

  async update(id: string, commit: string, by: Who): Promise<SourceDetail> {
    const first = await this.get(id);
    if (first.kind !== "github" || first.updateCommit !== commit) {
      throw new ApiError(409, "stale_update", SOURCE_MSG.noUpdate);
    }
    const co = await this.updatePreview(first, commit);
    const result = await libraryLock.run(LIBRARY_KEY, async () => {
      const row = await this.get(id);
      if (row.updateCommit !== commit || row.commit === null) {
        throw new ApiError(409, "stale_update", SOURCE_MSG.noUpdate);
      }
      const subpath = row.subpath ?? "";
      const root = path.join(co, subpath);
      const keep: string[] = [];
      const dropped: string[] = [];
      for (const n of row.skills) {
        const dir = await this.skillDirIn(root, n);
        const f = (await readSkillMd(dir)) ? await inspect(n, dir) : undefined;
        (f?.state === "ok" ? keep : dropped).push(n);
      }
      const usedDropped: string[] = [];
      for (const n of dropped) {
        const u = await this.d.usedByAny([n]);
        if (u.templates.length + u.agents.length > 0) usedDropped.push(n);
      }
      if (usedDropped.length > 0) {
        const users = await this.d.usedByAny(usedDropped);
        throw new ApiError(
          409,
          "update_drops_used",
          `Update would remove ${usedDropped.length === 1 ? "skill" : "skills"} ${usedDropped.join(", ")}, used by ${usersLine(users.templates, users.agents)}.`,
          { skills: usedDropped, templates: users.templates, agents: users.agents },
        );
      }
      if (keep.length === 0) throw new ApiError(409, "empties_source", SOURCE_MSG.emptiesSource);
      const trees = await this.treesOf(co, commit, subpath, keep);
      const before = await this.capture(row.skills);
      const dest = this.cacheDir(id, commit);
      if (!(await isDir(dest))) await installCheckout(co, subpath, dest);
      const log = await this.logOf(co);
      const next = await this.d.store.update(id, {
        commit,
        committedAt: new Date(log.committedAt),
        subject: cutGraphemes(log.subject, SUBJECT_MAX),
        trees,
        skills: keep,
        updateCommit: null,
        updateAt: null,
        updateSubject: null,
        checkError: null,
      });
      return { row: next as SkillSourceRow, skills: row.skills, before };
    });
    await removeTree(co).catch(() => {});
    await this.after(result.skills, by, undefined, result.before);
    return this.detail(result.row);
  }

  async refetch(id: string): Promise<SourceDetail> {
    const row = await this.get(id);
    if (row.kind !== "github" || row.state !== "ready" || row.commit === null) {
      throw new ApiError(409, "not_github", SOURCE_MSG.noCache);
    }
    const dest = this.cacheDir(id, row.commit);
    if (!(await isDir(dest))) {
      const tmp = path.join(this.previewRoot, `refetch-${randomUUID()}`);
      try {
        await fetchCommit(
          this.urlOf(row.repo ?? ""),
          row.commit,
          tmp,
          this.fetchOpts(row.repo ?? ""),
        ).catch((e) => {
          throw this.fieldFor(e);
        });
        await this.checkCheckout(tmp, row.subpath ?? "");
        await libraryLock.run(LIBRARY_KEY, async () => {
          if (!(await isDir(dest))) await installCheckout(tmp, row.subpath ?? "", dest);
        });
      } finally {
        await removeTree(tmp).catch(() => {});
      }
    }
    this.d.publish?.();
    return this.detail(row);
  }

  // Remove and Undo -----------------------------------------------------------------------

  async remove(id: string): Promise<{ undoUntil: string }> {
    const undoUntil = await libraryLock.run(LIBRARY_KEY, async () => {
      const row = await this.get(id);
      const users = await this.d.usedByAny(row.skills);
      if (users.templates.length + users.agents.length > 0) {
        throw new ApiError(409, "in_use", `Used by ${usersLine(users.templates, users.agents)}.`, {
          templates: users.templates,
          agents: users.agents,
        });
      }
      const now = this.now();
      await this.d.store.update(id, { deletedAt: now });
      return new Date(now.getTime() + this.undoMs).toISOString();
    });
    this.d.publish?.();
    this.d.purgeAfter?.(this.undoMs);
    return { undoUntil };
  }

  async restore(id: string, by: Who): Promise<SourceDetail> {
    const row = await libraryLock.run(LIBRARY_KEY, async () => {
      const cur = await this.get(id, { deleted: true });
      const until = (cur.deletedAt as Date).getTime() + this.undoMs;
      if (this.now().getTime() >= until) throw new ApiError(409, "undo_over", SOURCE_MSG.undoOver);
      const rows = await this.live();
      for (const n of cur.skills) {
        if (await this.takenBy(n, rows)) {
          throw new ApiError(409, "name_taken", SOURCE_MSG.nameTaken);
        }
      }
      const before = await this.capture(cur.skills);
      return {
        row: (await this.d.store.update(id, { deletedAt: null })) as SkillSourceRow,
        before,
      };
    });
    await this.after(row.row.skills, by, undefined, row.before);
    return this.detail(row.row);
  }

  // Previews ------------------------------------------------------------------------------

  /** Forgets preview metadata older than a day; the sweep removes the directories (spec §9.4). */
  dropOldPreviewMeta(): void {
    const cutoff = this.now().getTime() - META_KEEP_MS;
    for (const [k, m] of this.previews) if (m.at < cutoff) this.previews.delete(k);
  }
}
