import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import type { Mount } from "@open-factory/harness";
import type { TemplateConfig } from "@open-factory/shared";
import { FieldError } from "../errors.ts";
import { buildClaudeMd } from "./claude-md.ts";
import {
  backupDiffering,
  copyTargets,
  resyncStamp,
  templateTargets,
  writeAtomic,
} from "./files.ts";
import { linkHostSkills, linkProjects, resolveHostSkills } from "./links.ts";
import type { KeyedMutex } from "./lock.ts";
import { buildMcpJson } from "./mcp.ts";
import { buildMounts } from "./mounts.ts";
import { agentConfigDir, agentWorkdir, templateCopyDir } from "./paths.ts";
import { installPlugins } from "./plugins.ts";
import { buildSettings } from "./settings.ts";

export interface PrepareInput {
  slug: string;
  displayName: string;
  description: string;
  template: string;
  config: TemplateConfig;
  manager: { slug: string; displayName: string } | null;
  grants: { name: string; hostPath: string }[];
}

export interface TemplateSource {
  dir: string;
  config: TemplateConfig;
  tplSettings: Record<string, unknown>;
  tplMcp: unknown;
}

export class Workspace {
  /** PLAN DECISION: callers lock on the slug, which is unique and immutable, so the lock can be
   *  taken before the agent row exists (normally locks key on stable ids). */
  readonly lock: KeyedMutex;
  private readonly serverEnv: NodeJS.ProcessEnv;
  private readonly log: { warn: (o: object, msg: string) => void };

  constructor(
    private readonly d: {
      factoryHome: string;
      hostSkillsDir: string;
      claudeBin: string;
      serverEnv?: NodeJS.ProcessEnv;
      lock: KeyedMutex;
      log?: { warn: (o: object, msg: string) => void };
    },
  ) {
    this.lock = d.lock;
    this.serverEnv = d.serverEnv ?? process.env;
    this.log = d.log ?? { warn: () => {} };
  }

  workdir(slug: string): string {
    return agentWorkdir(this.d.factoryHome, slug);
  }

  /** Claims the folder (non-recursive mkdir; EEXIST → FieldError("slug", …, "folder_exists")), copies, installs, checks. */
  async materialize(
    _agentKey: string,
    slug: string,
    tpl: TemplateSource,
    check: PrepareInput,
  ): Promise<void> {
    const workdir = this.workdir(slug);
    await mkdir(path.join(this.d.factoryHome, "agents"), { recursive: true });
    try {
      await mkdir(workdir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        throw new FieldError(
          "slug",
          `A folder already exists at ${workdir}. Move it away or pick another slug.`,
          "folder_exists",
        );
      }
      throw err;
    }
    const configDir = agentConfigDir(workdir);
    await copyTargets(
      tpl.dir,
      workdir,
      await templateTargets(tpl.dir, tpl.config),
      tpl.tplSettings,
      tpl.tplMcp,
    );
    await mkdir(configDir, { recursive: true });
    if (tpl.config.plugins.length) await this.install(workdir, configDir, tpl);
    const skills = await resolveHostSkills(this.d.hostSkillsDir, check.config.skills);
    await linkHostSkills(workdir, this.d.hostSkillsDir, skills, { checkOnly: true });
    await linkProjects(workdir, check.grants, { checkOnly: true });
  }

  /** Removes a folder this process created (only call after a successful materialize claim). */
  async discard(slug: string): Promise<void> {
    await rm(this.workdir(slug), { recursive: true, force: true });
  }

  /** Under the caller-held lock: backup + overwrite + install. Returns the relative backup dir. */
  async resync(slug: string, tpl: TemplateSource): Promise<string | undefined> {
    const workdir = this.workdir(slug);
    const configDir = agentConfigDir(workdir);
    const targets = await templateTargets(tpl.dir, tpl.config);
    const incoming: { to: string; data: Buffer }[] = [];
    for (const t of targets) incoming.push({ to: t.to, data: await readFile(t.from) });
    incoming.push(
      {
        to: path.join(".factory", "template", "settings.json"),
        data: Buffer.from(JSON.stringify(tpl.tplSettings, null, 2)),
      },
      {
        to: path.join(".factory", "template", "mcp.json"),
        data: Buffer.from(JSON.stringify(tpl.tplMcp, null, 2)),
      },
    );
    const backup = await backupDiffering(workdir, incoming, resyncStamp());
    await copyTargets(tpl.dir, workdir, targets, tpl.tplSettings, tpl.tplMcp);
    await mkdir(configDir, { recursive: true });
    if (tpl.config.plugins.length) await this.install(workdir, configDir, tpl);
    return backup;
  }

  /** Callers must hold the agent's workspace lock. */
  async prepare(i: PrepareInput): Promise<{ workdir: string; configDir: string; mounts: Mount[] }> {
    const workdir = this.workdir(i.slug);
    const configDir = agentConfigDir(workdir);
    const copy = templateCopyDir(workdir);
    const tpl = JSON.parse(await readFile(path.join(copy, "settings.json"), "utf8"));
    const tplMcp = JSON.parse(await readFile(path.join(copy, "mcp.json"), "utf8"));
    let prev: Record<string, unknown> = {};
    try {
      prev = JSON.parse(await readFile(path.join(configDir, "settings.json"), "utf8"));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        this.log.warn({ slug: i.slug }, "previous settings.json didn't parse; starting from {}");
      }
    }
    const skills = await resolveHostSkills(this.d.hostSkillsDir, i.config.skills);
    await linkHostSkills(workdir, this.d.hostSkillsDir, skills);
    await linkProjects(workdir, i.grants);
    const grantedPaths = i.grants.map((g) => g.hostPath);
    const settings = buildSettings({
      tpl,
      prev,
      slug: i.slug,
      workdir,
      permissionMode: i.config.permissionMode,
      plugins: i.config.plugins,
      grantedPaths,
    });
    await writeAtomic(path.join(configDir, "settings.json"), JSON.stringify(settings, null, 2));
    await writeAtomic(
      path.join(workdir, ".mcp.json"),
      JSON.stringify(buildMcpJson(tplMcp), null, 2),
    );
    await writeAtomic(
      path.join(configDir, "CLAUDE.md"),
      buildClaudeMd({
        slug: i.slug,
        displayName: i.displayName,
        description: i.description,
        template: i.template,
        manager: i.manager,
        workdir,
        projects: i.grants,
        secretNames: i.config.secrets,
      }),
    );
    return {
      workdir,
      configDir,
      mounts: buildMounts({
        workdir,
        grantedPaths,
        hostSkillPaths: skills.map((s) => s.realDir),
        tplSettings: tpl,
      }),
    };
  }

  private install(workdir: string, configDir: string, tpl: TemplateSource) {
    return installPlugins({
      claudeBin: this.d.claudeBin,
      configDir,
      cwd: workdir,
      plugins: tpl.config.plugins,
      tplSettings: tpl.tplSettings,
      serverEnv: this.serverEnv,
    });
  }
}
