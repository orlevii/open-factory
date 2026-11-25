import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import type { Mount } from "@open-factory/harness";
import { canon, forbiddenSet, isUnder } from "../library/forbidden.ts";
import { WorkspaceError } from "./safe-fs.ts";

/** The CLI bundle's fixed in-container path: the one mount whose target isn't its source (spec §11.6). */
export const CLI_BUNDLE_TARGET = "/opt/factory/bin/open-factory";

/** Spec §11.4: every mount comes from factory-owned inputs. Nothing in the agent's workdir or
 *  config dir becomes a mount; targets equal sources except the CLI bundle. */
export function buildMounts(i: {
  workdir: string;
  grantedPaths: string[];
  /** Real paths of every registered skill folder, mounted read-only. */
  skillPaths: string[];
  /** Real paths of the template's own skill folders (`resolveTemplateSkills`), mounted read-only. */
  templateSkillPaths: string[];
  cliBundle: string;
}): Mount[] {
  const all: Mount[] = [
    { source: i.workdir, target: i.workdir, readOnly: false },
    ...i.grantedPaths.map((p) => ({ source: p, target: p, readOnly: false })),
    ...i.skillPaths.map((p) => ({ source: p, target: p, readOnly: true })),
    ...i.templateSkillPaths.map((p) => ({ source: p, target: p, readOnly: true })),
    { source: i.cliBundle, target: CLI_BUNDLE_TARGET, readOnly: true },
  ];
  const seen = new Set<string>();
  return all.filter((m) => {
    if (seen.has(m.target)) return false;
    seen.add(m.target);
    return true;
  });
}

/** `/var/run/docker.sock`, `~/.docker/run/docker.sock`, and the unix path of `DOCKER_HOST` when set. */
export function dockerSocketPaths(env: NodeJS.ProcessEnv, home: string): string[] {
  const sockets = ["/var/run/docker.sock", path.join(home, ".docker/run/docker.sock")];
  const host = env.DOCKER_HOST;
  if (host?.startsWith("unix://")) sockets.push(host.slice("unix://".length));
  return sockets;
}

export class MountRefusedError extends WorkspaceError {
  constructor(
    readonly mountSource: string,
    readonly reason: string,
  ) {
    super(`Mount ${mountSource} isn't allowed: ${reason}.`);
    this.name = "MountRefusedError";
  }
}

export interface MountCheckContext {
  workdir: string;
  grantedPaths: string[];
  skillPaths: string[];
  templateSkillPaths: string[];
  /** `<FACTORY_HOME>/templates/<template>`: the only place a template skill may come from. */
  templateDir: string;
  cliBundle: string;
  factoryHome: string;
  home: string;
  dockerSockets: string[];
}

/** Spec §6.4: the template-skill exemption, by exact location. A declared path counts only when
 *  `skills/` and the entry are real folders (`lstat`, so a link fails) and the path equals
 *  `realpath(<template>/skills)/<name>` with `realpath(<template>/skills)` equal to
 *  `realpath(<template>)/skills`. Anything else is not allowed, as it was not before. */
async function validTemplateSkills(templateDir: string, declared: string[]): Promise<string[]> {
  const skills = path.join(templateDir, "skills");
  const isDir = async (p: string) => (await lstat(p).catch(() => undefined))?.isDirectory();
  if (!declared.length || !(await isDir(skills))) return [];
  let realSkills: string;
  try {
    realSkills = await realpath(skills);
    if (realSkills !== path.join(await realpath(templateDir), "skills")) return [];
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const p of declared) {
    if (p !== path.join(realSkills, path.basename(p)) || !(await isDir(p))) continue;
    out.push(p);
  }
  return out;
}

const NOT_ALLOWED_IN_FACTORY_HOME =
  "it is inside FACTORY_HOME and isn't this agent's workdir or a registered skill";

/** Spec §6.5: the GitHub skill class. `real` equals `join(realpath(<FH>/state/library/github), <id>,
 *  <sha>[, <name>])`, with every component from `<FH>/state` down a real directory (`lstat`, so a
 *  link fails). `factoryHome` is canonical. */
