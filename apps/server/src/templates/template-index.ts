import { createHash, randomBytes } from "node:crypto";
import type { Dirent } from "node:fs";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { type Db, schema } from "@open-factory/db";
import {
  type ConfigDoc,
  canonicalJson,
  isUserImageRef,
  LOCAL_SKILL_NAMES,
  NAME_PATTERN,
  TEMPLATE_FILES,
  type TemplateConfig,
  type TemplateDetail,
  type TemplateFile,
  type TemplateIssue,
} from "@open-factory/shared";
import { and, asc, count, eq, isNotNull, isNull, notInArray, sql } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import { stringify } from "yaml";
import { type Config, localRuntimeAllowed } from "../config.ts";
import { ApiError } from "../errors.ts";
import { imageDir } from "../images/context.ts";
import { avatarStat } from "./avatar.ts";
import { KeyLock } from "./key-lock.ts";
import { type ValidationContext, validateTemplate } from "./validate.ts";

export type TemplateRow = typeof schema.templates.$inferSelect;

export const fileHash = (buf: Buffer) => createHash("sha256").update(buf).digest("hex");

/** The change-detection key of a parse: the canonical ConfigDoc, so AGENTS.md and files/ edits never move it. */
export const configDocHash = (doc: ConfigDoc) =>
  createHash("sha256").update(canonicalJson(doc)).digest("hex");

/** `by` of a change that did not come through the API (spec §7.1). */
export const FILE_CHANGE = "file change";

export type TemplateChange = {
  name: string;
  before: ConfigDoc | null;
  after: ConfigDoc;
  by: string;
};
export type TemplateChangeListener = (e: TemplateChange) => void | Promise<void>;

const notFound = (name: string) =>
  new ApiError(404, "template_not_found", `Template ${name} not found.`);

async function isDir(p: string) {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function readOrNull(p: string): Promise<Buffer | null> {
  try {
    return await readFile(p);
  } catch {
    return null;
  }
}

/** Every regular file under dir (no symlinks followed), as sorted relative paths. */
async function listFiles(dir: string, rel = ""): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await listFiles(dir, r)));
    else if (e.isFile()) out.push(r);
  }
  return out.sort();
}

async function contentHash(dir: string) {
  const h = createHash("sha256");
  for (const rel of await listFiles(dir)) {
    h.update(rel);
    h.update("\0");
    h.update(await readFile(path.join(dir, rel)));
  }
  return h.digest("hex");
}

export class TemplateIndex {
  readonly dir: string;
  private readonly db: Db;
  private readonly config: Config;
  private readonly log: Pick<FastifyBaseLogger, "error"> | undefined;
  private readonly listeners: TemplateChangeListener[] = [];
  /** Per-template serial dispatch chains (in memory: a crash loses a pending dispatch, spec §7.1). */
  /** One parse-upsert-CAS at a time per template, so a scan always compares against what its predecessor wrote. */
  private readonly locks = new KeyLock();
  private readonly queues = new Map<string, Promise<void>>();

  constructor(d: { db: Db; config: Config; log?: Pick<FastifyBaseLogger, "error"> }) {
    this.db = d.db;
    this.config = d.config;
    this.log = d.log;
    this.dir = path.join(d.config.factoryHome, "templates");
  }

  private folder(name: string) {
    if (!NAME_PATTERN.test(name)) throw notFound(name);
    return path.join(this.dir, name);
  }

