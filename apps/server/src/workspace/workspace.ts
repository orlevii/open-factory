import { mkdir, readFile, readlink, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Mount } from "@open-factory/harness";
import type { TemplateConfig } from "@open-factory/shared";
import type { Effective } from "../agents/config-resolver.ts";
import { AgentStartError } from "../agents/errors.ts";
import { FieldError } from "../errors.ts";
import { FIELD_MSG } from "../field-messages.ts";
import { redactOutput } from "../redact.ts";
import type { DenyRules } from "../spawning/inherit.ts";
import { buildClaudeMd, type OrgEntry, type OrgHuman } from "./claude-md.ts";
import { backupDiffering, templateTargets, utcStamp, writeAtomic, writeTargets } from "./files.ts";
import {
  linkProjects,
  linkSkills,
  resolveHostSkills,
  resolveTemplateSkills,
  WorkspaceError,
} from "./links.ts";
import type { KeyedMutex } from "./lock.ts";
import { buildMcpJson } from "./mcp.ts";
import {
  buildMounts,
  checkMounts,
  declaredMarketplaceDirs,
  dockerSocketPaths,
  type MountCheckContext,
} from "./mounts.ts";
import {
  agentConfigDir,
  agentStateDir,
  agentWorkdir,
  personaPendingDir,
  personaRoot,
  pluginsConfigDir,
} from "./paths.ts";
import { installPlugins, PluginInstallError } from "./plugins.ts";
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
    // A new agent starts from a clean plugin dir (a failed earlier create of this slug may have left one).
    await rm(pluginsConfigDir(this.d.factoryHome, slug), { recursive: true, force: true });
    await this.ensurePlugins(slug, tpl.config.plugins, tpl.tplSettings);
    const skills = await resolveHostSkills(this.d.hostSkillsDir, check.config.skills);
    const tplSkills = tpl.config.localSkills ? await resolveTemplateSkills(tpl.dir) : [];
    await linkSkills(
      workdir,
      { dir: this.d.hostSkillsDir, skills },
      { templateDir: tpl.dir, skills: tplSkills },
      { checkOnly: true },
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
  }> {
    const workdir = this.workdir(i.slug);
    const configDir = agentConfigDir(workdir);
    const configRel = path.relative(workdir, configDir);
    const safe = new SafeFs(workdir);
    const { config, doc } = i.effective;
    await this.applyPendingPersona(i.slug);
    // A listed plugin that isn't installed yet is installed now, under the workspace lock (spec §6.5).
    // A failed install fails the start closed: a process never starts without its plugins.
    try {
      await this.ensurePlugins(i.slug, config.plugins, doc.settings);
    } catch (err) {
      if (!(err instanceof PluginInstallError)) throw err;
      // The error names the plugin redacted; the template's list is matched in the same form.
      const plugin = err.plugin ?? redactOutput(config.plugins[0] ?? "");
      throw new AgentStartError(
        `Plugin ${plugin} didn't install.`,
        i.effective.templatePlugins.some((p) => redactOutput(p) === plugin) ? "template" : "config",
        undefined,
        // No output (a silent exit, a timeout): the error's own line, already redacted, says why.
        err.output || err.message,
      );
    }
    const pluginKeys = await this.readPluginKeys(i.slug);
    await this.linkPlugins(i.slug, workdir);
    const skills = await resolveHostSkills(this.d.hostSkillsDir, config.skills);
    const templateDir = path.join(this.d.factoryHome, "templates", i.template);
    const tplSkills = config.localSkills ? await resolveTemplateSkills(templateDir) : [];
    await linkSkills(
      workdir,
      { dir: this.d.hostSkillsDir, skills },
      { templateDir, skills: tplSkills },
    );
    await linkProjects(workdir, i.grants);
    const grantedPaths = i.grants.map((g) => g.hostPath);
    const settings = buildSettings({
      tpl: doc.settings,
      pluginKeys,
      slug: i.slug,
      workdir,
      permissionMode: config.permissionMode,
      plugins: config.plugins,
      grantedPaths,
      mcpUrl: i.mcpUrl,
      ...(i.inheritedDeny ? { inherited: i.inheritedDeny } : {}),
    });
    await safe.writeFile(path.join(configRel, "settings.json"), JSON.stringify(settings, null, 2));
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
      hostSkillPaths: skills.map((s) => s.realDir),
      templateSkillPaths: tplSkills.map((s) => s.realDir),
      declaredMarketplaceDirs: declaredMarketplaceDirs(doc.settings),
      pluginsDir: path.join(pluginsConfigDir(this.d.factoryHome, i.slug), "plugins"),
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
        templateDir,
        factoryHome: this.d.factoryHome,
        home,
        dockerSockets: dockerSocketPaths(this.serverEnv, home),
      };
      return { workdir, configDir, mounts: await checkMounts(mounts, mountCheck), mountCheck };
    }
    return { workdir, configDir, mounts };
  }

  /**
   * Installs the listed plugins that `plugins-config/settings.json` doesn't hold yet (spec §6.5), into the
   * factory-owned plugins-config/, never the agent's config dir or cwd (§11.7, R1). Marketplace sources come
   * only from `settings`, the template's `extraKnownMarketplaces`. An installed plugin is never updated.
   */
  private async ensurePlugins(
    slug: string,
    plugins: string[],
    settings: Record<string, unknown>,
  ): Promise<void> {
    const installed = obj((await this.readPluginKeys(slug)).enabledPlugins);
    const missing = plugins.filter((p) => !Object.hasOwn(installed, p));
    if (!missing.length) return;
    const pluginsConfig = pluginsConfigDir(this.d.factoryHome, slug);
    await mkdir(pluginsConfig, { recursive: true });
    await installPlugins({
      claudeBin: this.d.claudeBin,
      pluginsConfig,
      plugins: missing,
      tplSettings: settings,
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
   *  there is refused: the factory never moves an agent's folder aside. */
  private async linkPlugins(slug: string, workdir: string): Promise<void> {
    const safe = new SafeFs(workdir);
    const rel = path.join(path.relative(workdir, agentConfigDir(workdir)), "plugins");
    const target = path.join(pluginsConfigDir(this.d.factoryHome, slug), "plugins");
    await mkdir(target, { recursive: true });
    const st = await safe.entry(rel);
    if (st && !st.isSymbolicLink())
      throw new WorkspaceError(`${path.join(workdir, rel)} isn't a link; move it away.`);
    await safe.link(rel, target);
  }
}