async function isGithubSkill(factoryHome: string, real: string): Promise<boolean> {
  const github = path.join(factoryHome, "state/library/github");
  const rel = path.relative(github, real);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return false;
  const parts = rel.split(path.sep);
  if (parts.length < 2 || parts.length > 3) return false;
  try {
    if ((await realpath(github)) !== github) return false;
    let dir = path.join(factoryHome, "state");
    for (const part of [undefined, "library", "github", ...parts]) {
      dir = part ? path.join(dir, part) : dir;
      if (!(await lstat(dir)).isDirectory()) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Spec §11.4 (defence in depth): `realpath`s each source and refuses `/`, the host home,
 * FACTORY_HOME, FACTORY_HOME/state, a Docker socket, or an ancestor of any of them; anything under
 * FACTORY_HOME except this agent's workdir and (read-only) a real template skill
 * folder at exactly `<templates>/<template>/skills/<name>` or (read-only) a GitHub skill checkout at
 * exactly `<FH>/state/library/github/<id>/<sha>[/<name>]`; and anything that isn't exactly one
 * of the allowed kinds with the expected read-only flag and target.
 *
 * Returns the checked mounts with each source replaced by its realpath (and parity targets by the
 * same path), so Docker binds the exact path that was validated, not a link that could be swapped
 * afterwards. Bind sources resolve again at every container start, so the Docker launcher must
 * pass only these returned mounts and re-run `checkMounts` (same context) immediately before each
 * container create or start, including when it reuses an existing container.
 */
export async function checkMounts(mounts: Mount[], ctx: MountCheckContext): Promise<Mount[]> {
  const factoryHome = await canon(ctx.factoryHome);
  const forbidden = await forbiddenSet(ctx);

  const githubRoots = [
    ...new Set([
      path.join(path.resolve(ctx.factoryHome), "state/library/github"),
      path.join(factoryHome, "state/library/github"),
    ]),
  ];
  const workdir = await canon(ctx.workdir);
  const kind = async (paths: string[], readOnly: boolean, parity = true) =>
    (await Promise.all(paths.map(canon))).map((p) => ({ path: p, readOnly, parity }));
  const templateSkills = await validTemplateSkills(ctx.templateDir, ctx.templateSkillPaths);
  // Where a template skill may never be, however it got here: the factory state, the agents' workdirs,
  // and anything that contains them (their ancestors, FACTORY_HOME and the home among them).
  const stateDir = await canon(path.join(ctx.factoryHome, "state"));
  const agentsDir = await canon(path.join(ctx.factoryHome, "agents"));
  const allowed = [
    ...(await kind([ctx.workdir], false)),
    ...(await kind(ctx.grantedPaths, false)),
    ...(await kind(ctx.skillPaths, true)),
    ...(await kind(templateSkills, true)),
    ...(await kind([ctx.cliBundle], true, false)),
  ];

  const checked: Mount[] = [];
  for (const m of mounts) {
    const refuse = (reason: string) => new MountRefusedError(m.source, reason);
    if (!path.isAbsolute(m.source) || !path.isAbsolute(m.target))
      throw refuse("its source and target must be absolute paths");
    let real: string;
    try {
      real = await realpath(m.source);
    } catch (err) {
      throw refuse(`it can't be resolved (${(err as NodeJS.ErrnoException).code ?? "error"})`);
    }
    if (real === path.parse(real).root) throw refuse("it is the filesystem root");
    // A source named inside the GitHub store must still be a checkout there once resolved: a link
    // swapped in for the store, an id or a sha resolves elsewhere and a declared path alone can't excuse it.
    const isGithub = m.readOnly && (await isGithubSkill(factoryHome, real));
    if (githubRoots.some((r) => m.source === r || isUnder(m.source, r)) && !isGithub)
      throw refuse(NOT_ALLOWED_IN_FACTORY_HOME);
    for (const f of forbidden) {
      if (real === f.path) throw refuse(`it is ${f.name}`);
      if (isUnder(f.path, real)) throw refuse(`it contains ${f.name}`);
    }
    if (m.readOnly && templateSkills.includes(real)) {
      for (const f of [stateDir, agentsDir, workdir])
        if (real === f || isUnder(real, f) || isUnder(f, real))
          throw refuse("it is inside the factory state or an agent's workdir");
    } else if (isUnder(real, factoryHome) && real !== workdir && !isGithub)
      throw refuse(NOT_ALLOWED_IN_FACTORY_HOME);
    const kinds = allowed.filter((a) => a.path === real);
    if (!kinds.length) throw refuse("it isn't one of the agent's allowed mounts");
    const sameFlag = kinds.filter((a) => a.readOnly === m.readOnly);
    if (!sameFlag.length)
      throw refuse(`it must be ${kinds[0]?.readOnly ? "read-only" : "writable"}`);
    const match = sameFlag.find((a) =>
      a.parity ? m.target === m.source || m.target === real : m.target === CLI_BUNDLE_TARGET,
    );
    if (!match) throw refuse(`its target ${m.target} isn't the allowed one`);
    checked.push({
      source: real,
      target: match.parity ? real : CLI_BUNDLE_TARGET,
      readOnly: m.readOnly,
    });
  }
  return checked;
}
