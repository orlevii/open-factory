import { mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Mount } from "@open-factory/harness";
import type { TemplateConfig } from "@open-factory/shared";
import type { Effective } from "../agents/config-resolver.ts";
import { FieldError } from "../errors.ts";
import { FIELD_MSG } from "../field-messages.ts";
import type { LibraryIndex } from "../library/library-index.ts";
import type { DenyRules } from "../spawning/inherit.ts";
import { checkAgentFrontmatter, checkProjectSettings, scrubAgentFolders } from "./agent-folders.ts";
import {
  buildClaudeMd,
  type ManagerRef,
  type OrgEntry,
  type OrgHuman,
  type Tagged,
} from "./claude-md.ts";
import { backupDiffering, templateTargets, utcStamp, writeAtomic, writeTargets } from "./files.ts";
import { linkProjects, linkSkills, resolveSkills, resolveTemplateSkills } from "./links.ts";
import type { KeyedMutex } from "./lock.ts";
import { buildMcpJson } from "./mcp.ts";
import { buildMounts, checkMounts, dockerSocketPaths, type MountCheckContext } from "./mounts.ts";
import {
  agentConfigDir,
  agentStateDir,
  agentWorkdir,
  personaPendingDir,
  personaRoot,
} from "./paths.ts";
import { SafeFs } from "./safe-fs.ts";
import { buildSettings } from "./settings.ts";

export interface PrepareInput {
  /** The directory key: the workdir, the state dir and the lock are named by it, so a rename keeps them. */
  ref: string;
  /** The agent's handle at this start (the system prompt and the git identity name it). */
  handle: string;
  /** The agent as CLAUDE.md names it: a tag with its current handle. */
  self: Tagged;
  displayName: string;
  description: string;
  template: string;
  /** The merged template and overlay this start runs with (spec §6.3). */
  effective: Effective;
  manager: ManagerRef;
  grants: { name: string; hostPath: string }[];
  peers: OrgEntry[];
  reports: OrgEntry[];
  humans: OrgHuman[];
  /** The agent listener's MCP endpoint as this agent reaches it (local loopback, or the Docker agentUrl). */
  mcpUrl: string;
  kind: "persistent" | "ephemeral";
  /** A spawned agent's spawner; null for a persistent agent. */
  spawner: Tagged | null;
  /** Set for an agent that holds the spawn tools (S7 §11.3). */
  spawning: boolean;
  /** Set for a persistent agent (S9 §10.5); absent means none. */
  scheduling?: { zone: string; maxSchedules: number; minGapMinutes: number } | null;
  /** A spawned agent's deny rules inherited from its spawner at this start (S7 §6.3). */
  inheritedDeny?: DenyRules;
  /** The secrets this start actually passes (a spawned agent's are intersected with its spawner's). */
  secretNames: string[];
  /** The agent holds manage_org (I7 §10). */
  manageOrg: boolean;
  /** The agent that last wrote this agent's own description, or null (I7 §10). */
  descriptionWrittenBy: Tagged | null;
  /** The member-update debounce in seconds at this start (I9 §4.8). */
  memberUpdateSeconds: number;
}

/** What `materialize` checks: the prepare input minus what only a start knows. */
export type MaterializeCheck = Omit<
  PrepareInput,
  | "ref"
  | "effective"
  | "self"
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
  | "manageOrg"
  | "descriptionWrittenBy"
  | "memberUpdateSeconds"
> & { config: TemplateConfig };

export interface TemplateSource {
  dir: string;
  config: TemplateConfig;
  tplSettings: Record<string, unknown>;
  tplMcp: unknown;
}

export class Workspace {
  /** Callers lock on the agent's ref (unique, immutable), so the lock can be taken before the agent row exists. */
  readonly lock: KeyedMutex;
  private readonly serverEnv: NodeJS.ProcessEnv;
  private readonly log: { warn: (o: object, msg: string) => void };

