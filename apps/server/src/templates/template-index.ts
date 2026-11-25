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
  CONFIG_FILES,
  type ConfigDoc,
  type ConfigHashes,
  canonicalJson,
  isUserImageRef,
  LOCAL_SKILL_NAMES,
  NAME_PATTERN,
  TEMPLATE_FILES,
  type TemplateConfig,
  type TemplateConfigResponse,
  type TemplateDetail,
  type TemplateFile,
  type TemplateIssue,
  yamlPart,
} from "@open-factory/shared";
import { and, asc, count, eq, isNotNull, isNull, notInArray, sql } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import { stringify } from "yaml";
import { type Config, localRuntimeAllowed } from "../config.ts";
import { ApiError } from "../errors.ts";
import { imageDir } from "../images/context.ts";
import type { LibraryIndex } from "../library/library-index.ts";
import { avatarStat } from "./avatar.ts";
import { KeyLock } from "./key-lock.ts";
import { parseJson, parseYaml } from "./parse.ts";
import { type ValidationContext, validateTemplate } from "./validate.ts";
import { applyConfigToYaml } from "./yaml-write.ts";

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

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

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
  private readonly library: Pick<
    LibraryIndex,
    "resolveSkill" | "marketplaces" | "marketplaceDir" | "catalogAt"
  >;
  private readonly log: Pick<FastifyBaseLogger, "error"> | undefined;
  private readonly listeners: TemplateChangeListener[] = [];
  /**
   * One parse-upsert-CAS (and one row delete) at a time per template, so a scan always compares against what its
   * predecessor wrote.
   */
  private readonly locks = new KeyLock();
  /** Per-template serial dispatch chains (in memory: a crash loses a pending dispatch, spec §7.1). */
  private readonly queues = new Map<string, Promise<void>>();

  constructor(d: {
    db: Db;
    config: Config;
    /** Skills are validated through the Library (spec §6.6). */
    library: Pick<LibraryIndex, "resolveSkill" | "marketplaces" | "marketplaceDir" | "catalogAt">;
    log?: Pick<FastifyBaseLogger, "error">;
  }) {
    this.db = d.db;
    this.library = d.library;
    this.config = d.config;
    this.log = d.log;
    this.dir = path.join(d.config.factoryHome, "templates");
  }

  private folder(name: string) {
    if (!NAME_PATTERN.test(name)) throw notFound(name);
    return path.join(this.dir, name);
  }

  /** Every template on disk: a folder with a template.yaml. */
  async names(): Promise<string[]> {
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
      library: this.library,
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

  /** The real folder names under a valid template's `skills/` (empty for an invalid or unknown template). */
  async localSkillsOf(name: string): Promise<string[]> {
    const [row] = await this.db
      .select({ doc: schema.templates.lastValid, valid: schema.templates.valid })
      .from(schema.templates)
      .where(eq(schema.templates.name, name));
    const local = row?.valid ? row.doc?.template[LOCAL_SKILL_NAMES] : undefined;
    return Array.isArray(local) ? local.filter((x): x is string => typeof x === "string") : [];
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
    // `row` came from the upsert, which never touches last_valid*: it still holds the previous doc.
    return {
      row: { ...row, valid: true, lastValid: doc, lastValidHash: hash },
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
      await this.deleteRow(name);
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

  /**
   * I2 §12.1 `GET /api/templates/:name/config`. `doc` is the parsed configuration while the template has no errors (the
   * derived `local_skill_names` never leaves: it is the separate `localSkills`). `cantStart` is every live agent while
   * the template has errors (they can't start until it is fixed, spec §12.5) and none otherwise.
   */
  async readConfig(name: string): Promise<TemplateConfigResponse> {
    const dir = this.folder(name);
    if (!(await isDir(dir)) || !(await readOrNull(path.join(dir, "template.yaml")))) {
      await this.deleteRow(name);
      throw notFound(name);
    }
    const ctx = await this.context();
    // Hashes and parse under one lock hold, so a save can't land between them.
    const { hashes, full } = await this.locks.run(name, async () => ({
      hashes: await this.configHashes(dir),
      full: await this.indexLocked(name, ctx, FILE_CHANGE),
    }));
    const { row, doc } = full;
    const rows = await this.db
      .select({ archived: isNotNull(schema.agents.archivedAt) })
      .from(schema.agents)
      .where(
        and(
          eq(schema.agents.template, name),
          eq(schema.agents.kind, "persistent"),
          isNull(schema.agents.terminatedAt),
        ),
      );
    const live = rows.filter((r) => !r.archived).length;
    const local = doc.template[LOCAL_SKILL_NAMES];
    return {
      doc: row.valid ? { ...doc, template: yamlPart(doc.template) } : null,
      hashes,
      issues: row.issues,
      localSkills: Array.isArray(local) ? (local as string[]) : [],
      agents: { live, archived: rows.length - live, cantStart: row.valid ? 0 : live },
    };
  }

  private async configHashes(dir: string): Promise<ConfigHashes> {
    const [y, s, m] = await Promise.all(
      CONFIG_FILES.map(async (f) => {
        const buf = await readOrNull(path.join(dir, f));
        return buf ? fileHash(buf) : null;
      }),
    );
    return { "template.yaml": y ?? null, "settings.json": s ?? null, "mcp.json": m ?? null };
  }

  /**
   * I2 §12.1 `PUT /api/templates/:name/config`. Under the template's lock: every base hash is checked (409
   * `changed_on_disk` with today's hashes), the three new texts are built and the whole template is validated as it
   * would be written (an error gives a 400 and nothing is written), then only the files whose content changed are
   * written (temp + rename). The rescan after the lock fires the template change once. `by` is the caller's handle.
   */
  async writeConfig(
    name: string,
    doc: ConfigDoc,
    baseHashes: ConfigHashes,
    by: string,
  ): Promise<{ hashes: ConfigHashes; issues: TemplateIssue[]; changed: boolean }> {
    const dir = this.folder(name);
    if (!(await isDir(dir))) throw notFound(name);
    return this.locks.run(name, async () => {
      const current = {
        "template.yaml": await readOrNull(path.join(dir, "template.yaml")),
        "settings.json": await readOrNull(path.join(dir, "settings.json")),
        "mcp.json": await readOrNull(path.join(dir, "mcp.json")),
      };
      if (!current["template.yaml"]) throw notFound(name);
      const hashes: ConfigHashes = {
        "template.yaml": fileHash(current["template.yaml"]),
        "settings.json": current["settings.json"] ? fileHash(current["settings.json"]) : null,
        "mcp.json": current["mcp.json"] ? fileHash(current["mcp.json"]) : null,
      };
      if (CONFIG_FILES.some((f) => hashes[f] !== baseHashes[f]))
        throw new ApiError(
          409,
          "changed_on_disk",
          "Changed on disk since you opened it. Reload to see the changes.",
          { currentHashes: hashes },
        );

      const yamlText = current["template.yaml"].toString("utf8");
      const parsed = parseYaml(yamlText);
      if (parsed.error)
        throw new ApiError(400, "invalid_config", "The configuration has errors.", {
          issues: [
            {
              severity: "error",
              file: "template.yaml",
              message: parsed.error.message,
              ...(parsed.error.line ? { line: parsed.error.line } : {}),
            } satisfies TemplateIssue,
          ],
        });
      // `local_skill_names` is derived: it is never written to template.yaml, whatever the caller sent.
      const next: Partial<Record<TemplateFile, string>> = {};
      const yamlOut = applyConfigToYaml(yamlText, yamlPart(doc.template));
      if (yamlOut !== yamlText) next["template.yaml"] = yamlOut;
      const json = (file: "settings.json" | "mcp.json", want: unknown, empty: unknown) => {
        const buf = current[file];
        const have = buf ? parseJson(buf.toString("utf8")) : { value: empty };
        // Top-level keys the form doesn't know (mcp.json's) are the file's own: they stay.
        const merged =
          file === "mcp.json" && isRecord(have.value) && isRecord(want)
            ? { ...have.value, ...want }
            : want;
        if (!have.error && canonicalJson(have.value) === canonicalJson(merged)) return;
        next[file] = `${JSON.stringify(merged, null, 2)}\n`;
      };
      json("settings.json", doc.settings, {});
      json("mcp.json", doc.mcp, { mcpServers: {} });

      const v = await validateTemplate(dir, name, await this.context(), next);
      if (v.issues.some((i) => i.severity === "error"))
        throw new ApiError(400, "invalid_config", "The configuration has errors.", {
          issues: v.issues,
        });

      // All temps first, then the renames in sequence: a failed write leaves the template as it was.
      const temps: [string, string][] = [];
      let failure: unknown;
      try {
        for (const [file, content] of Object.entries(next)) {
          const target = path.join(dir, file);
          const tmp = `${target}.${randomBytes(4).toString("hex")}.tmp`;
          temps.push([tmp, target]);
          await writeFile(tmp, content);
        }
        // Renamed entries leave `temps`, so the cleanup below only removes what never got its turn.
        for (let first = temps[0]; first; first = temps[0]) {
          await rename(first[0], first[1]);
          temps.shift();
        }
      } catch (err) {
        failure = err;
      } finally {
        await Promise.all(temps.map(([tmp]) => rm(tmp, { force: true })));
      }
      // Even after a failed write the index must match the disk, and `by` is this caller's.
      const row = await this.indexLocked(name, await this.context(), by).catch(() => undefined);
      if (failure) throw failure;
      const after = { ...hashes };
      for (const [file, content] of Object.entries(next))
        after[file as keyof ConfigHashes] = fileHash(Buffer.from(content));
      return {
        hashes: after,
        issues: row?.row.issues ?? v.issues,
        changed: Object.keys(next).length > 0,
      };
    });
  }

  async validate(name: string, file: TemplateFile, content: string): Promise<TemplateIssue[]> {
    const dir = this.folder(name);
    if (!(await isDir(dir))) throw notFound(name);
    return (await validateTemplate(dir, name, await this.context(), { [file]: content })).issues;
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
      await this.deleteRow(name);
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
    await this.deleteRow(name);
  }

  /** Under the template's lock, so an index in flight can't upsert the row back after the delete. */
  private deleteRow(name: string) {
    return this.locks.run(name, () =>
      this.db.delete(schema.templates).where(eq(schema.templates.name, name)),
    );
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
