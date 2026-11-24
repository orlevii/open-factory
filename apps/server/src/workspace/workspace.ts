import { mkdir, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Mount } from "@open-factory/harness";
import { type Pin, pinOf, type TemplateConfig } from "@open-factory/shared";
import { type Effective, pinString } from "../agents/config-resolver.ts";
import { AgentStartError } from "../agents/errors.ts";
import { FieldError } from "../errors.ts";
import { FIELD_MSG } from "../field-messages.ts";
import { assertPluginFloor, versionCheckEnv } from "../library/claude-flags.ts";
import type { LibraryIndex } from "../library/library-index.ts";
import {
  buildPluginSettings,
  dependencyKeys,
  type MarketplaceSource,
  readInstalled,
} from "../library/plugin-settings.ts";
import type { DenyRules } from "../spawning/inherit.ts";
import {
  checkAgentFrontmatter,
  checkProjectSettings,
  checkSkillPlugins,
  scrubAgentFolders,
} from "./agent-folders.ts";
import { buildClaudeMd, type OrgEntry, type OrgHuman } from "./claude-md.ts";
import { backupDiffering, templateTargets, utcStamp, writeAtomic, writeTargets } from "./files.ts";
import { linkProjects, linkSkills, resolveSkills, resolveTemplateSkills } from "./links.ts";
import type { KeyedMutex } from "./lock.ts";
import { buildMcpJson } from "./mcp.ts";
import { buildMounts, checkMounts, dockerSocketPaths, type MountCheckContext } from "./mounts.ts";
import {
  agentConfigDir,
  agentPluginsDir,
  agentStateDir,
  agentWorkdir,
  personaPendingDir,
  personaRoot,
} from "./paths.ts";
import { SafeFs } from "./safe-fs.ts";
import { buildSettings } from "./settings.ts";

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

export interface PrepareInput {
  slug: string;
  displayName: string;
  description: string;
  template: string;
  /** The merged template and overlay this start runs with (spec §6.3). */
  effective: Effective;
  manager: { slug: string; displayName: string } | null;
  grants: { name: string; hostPath: string }[];
  peers: OrgEntry[];
  reports: OrgEntry[];
  humans: OrgHuman[];
  /** The agent listener's MCP endpoint as this agent reaches it (local loopback, or the Docker agentUrl). */
  mcpUrl: string;
  kind: "persistent" | "ephemeral";
  /** A spawned agent's spawner; null for a persistent agent. */
  spawner: { slug: string } | null;
  /** Set for an agent that holds the spawn tools (S7 §11.3). */
  spawning: { maxLive: number; perHour: number } | null;
  /** Set for a persistent agent (S9 §10.5); absent means none. */
  scheduling?: { zone: string; maxSchedules: number; minGapMinutes: number } | null;
  /** A spawned agent's deny rules inherited from its spawner at this start (S7 §6.3). */
  inheritedDeny?: DenyRules;
  /** The secrets this start actually passes (a spawned agent's are intersected with its spawner's). */
  secretNames: string[];
}

/** What `materialize` checks: the prepare input minus what only a start knows. */
export type MaterializeCheck = Omit<
  PrepareInput,
  | "effective"
  | "mcpUrl"
  | "peers"
  | "reports"
  | "humans"
  | "kind"
  | "spawner"
  | "spawning"
  | "scheduling"
  | "inheritedDeny"
  | "secretNames"