  private async names(): Promise<string[]> {
    let entries: Dirent[];
    try {
      entries = await readdir(this.dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const out: string[] = [];
    for (const e of entries) {
      if (e.name.startsWith(".") || !NAME_PATTERN.test(e.name)) continue;
      if (!(e.isDirectory() || e.isSymbolicLink())) continue;
      const p = path.join(this.dir, e.name);
      if (!(await isDir(p))) continue;
      if (!(await readOrNull(path.join(p, "template.yaml")))) continue;
      out.push(e.name);
    }
    return out.sort();
  }

  /**
   * Names of `<factoryHome>/images/<name>/` folders that hold a Dockerfile, by the builder's rule: the folder's
   * real path is a direct child of images/ (`imageDir`), so a link leaving images/ never validates.
   */
  private async userImages(): Promise<string[]> {
    const root = path.join(this.config.factoryHome, "images");
    let entries: Dirent[];
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      return [];
    }
    const out: string[] = [];
    for (const e of entries) {
      if (!isUserImageRef(e.name)) continue;
      try {
        const dir = await imageDir(root, e.name);
        if ((await stat(path.join(dir, "Dockerfile"))).isFile()) out.push(e.name);
      } catch {}
    }
    return out;
  }

  async context(): Promise<ValidationContext> {
    const [projects, secrets, templates, userImages] = await Promise.all([
      this.db.select({ name: schema.projects.name }).from(schema.projects),
      this.db.select({ name: schema.secrets.name }).from(schema.secrets),
      this.names(),
      this.userImages(),
    ]);
    return {
      projects: new Set(projects.map((p) => p.name)),
      secrets: new Set(secrets.map((s) => s.name)),
      templates: new Set(templates),
      userImages: new Set(userImages),
      hostSkillsDir: this.config.hostSkillsDir,
      localRuntimeAllowed: localRuntimeAllowed(this.config),
    };
  }

  /** Registers a listener for template changes. Listeners run off the scan's path and are never awaited by it. */
  onChange(listener: TemplateChangeListener): void {
    this.listeners.push(listener);
  }

  /**
   * The last valid parse of a template: a DB read only, never a disk read, so it is safe inside a transaction that holds
   * row locks (`db` is then that transaction).
   */
  async lastValid(name: string, db: Pick<Db, "select"> = this.db): Promise<ConfigDoc | null> {
    const [row] = await db
      .select({ doc: schema.templates.lastValid })
      .from(schema.templates)
      .where(eq(schema.templates.name, name));
    return row?.doc ?? null;
  }

  /** Enqueues a change on the template's chain, started in a microtask and never awaited by the caller. */
  private dispatch(e: TemplateChange) {
    const prev = this.queues.get(e.name) ?? Promise.resolve();
    const run = async () => {
      for (const l of this.listeners) {
        try {
          await l(e);
        } catch (err) {
          this.log?.error({ err, template: e.name }, "template change listener failed");
        }
      }
    };
    const next = new Promise<void>((resolve) => {
      queueMicrotask(() => {
        void prev.then(run).then(resolve);
      });
    });
    this.queues.set(e.name, next);
    void next.then(() => {
      if (this.queues.get(e.name) === next) this.queues.delete(e.name);
    });
  }

  private index(name: string, ctx: ValidationContext, by: string) {
    return this.locks.run(name, () => this.indexLocked(name, ctx, by));
  }

  private async indexLocked(
    name: string,
    ctx: ValidationContext,
    by: string,
  ): Promise<{
    row: TemplateRow;
    doc: ConfigDoc;
    tplYaml: Record<string, unknown>;
    tplSettings: Record<string, unknown>;
    tplMcp: { mcpServers: Record<string, unknown> };
  }> {
    const dir = path.join(this.dir, name);
    const v = await validateTemplate(dir, name, ctx);
    // The skill folders are part of the doc (I2 §7.2), so adding or removing one moves the hash and dispatches.
    const doc: ConfigDoc = {
      template: { ...v.tplYaml, [LOCAL_SKILL_NAMES]: v.localSkillNames },
      settings: v.tplSettings,
      mcp: v.tplMcp,
    };
    const isValid = !!v.config && !v.issues.some((i) => i.severity === "error");
    const values = {
      name,
      path: dir,
      config: v.config ?? null,
      issues: v.issues,
      contentHash: await contentHash(dir),
      scannedAt: new Date(),
    };
    const [row] = await this.db
      .insert(schema.templates)
      .values(values)
      .onConflictDoUpdate({ target: schema.templates.name, set: values })
      .returning();
    if (!row) throw new Error("template upsert returned no row");
    // The upsert never touches last_valid*; `row` still holds the previous values.
    if (!isValid) {
      if (row.valid)
        await this.db
          .update(schema.templates)
          .set({ valid: false })
          .where(eq(schema.templates.name, name));
      return {
        row: { ...row, valid: false },
        doc,
        tplYaml: v.tplYaml,
        tplSettings: v.tplSettings,
        tplMcp: v.tplMcp,
      };
    }
    const hash = configDocHash(doc);
    if (hash !== row.lastValidHash) {
      // Compare-and-set: only the caller whose update returns a row dispatches, so concurrent scans fire once.
      const won = await this.db
        .update(schema.templates)
        .set({ lastValid: doc, lastValidHash: hash, valid: true })
        .where(
          and(
            eq(schema.templates.name, name),
            sql`${schema.templates.lastValidHash} IS NOT DISTINCT FROM ${row.lastValidHash}`,
          ),
        )
        .returning({ name: schema.templates.name });
      if (won.length) this.dispatch({ name, before: row.lastValid, after: doc, by });
    } else if (!row.valid) {
      await this.db
        .update(schema.templates)
        .set({ valid: true })
        .where(eq(schema.templates.name, name));
    }
    return {
      row: { ...row, valid: true },
      doc,
      tplYaml: v.tplYaml,
      tplSettings: v.tplSettings,
      tplMcp: v.tplMcp,
    };
  }

  async scan(by = FILE_CHANGE): Promise<TemplateRow[]> {
    const names = await this.names();
    const ctx = await this.context();
    const rows: TemplateRow[] = [];
    for (const n of names) {
      try {
        rows.push((await this.index(n, ctx, by)).row);
      } catch {
        // An unreadable folder is skipped; its previous row stays until the folder is gone.
      }
    }
    await this.db
      .delete(schema.templates)
      .where(names.length ? notInArray(schema.templates.name, names) : undefined);
    return rows;
  }

  private async scanOneFull(name: string, by: string) {
    const dir = this.folder(name);
    if (!(await isDir(dir)) || !(await readOrNull(path.join(dir, "template.yaml")))) {
      await this.locks.run(name, () =>
        this.db.delete(schema.templates).where(eq(schema.templates.name, name)),
      );
      return undefined;
    }
    return this.index(name, await this.context(), by);
  }

  async scanOne(name: string, by = FILE_CHANGE): Promise<TemplateRow | undefined> {
    return (await this.scanOneFull(name, by))?.row;
  }

  /** Non-archived agents per template name. */
  async agentCounts(): Promise<Map<string, number>> {
    const rows = await this.db
      .select({ template: schema.agents.template, n: count() })
      .from(schema.agents)
      .where(isNull(schema.agents.archivedAt))
      .groupBy(schema.agents.template);
    return new Map(rows.map((r) => [r.template, r.n]));
  }

  async detail(name: string): Promise<TemplateDetail> {
    const row = await this.scanOne(name);
    if (!row) throw notFound(name);
    const files = await Promise.all(
      TEMPLATE_FILES.map(async (file) => {
        const buf = await readOrNull(path.join(row.path, file));
        return {
          file,
          content: buf ? buf.toString("utf8") : null,
          hash: buf ? fileHash(buf) : null,
        };
      }),
    );
    const agents = await this.db
      .select({ slug: schema.agents.slug })
      .from(schema.agents)
      .where(and(eq(schema.agents.template, name), isNull(schema.agents.archivedAt)));
    return {
      name,
      path: row.path,
      ...(row.config ? { config: row.config } : {}),
      files,
      issues: row.issues,
      agents: agents.map((a) => a.slug).sort(),
      avatar: await avatarStat(row.path, this.dir),
    };
  }

  async writeFile(
    name: string,
    file: TemplateFile,
    content: string,
    baseHash: string | null,
    by: string,
  ): Promise<{ hash: string; issues: TemplateIssue[] }> {
    const dir = this.folder(name);
    if (!(await isDir(dir))) throw notFound(name);
    const target = path.join(dir, file);
    const current = await readOrNull(target);
    const currentHash = current ? fileHash(current) : null;
    if (currentHash !== baseHash)
      throw new ApiError(
        409,
        "changed_on_disk",
        "Changed on disk since you opened it. Reload to see the changes.",
        { currentHash },
      );
    const tmp = `${target}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(tmp, content);
    await rename(tmp, target);
    const row = await this.scanOne(name, by);
    return { hash: fileHash(Buffer.from(content)), issues: row?.issues ?? [] };
  }

  async validate(name: string, file: TemplateFile, content: string): Promise<TemplateIssue[]> {
    const dir = this.folder(name);
    if (!(await isDir(dir))) throw notFound(name);
    return (await validateTemplate(dir, name, await this.context(), { file, content })).issues;
  }

  async create(b: { name: string; displayName: string; description?: string }): Promise<void> {
    const dir = this.folder(b.name);
    await mkdir(this.dir, { recursive: true });
    try {
      await mkdir(dir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST")
        throw new ApiError(409, "template_exists", `A template named ${b.name} already exists.`);
      throw e;
    }
    try {
      const yaml = stringify(
        {
          name: b.name,
          display_name: b.displayName,
          description: b.description ?? "",
          runtime: "docker",
        },
        { lineWidth: 0 },
      );
      await writeFile(path.join(dir, "template.yaml"), yaml);
      await writeFile(path.join(dir, "AGENTS.md"), `# ${b.displayName}\n`);
    } catch (e) {
      await rm(dir, { recursive: true, force: true });
      throw e;
    }
    await this.scanOne(b.name);
  }

