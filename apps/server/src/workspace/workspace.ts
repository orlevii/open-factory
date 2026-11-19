import { lstat, mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Mount } from "@open-factory/harness";
import type { TemplateConfig } from "@open-factory/shared";
import { FieldError } from "../errors.ts";
import { buildClaudeMd } from "./claude-md.ts";
import { backupDiffering, copyTargets, resyncStamp, templateTargets } from "./files.ts";
import { linkHostSkills, linkProjects, resolveHostSkills, WorkspaceError } from "./links.ts";
import type { KeyedMutex } from "./lock.ts";
import { buildMcpJson } from "./mcp.ts";
import { buildMounts, checkMounts, declaredMarketplaceDirs, dockerSocketPaths } from "./mounts.ts";
import {
  agentConfigDir,
  agentStateDir,
  agentWorkdir,
  pluginsConfigDir,
  resyncRoot,
  templateCopyDir,
} from "./paths.ts";
import { installPlugins } from "./plugins.ts";
import { SafeFs } from "./safe-fs.ts";
import { buildSettings } from "./settings.ts";

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

async function exists(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

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
      /** The CLI bundle mounted read-only into Docker agents (spec §11.6). */
      cliBundle: string;
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
      templateCopyDir(this.d.factoryHome, slug),
      await templateTargets(tpl.dir, tpl.config),
      tpl.tplSettings,
      tpl.tplMcp,
    );
    await new SafeFs(workdir).mkdirp(path.relative(workdir, configDir));
    // A new agent starts from a clean plugin dir (a failed earlier create of this slug may have left one).
    await rm(pluginsConfigDir(this.d.factoryHome, slug), { recursive: true, force: true });
    if (tpl.config.plugins.length) await this.install(slug, tpl);
    const skills = await resolveHostSkills(this.d.hostSkillsDir, check.config.skills);
    await linkHostSkills(workdir, this.d.hostSkillsDir, skills, { checkOnly: true });
    await linkProjects(workdir, check.grants, { checkOnly: true });
  }

  /** Removes a folder this process created (only call after a successful materialize claim).
   *  Never follows a link the folder holds (or a link in its place). */
  async discard(slug: string): Promise<void> {
    await new SafeFs(this.workdir(slug)).removeAll();
  }

  /** Under the caller-held lock: backup + overwrite + install. Returns the backup dir relative to FACTORY_HOME. */
  async resync(slug: string, tpl: TemplateSource): Promise<string | undefined> {
    const workdir = this.workdir(slug);
    const configDir = agentConfigDir(workdir);
    const targets = await templateTargets(tpl.dir, tpl.config);
    const incoming: { to: string; data: Buffer }[] = [];
    for (const t of targets) incoming.push({ to: t.to, data: await readFile(t.from) });
    const backup = await backupDiffering(
      workdir,
      resyncRoot(this.d.factoryHome, slug),
      incoming,
      resyncStamp(),
    );
    await copyTargets(
      tpl.dir,
      workdir,
      templateCopyDir(this.d.factoryHome, slug),
      targets,
      tpl.tplSettings,
      tpl.tplMcp,
    );
    await new SafeFs(workdir).mkdirp(path.relative(workdir, configDir));
    if (tpl.config.plugins.length) await this.install(slug, tpl);
    // The human act that migrates an S4 agent: its old real plugins dir moves aside (spec §11.7).
    await this.linkPlugins(slug, workdir);
    return backup ? path.relative(this.d.factoryHome, backup) : undefined;
  }

  /**
   * Lock contract: no Workspace method takes a lock itself. Callers must hold `lock.run(slug, …)`
   * around materialize, resync and prepare (createPrepareStart does so for prepare).
   */
  async prepare(i: PrepareInput): Promise<{ workdir: string; configDir: string; mounts: Mount[] }> {
    const workdir = this.workdir(i.slug);
    const configDir = agentConfigDir(workdir);
    const configRel = path.relative(workdir, configDir);
    const safe = new SafeFs(workdir);
    const copy = templateCopyDir(this.d.factoryHome, i.slug);
    const tpl = await this.readTemplateJson<Record<string, unknown>>(copy, "settings.json");
    const tplMcp = await this.readTemplateJson<{ mcpServers: Record<string, unknown> }>(
      copy,
      "mcp.json",
    );
    // Fail closed before touching anything: plugins are third-party code, so a start never installs
    // them (S4 Q7); an S4 agent, or one whose install didn't finish, needs the human's re-sync.
    const pluginKeys = await this.readPluginKeys(i.slug);
    const installed = obj(pluginKeys.enabledPlugins);
    if (i.config.plugins.some((p) => !Object.hasOwn(installed, p))) {
      throw new WorkspaceError(
        `Re-sync @${i.slug} to reinstall its plugins into the factory-managed location.`,
        "resync",
      );
    }
    await this.linkPlugins(i.slug, workdir);
    const skills = await resolveHostSkills(this.d.hostSkillsDir, i.config.skills);
    await linkHostSkills(workdir, this.d.hostSkillsDir, skills);
    await linkProjects(workdir, i.grants);
    const grantedPaths = i.grants.map((g) => g.hostPath);
    const settings = buildSettings({
      tpl,
      pluginKeys,
      slug: i.slug,
      workdir,
      permissionMode: i.config.permissionMode,
      plugins: i.config.plugins,
      grantedPaths,
    });
    await safe.writeFile(path.join(configRel, "settings.json"), JSON.stringify(settings, null, 2));
    await safe.writeFile(".mcp.json", JSON.stringify(buildMcpJson(tplMcp), null, 2));
    await safe.writeFile(
      path.join(configRel, "CLAUDE.md"),
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
    // Spec §11.4: mounts come only from factory-owned inputs (`tpl` is the copy under state/).
    const mountInputs = {
      workdir,
      grantedPaths,
      hostSkillPaths: skills.map((s) => s.realDir),
      declaredMarketplaceDirs: declaredMarketplaceDirs(tpl),
      pluginsDir: path.join(pluginsConfigDir(this.d.factoryHome, i.slug), "plugins"),
      cliBundle: this.d.cliBundle,
    };
    const mounts = buildMounts(mountInputs);
    // Local agents ignore mounts; a Docker start fails closed on any refused one.
    if (i.config.runtime === "docker") {
      const home = os.homedir();
      await checkMounts(mounts, {
        ...mountInputs,
        factoryHome: this.d.factoryHome,
        home,
        dockerSockets: dockerSocketPaths(this.serverEnv, home),
      });
    }
    return { workdir, configDir, mounts };
  }

  private async readTemplateJson<T>(copy: string, file: string): Promise<T> {
    const p = path.join(copy, file);
    try {
      return JSON.parse(await readFile(p, "utf8"));
    } catch (err) {
      const why =
        (err as NodeJS.ErrnoException).code === "ENOENT" ? "is missing" : "isn't valid JSON";
      throw new WorkspaceError(
        `The template copy ${p} ${why}. Re-sync the agent from its template.`,
        "edit_agent",
      );
    }
  }

  /** Installs into the factory-owned plugins-config/, never the agent's config dir or cwd (§11.7, R1). */
  private async install(slug: string, tpl: TemplateSource): Promise<void> {
    const pluginsConfig = pluginsConfigDir(this.d.factoryHome, slug);
    await mkdir(pluginsConfig, { recursive: true });
    await installPlugins({
      claudeBin: this.d.claudeBin,
      pluginsConfig,
      plugins: tpl.config.plugins,
      tplSettings: tpl.tplSettings,
      hostHome: this.serverEnv.HOME,
      path: this.serverEnv.PATH,
    });
  }

  /** `plugins-config/settings.json`: factory-owned, so it is the only source of the plugin keys. */
  private async readPluginKeys(slug: string): Promise<Record<string, unknown>> {
    const p = path.join(pluginsConfigDir(this.d.factoryHome, slug), "settings.json");
    let raw: string;
    try {
      raw = await readFile(p, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw err;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
        return parsed as Record<string, unknown>;
    } catch {}
    this.log.warn({ slug }, "plugins-config settings.json isn't a JSON object; ignoring it");
    return {};
  }

  /** Makes `.claude-config/plugins` a factory-made link to `plugins-config/plugins`. A real folder
   *  there (an S4 install, or Claude's own `plugins/store/`) moves aside to `plugins-legacy-<ts>/`. */
  private async linkPlugins(slug: string, workdir: string): Promise<void> {
    const safe = new SafeFs(workdir);
    const rel = path.join(path.relative(workdir, agentConfigDir(workdir)), "plugins");
    const target = path.join(pluginsConfigDir(this.d.factoryHome, slug), "plugins");
    await mkdir(target, { recursive: true });
    const st = await safe.entry(rel);
    if (st && !st.isSymbolicLink()) {
      const state = agentStateDir(this.d.factoryHome, slug);
      const stamp = resyncStamp();
      let dest = path.join(state, `plugins-legacy-${stamp}`);
      for (let n = 2; await exists(dest); n++)
        dest = path.join(state, `plugins-legacy-${stamp}-${n}`);
      await safe.moveOut(rel, dest);
      this.log.warn({ slug, movedTo: dest }, "moved the agent's old plugins folder aside");
    }
    await safe.link(rel, target);
  }
}