  constructor(
    private readonly d: {
      factoryHome: string;
      /** Every listed skill resolves through the Library at a start (spec §6.4). */
      library: Pick<LibraryIndex, "resolveSkill" | "linkPrefixes">;
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

  workdir(ref: string): string {
    return agentWorkdir(this.d.factoryHome, ref);
  }

  /** Claims the folder (non-recursive mkdir; EEXIST → FieldError("slug", …, "folder_exists")), copies, checks. */
  async materialize(ref: string, tpl: TemplateSource, check: MaterializeCheck): Promise<void> {
    const workdir = this.workdir(ref);
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
  async discard(ref: string): Promise<void> {
    await new SafeFs(this.workdir(ref)).removeAll();
  }

  /**
   * S7 §10.3 step 3: a terminated agent's workspace after the grace. The one Workspace method that takes the lock
   * itself: under `lock.run(ref)` it re-reads the pin (`stillUnpinned`; the pin route takes the same lock, so a pin
   * that returned success always keeps the workspace), then removes the workdir (`.claude-config` and its session
   * JSONL included) and the factory's state for it, each through `SafeFs.removeAll` (a link is removed as a link,
   * never followed), then records the deletion (`markDeleted`) before the lock is released. False when pinned.
   */
  async deleteWorkspace(
    ref: string,
    stillUnpinned: () => Promise<boolean>,
    markDeleted: () => Promise<void>,
  ): Promise<boolean> {
    return this.lock.run(ref, async () => {
      if (!(await stillUnpinned())) return false;
      await new SafeFs(this.workdir(ref)).removeAll();
      await new SafeFs(agentStateDir(this.d.factoryHome, ref)).removeAll();
      await markDeleted();
      return true;
    });
  }

  /**
   * Reset persona (spec §9), under the caller-held lock. `tplAgentsMd` is the template's AGENTS.md. Either replace
   * the agent's AGENTS.md at once (`canWriteNow`: nothing can race the write; the file it replaces is saved under
   * `state/agents/<ref>/persona/<stamp>/`) or stage the template's file in `persona-pending/` for the next
   * `prepare`. `backupDir` is relative to FACTORY_HOME and absent when there was no differing file to save; `changed` is false only
   * when the file already matched.
   */
  async resetPersona(
    ref: string,
    tplAgentsMd: string,
    opts: { canWriteNow: boolean },
  ): Promise<{ applied: "now" | "on_restart"; backupDir?: string; changed: boolean }> {
    const data = await readFile(tplAgentsMd);
    const pending = personaPendingDir(this.d.factoryHome, ref);
    if (!opts.canWriteNow) {
      await writeAtomic(path.join(pending, "AGENTS.md"), data);
      return { applied: "on_restart", changed: true };
    }
    const { backupDir, changed } = await this.applyPersona(ref, data);
    // A fresh reset supersedes anything staged earlier, but only once it applied: a failed apply keeps the old one.
    await rm(pending, { recursive: true, force: true });
    return { applied: "now", changed, ...(backupDir ? { backupDir } : {}) };
  }

  /** Saves the AGENTS.md being replaced (a link is saved as a link), then writes the new one through SafeFs. */
  private async applyPersona(
    ref: string,
    data: Buffer,
  ): Promise<{ backupDir?: string; changed: boolean }> {
    const workdir = this.workdir(ref);
    // A missing file is recreated: that is a change with nothing to back up.
    const existed = (await new SafeFs(workdir).entry("AGENTS.md")) !== null;
    const backup = await backupDiffering(
      workdir,
      personaRoot(this.d.factoryHome, ref),
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
  private async applyPendingPersona(ref: string): Promise<void> {
    const pending = personaPendingDir(this.d.factoryHome, ref);
    let data: Buffer;
    try {
      data = await readFile(path.join(pending, "AGENTS.md"));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    await this.applyPersona(ref, data);
    await rm(pending, { recursive: true, force: true });
  }

  /**
   * Lock contract: no Workspace method takes a lock itself except `deleteWorkspace`. Callers must hold
   * `lock.run(ref, …)` around materialize, reset-persona and prepare (createPrepareStart does so for prepare).
   */
  async prepare(i: PrepareInput): Promise<{
    workdir: string;
    configDir: string;
    mounts: Mount[];
    /** Docker only: the context `mounts` passed `checkMounts` with, for the pre-start re-check. */
    mountCheck?: MountCheckContext;
  }> {
    const workdir = this.workdir(i.ref);
    const configDir = agentConfigDir(workdir);
    const configRel = path.relative(workdir, configDir);
    const safe = new SafeFs(workdir);
    const { config, doc } = i.effective;
    await this.applyPendingPersona(i.ref);
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
    await scrubAgentFolders(workdir);
    await checkProjectSettings(workdir);
    await checkAgentFrontmatter(workdir, new Set([...skills, ...tplSkills].map((s) => s.name)));
    await linkProjects(workdir, i.grants);
    const grantedPaths = i.grants.map((g) => g.hostPath);
    const settings = buildSettings({
      tpl: doc.settings,
      handle: i.handle,
      workdir,
      permissionMode: config.permissionMode,
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
        self: i.self,
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
        manageOrg: i.manageOrg,
        descriptionWrittenBy: i.descriptionWrittenBy,
        memberUpdateSeconds: i.memberUpdateSeconds,
      }),
    );
    // Spec §11.4: mounts come only from factory-owned inputs (the template folder and the overlay in the database).
    const mountInputs = {
      workdir,
      grantedPaths,
      skillPaths: skills.map((s) => s.dir),
      templateSkillPaths: tplSkills.map((s) => s.realDir),
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
      return {
        workdir,
        configDir,
        mounts: await checkMounts(mounts, mountCheck),
        mountCheck,
      };
    }
    return { workdir, configDir, mounts };
  }
}