  async remove(name: string): Promise<void> {
    const dir = this.folder(name);
    let st: Awaited<ReturnType<typeof lstat>>;
    try {
      st = await lstat(dir);
    } catch {
      await this.db.delete(schema.templates).where(eq(schema.templates.name, name));
      throw notFound(name);
    }
    const users = await this.db
      .select({ slug: schema.agents.slug, archived: isNotNull(schema.agents.archivedAt) })
      .from(schema.agents)
      .where(and(eq(schema.agents.template, name), isNull(schema.agents.terminatedAt)))
      .orderBy(sql`${schema.agents.archivedAt} IS NOT NULL`, asc(schema.agents.createdAt));
    const first = users[0];
    if (first) {
      const more = users.length > 1 ? ` and ${users.length - 1} more` : "";
      const archived = users.filter((u) => u.archived).length;
      const arch = archived ? ` (${archived} archived)` : "";
      throw new ApiError(
        409,
        "template_in_use",
        `@${first.slug}${more}${arch} ${users.length === 1 ? "uses" : "use"} this template. Archive and recreate them first.`,
      );
    }
    if (st.isSymbolicLink()) await unlink(dir);
    else await rm(dir, { recursive: true });
    await this.db.delete(schema.templates).where(eq(schema.templates.name, name));
  }

  /** For agent starts and creation: the validated template, its folder, its parts and its ConfigDoc. */
  async loadValid(name: string): Promise<{
    dir: string;
    config: TemplateConfig;
    tplYaml: Record<string, unknown>;
    tplSettings: Record<string, unknown>;
    tplMcp: { mcpServers: Record<string, unknown> };
    doc: ConfigDoc;
  }> {
    const full = await this.scanOneFull(name, FILE_CHANGE);
    if (!full) throw new ApiError(409, "template_missing", `Template ${name} no longer exists.`);
    const { row, tplYaml, tplSettings, tplMcp, doc } = full;
    if (row.issues.some((i) => i.severity === "error") || !row.config)
      throw new ApiError(409, "template_invalid", `Template ${name} has errors.`, {
        issues: row.issues,
      });
    return { dir: row.path, config: row.config, tplYaml, tplSettings, tplMcp, doc };
  }
}
