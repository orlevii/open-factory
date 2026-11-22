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
  isUserImageRef,
  NAME_PATTERN,
  TEMPLATE_FILES,
  type TemplateConfig,
  type TemplateDetail,
  type TemplateFile,
  type TemplateIssue,
} from "@open-factory/shared";
import { and, count, eq, isNull, notInArray } from "drizzle-orm";
import { stringify } from "yaml";
import { type Config, localRuntimeAllowed } from "../config.ts";
import { ApiError } from "../errors.ts";
import { imageDir } from "../images/context.ts";
import { avatarStat } from "./avatar.ts";
import { type ValidationContext, validateTemplate } from "./validate.ts";

export type TemplateRow = typeof schema.templates.$inferSelect;

export const fileHash = (buf: Buffer) => createHash("sha256").update(buf).digest("hex");

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

  constructor(d: { db: Db; config: Config }) {
    this.db = d.db;
    this.config = d.config;
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

  private async index(
    name: string,
    ctx: ValidationContext,
  ): Promise<{
    row: TemplateRow;
    tplSettings: Record<string, unknown>;
    tplMcp: { mcpServers: Record<string, unknown> };
  }> {
    const dir = path.join(this.dir, name);
    const v = await validateTemplate(dir, name, ctx);
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
    return { row, tplSettings: v.tplSettings, tplMcp: v.tplMcp };
  }

  async scan(): Promise<TemplateRow[]> {
    const names = await this.names();
    const ctx = await this.context();
    const rows: TemplateRow[] = [];
    for (const n of names) {
      try {
        rows.push((await this.index(n, ctx)).row);
      } catch {
        // An unreadable folder is skipped; its previous row stays until the folder is gone.
      }
    }
    await this.db
      .delete(schema.templates)
      .where(names.length ? notInArray(schema.templates.name, names) : undefined);
    return rows;
  }

  private async scanOneFull(name: string) {
    const dir = this.folder(name);
    if (!(await isDir(dir)) || !(await readOrNull(path.join(dir, "template.yaml")))) {
      await this.db.delete(schema.templates).where(eq(schema.templates.name, name));
      return undefined;
    }
    return this.index(name, await this.context());
  }

  async scanOne(name: string): Promise<TemplateRow | undefined> {
    return (await this.scanOneFull(name))?.row;
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
    const row = await this.scanOne(name);
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
    if (st.isSymbolicLink()) await unlink(dir);
    else await rm(dir, { recursive: true });
    await this.db.delete(schema.templates).where(eq(schema.templates.name, name));
  }

  /** For agent creation and re-sync: the validated template, its folder and the two JSON copies. */
  async loadValid(name: string): Promise<{
    dir: string;
    config: TemplateConfig;
    tplSettings: Record<string, unknown>;
    tplMcp: { mcpServers: Record<string, unknown> };
  }> {
    const full = await this.scanOneFull(name);
    if (!full) throw new ApiError(409, "template_missing", `Template ${name} no longer exists.`);
    const { row, tplSettings, tplMcp } = full;
    if (row.issues.some((i) => i.severity === "error") || !row.config)
      throw new ApiError(409, "template_invalid", `Template ${name} has errors.`, {
        issues: row.issues,
      });
    return { dir: row.path, config: row.config, tplSettings, tplMcp };
  }
}