> & { config: TemplateConfig };

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
      /** Every listed skill resolves through the Library at a start (spec §6.4). */
      library: Pick<LibraryIndex, "resolveSkill" | "linkPrefixes" | "marketplaces" | "catalogAt">;
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

  /** Claims the folder (non-recursive mkdir; EEXIST → FieldError("slug", …, "folder_exists")), copies, checks. Never installs a plugin (spec §7.2). */
  async materialize(
    _agentKey: string,
    slug: string,
    tpl: TemplateSource,
    check: MaterializeCheck,
  ): Promise<void> {
    const workdir = this.workdir(slug);
    await mkdir(path.join(this.d.factoryHome, "agents"), { recursive: true });
    try {
      await mkdir(workdir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        throw new FieldError("slug", FIELD_MSG.slugFolderExists, "folder_exists");
      }
      throw err;
    }
    const configDir = agentConfigDir(workdir);
    await writeTargets(workdir, await templateTargets(tpl.dir));
    await new SafeFs(workdir).mkdirp(path.relative(workdir, configDir));
    const skills = await resolveSkills(this.d.library, check.config.skills, tpl.config.skills);
    const tplSkills = tpl.config.localSkills ? await resolveTemplateSkills(tpl.dir) : [];
    await linkSkills(
      workdir,
      skills,
      { templateDir: tpl.dir, skills: tplSkills },
      { checkOnly: true, prefixes: await this.d.library.linkPrefixes() },
    );
    await linkProjects(workdir, check.grants, { checkOnly: true });
  }

  /** Removes a folder this process created (only call after a successful materialize claim).
   *  Never follows a link the folder holds (or a link in its place). */
  async discard(slug: string): Promise<void> {
    await new SafeFs(this.workdir(slug)).removeAll();
  }

  /**
   * S7 §10.3 step 3: a terminated agent's workspace after the grace. The one Workspace method that takes the lock
   * itself: under `lock.run(slug)` it re-reads the pin (`stillUnpinned`; the pin route takes the same lock, so a pin
   * that returned success always keeps the workspace), then removes the workdir (`.claude-config` and its session
   * JSONL included) and the factory's state for it, each through `SafeFs.removeAll` (a link is removed as a link,
   * never followed), then records the deletion (`markDeleted`) before the lock is released. False when pinned.
   */
  async deleteWorkspace(
    slug: string,
    stillUnpinned: () => Promise<boolean>,
    markDeleted: () => Promise<void>,
  ): Promise<boolean> {
    return this.lock.run(slug, async () => {
      if (!(await stillUnpinned())) return false;
      await new SafeFs(this.workdir(slug)).removeAll();
      await new SafeFs(agentStateDir(this.d.factoryHome, slug)).removeAll();
      await markDeleted();
      return true;
    });
  }

  /**
   * Reset persona (spec §9), under the caller-held lock. `tplAgentsMd` is the template's AGENTS.md. Either replace
   * the agent's AGENTS.md at once (`canWriteNow`: nothing can race the write; the file it replaces is saved under
   * `state/agents/<slug>/persona/<stamp>/`) or stage the template's file in `persona-pending/` for the next
   * `prepare`. `backupDir` is relative to FACTORY_HOME and absent when there was no differing file to save; `changed` is false only
   * when the file already matched.
   */
  async resetPersona(
    slug: string,
    tplAgentsMd: string,
    opts: { canWriteNow: boolean },
  ): Promise<{ applied: "now" | "on_restart"; backupDir?: string; changed: boolean }> {
    const data = await readFile(tplAgentsMd);
    const pending = personaPendingDir(this.d.factoryHome, slug);
    if (!opts.canWriteNow) {
      await writeAtomic(path.join(pending, "AGENTS.md"), data);
      return { applied: "on_restart", changed: true };
    }
    const { backupDir, changed } = await this.applyPersona(slug, data);
    // A fresh reset supersedes anything staged earlier, but only once it applied: a failed apply keeps the old one.
    await rm(pending, { recursive: true, force: true });
    return { applied: "now", changed, ...(backupDir ? { backupDir } : {}) };
  }

  /** Saves the AGENTS.md being replaced (a link is saved as a link), then writes the new one through SafeFs. */
  private async applyPersona(
    slug: string,
    data: Buffer,
  ): Promise<{ backupDir?: string; changed: boolean }> {
    const workdir = this.workdir(slug);
    // A missing file is recreated: that is a change with nothing to back up.
    const existed = (await new SafeFs(workdir).entry("AGENTS.md")) !== null;
    const backup = await backupDiffering(
      workdir,
      personaRoot(this.d.factoryHome, slug),
      [{ to: "AGENTS.md", data }],
      utcStamp(),
    );
    await new SafeFs(workdir).writeFile("AGENTS.md", data);
    return {
      ...(backup ? { backupDir: path.relative(this.d.factoryHome, backup) } : {}),
      changed: backup !== undefined || !existed,
    };
  }

  /** A reset staged while the agent ran: applied first, then removed. A failure keeps it staged. */
  private async applyPendingPersona(slug: string): Promise<void> {
    const pending = personaPendingDir(this.d.factoryHome, slug);
    let data: Buffer;
    try {
      data = await readFile(path.join(pending, "AGENTS.md"));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    await this.applyPersona(slug, data);
    await rm(pending, { recursive: true, force: true });
  }

  /**
   * Lock contract: no Workspace method takes a lock itself except `deleteWorkspace`. Callers must hold
   * `lock.run(slug, …)` around materialize, reset-persona and prepare (createPrepareStart does so for prepare).
   */
  async prepare(i: PrepareInput): Promise<{
    workdir: string;
    configDir: string;
    mounts: Mount[];
    /** Docker only: the context `mounts` passed `checkMounts` with, for the pre-start re-check. */
    mountCheck?: MountCheckContext;
    /** What this start tells Claude Code about plugins, and what its first `init` is checked against. */
    plugins: PluginStart;
  }> {
    const workdir = this.workdir(i.slug);
    const configDir = agentConfigDir(workdir);
    const configRel = path.relative(workdir, configDir);
    const safe = new SafeFs(workdir);
    const { config, doc } = i.effective;
    await this.applyPendingPersona(i.slug);
    // Spec §7.3 step 1: every local start checks the host's Claude Code (a Docker image is checked once per digest).
    if (config.runtime === "local") await this.assertFloor();
    // Spec 7.3 step 3, in this order: link the skills, then check and scrub the agent's own folders.
    const skills = await resolveSkills(this.d.library, config.skills, i.effective.templateSkills);
    const templateDir = path.join(this.d.factoryHome, "templates", i.template);
    const tplSkills = config.localSkills ? await resolveTemplateSkills(templateDir) : [];
    await linkSkills(
      workdir,
      skills,
      { templateDir, skills: tplSkills },
      { prefixes: await this.d.library.linkPrefixes() },
    );
    await checkSkillPlugins(workdir);
    await scrubAgentFolders(workdir);
    await checkProjectSettings(workdir);
    await checkAgentFrontmatter(workdir, new Set([...skills, ...tplSkills].map((s) => s.name)));
    await linkProjects(workdir, i.grants);
    // Steps 2, 4 and 5: Claude Code installs into the agent's own plugins dir at this start; the factory only
    // says which plugins and where. A linked skill's name is also switched off as a skills-directory plugin.
    const plugins = await this.pluginStart(
      i.slug,
      doc.settings,
      i.effective.library.plugins,
      [...skills, ...tplSkills].map((s) => s.name),
    );
    const grantedPaths = i.grants.map((g) => g.hostPath);
    const settings = buildSettings({
      tpl: doc.settings,
      slug: i.slug,
      workdir,
      permissionMode: config.permissionMode,
      grantedPaths,
      mcpUrl: i.mcpUrl,
      ...(i.inheritedDeny ? { inherited: i.inheritedDeny } : {}),
    });
    await safe.writeFile(path.join(configRel, "settings.json"), JSON.stringify(settings, null, 2));
    // A copy of the `--settings` JSON, for diagnosis only: the process gets the string itself (spec §7.3 step 5).
    await writeAtomic(
      path.join(agentStateDir(this.d.factoryHome, i.slug), "plugin-settings.json"),
      plugins.settingsJson,
    );
    await safe.writeFile(
      ".mcp.json",
      JSON.stringify(buildMcpJson(doc.mcp, { url: i.mcpUrl }), null, 2),
    );
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
        secretNames: i.secretNames,
        peers: i.peers,
        reports: i.reports,
        humans: i.humans,
        kind: i.kind,
        spawner: i.spawner,
        spawning: i.spawning,
        scheduling: i.scheduling ?? null,
      }),
    );
    // Spec §11.4: mounts come only from factory-owned inputs (the template folder and the overlay in the database).
    const mountInputs = {
      workdir,
      grantedPaths,
      skillPaths: skills.map((s) => s.dir),
      templateSkillPaths: tplSkills.map((s) => s.realDir),
      declaredMarketplaceDirs: plugins.marketplaceDirs,
      pluginsDir: plugins.dir,
      cliBundle: this.d.cliBundle,
    };
    const mounts = buildMounts(mountInputs);
    // Local agents ignore mounts. A Docker start fails closed on any refused mount and gets the
    // checked (realpath) mounts plus the context, so the launcher re-checks right before each
    // container create/start (checkMounts' doc comment).
    if (config.runtime === "docker") {
      const home = os.homedir();
      const mountCheck: MountCheckContext = {
        ...mountInputs,
        slug: i.slug,
        templateDir,
        factoryHome: this.d.factoryHome,
        home,
        dockerSockets: dockerSocketPaths(this.serverEnv, home),
      };
      return {
        workdir,
        configDir,
        mounts: await checkMounts(mounts, mountCheck),
        mountCheck,
        plugins,
      };
    }
    return { workdir, configDir, mounts, plugins };
  }

  /** The host's Claude Code against the floor (spec §7.9). A failure is the start's error, naming both versions. */
  private async assertFloor(): Promise<void> {
    try {
      await assertPluginFloor(this.d.claudeBin, versionCheckEnv(this.serverEnv));
    } catch (err) {
      throw new AgentStartError(err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Spec §7.3 steps 2, 4 and 5 for one start: the closure (the enabled plugins and their dependencies, with the
   * dependencies of the agent's own installed copies counted only for marketplaces the template declares and Skills
   * has registered), the `--settings` JSON, the plugins dir (created here, real path) and the env switches.
   * `libraryPlugins` is `Effective.library.plugins`: each enabled key and the dependencies the Library could read.
   */
  private async pluginStart(
    slug: string,
    settings: Record<string, unknown>,
    libraryPlugins: Record<string, string>,
    skillsDirNames: string[],
  ): Promise<PluginStart> {
    const dir = agentPluginsDir(this.d.factoryHome, slug);
    await mkdir(dir, { recursive: true });
    // The real path: a Docker agent sees the dir at it, and the env must name the same place.
    const real = await realpath(dir);
    const declared = obj(settings.extraKnownMarketplaces);
    const rows = new Map((await this.d.library.marketplaces()).map((r) => [r.name, r]));
    const marketplaceOf = (key: string) => key.slice(key.lastIndexOf("@") + 1);
    const usable = (key: string) =>
      rows.has(marketplaceOf(key)) && Object.hasOwn(declared, marketplaceOf(key));
    const closure = new Set(
      Object.entries(libraryPlugins)
        .filter(([key, pin]) => pin !== "missing" && usable(key))
        .map(([key]) => key),
    );
    const installed = await readInstalled(real);
    const manifests = new Map(installed.map((e) => [e.key, e.manifest]));
    const queue = [...closure];
    for (let key = queue.shift(); key !== undefined; key = queue.shift()) {
      const manifest = manifests.get(key);
      if (!manifest) continue;
      for (const dep of dependencyKeys(manifest, marketplaceOf(key))) {
        if (closure.has(dep) || !usable(dep)) continue;
        closure.add(dep);
        queue.push(dep);
      }
    }
    const declarations: Record<string, { source: MarketplaceSource; pin: Pin }> = {};
    const catalogs: Record<string, string[]> = {};
    const marketplaceDirs: string[] = [];
    for (const mkt of new Set([...closure].map(marketplaceOf))) {
      const row = rows.get(mkt);
      if (!row) continue;
      const pin = pinOf(declared[mkt]);
      declarations[mkt] = { source: row.source, pin };
      const ref = pin.kind === "commit" ? pin.sha : pin.kind === "tag" ? pin.name : undefined;
      catalogs[mkt] = ((await this.d.library.catalogAt(row, ref)) ?? []).map((e) => e.name);
      if (row.source.source === "directory") marketplaceDirs.push(row.source.path);
    }
    const settingsJson = JSON.stringify(
      buildPluginSettings({
        closure: [...closure],
        declarations,
        catalogs,
        installed: installed.map((e) => e.key),
        skillsDirNames,
      }),
    );
    const sources = Object.values(declarations);
    return {
      dir: real,
      settingsJson,
      marketplaceDirs,
      latest: sources.some((d) => d.pin.kind === "latest"),
      remote: sources.some((d) => d.source.source !== "directory"),
      expected: [...closure].map((key) => ({
        key,
        pin: pinString(pinOf(declared[marketplaceOf(key)])),
      })),
    };
  }
}

/** What one start passes Claude Code about plugins (spec §7.3), and the plugins its first `init` must list. */
export interface PluginStart {
  /** `CLAUDE_CODE_PLUGIN_CACHE_DIR`: `state/agents/<slug>/plugins`, by its real path. */
  dir: string;
  /** The inline `--settings` JSON. */
  settingsJson: string;
  /** The registered directory marketplaces of the closure, mounted read-only for Docker. */
  marketplaceDirs: string[];
  /** A declared marketplace is Latest: `FORCE_AUTOUPDATE_PLUGINS=1`. */
  latest: boolean;
  /** A declared marketplace is remote (not a directory): `CLAUDE_CODE_SYNC_PLUGIN_INSTALL=1`. */
  remote: boolean;
  /** Each plugin of the closure with its pin (`Effective.library.plugins`' form). */
  expected: { key: string; pin: string }[];
}
