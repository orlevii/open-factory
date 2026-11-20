import { realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Mount } from "@open-factory/harness";
import { WorkspaceError } from "./safe-fs.ts";

/** The CLI bundle's fixed in-container path: the one mount whose target isn't its source (spec §11.6). */
export const CLI_BUNDLE_TARGET = "/opt/factory/bin/open-factory";

/** Spec §11.4: every mount comes from factory-owned inputs. Nothing in the agent's workdir or
 *  config dir becomes a mount; targets equal sources except the CLI bundle. */
export function buildMounts(i: {
  workdir: string;
  grantedPaths: string[];
  hostSkillPaths: string[];
  /** From the factory-owned template copy only (`FACTORY_HOME/state/agents/<slug>/template`). */
  declaredMarketplaceDirs: string[];
  pluginsDir: string;
  cliBundle: string;
}): Mount[] {
  const all: Mount[] = [
    { source: i.workdir, target: i.workdir, readOnly: false },
    ...i.grantedPaths.map((p) => ({ source: p, target: p, readOnly: false })),
    ...i.hostSkillPaths.map((p) => ({ source: p, target: p, readOnly: true })),
    ...i.declaredMarketplaceDirs.map((p) => ({ source: p, target: p, readOnly: true })),
    { source: i.pluginsDir, target: i.pluginsDir, readOnly: true },
    { source: i.cliBundle, target: CLI_BUNDLE_TARGET, readOnly: true },
  ];
  const seen = new Set<string>();
  return all.filter((m) => {
    if (seen.has(m.target)) return false;
    seen.add(m.target);
    return true;
  });
}

/** The `directory` marketplaces a template's settings declare. Pass only the factory-owned copy. */
export function declaredMarketplaceDirs(tplSettings: Record<string, unknown>): string[] {
  const mk = tplSettings.extraKnownMarketplaces;
  if (!mk || typeof mk !== "object" || Array.isArray(mk)) return [];
  const dirs: string[] = [];
  for (const entry of Object.values(mk as Record<string, unknown>)) {
    const src = (entry as { source?: { source?: unknown; path?: unknown } } | null)?.source;
    if (src?.source === "directory" && typeof src.path === "string") dirs.push(src.path);
  }
  return dirs;
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
  hostSkillPaths: string[];
  declaredMarketplaceDirs: string[];
  pluginsDir: string;
  cliBundle: string;
  factoryHome: string;
  home: string;
  dockerSockets: string[];
}

/** Canonical form of a path the factory names. A missing tail keeps its spelling under the
 *  canonical form of its deepest existing ancestor (a not-yet-created socket still compares right). */
async function canon(p: string): Promise<string> {
  const abs = path.resolve(p);
  const tail: string[] = [];
  for (let dir = abs; ; dir = path.dirname(dir)) {
    try {
      return path.join(await realpath(dir), ...tail.reverse());
    } catch {
      if (dir === path.dirname(dir)) return abs;
      tail.push(path.basename(dir));
    }
  }
}

const isUnder = (child: string, parent: string) =>
  child !== parent && child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);

/** The account's home from the user database, which `$HOME` can't override. */
function userDbHome(): string | undefined {
  try {
    return os.userInfo().homedir || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Spec §11.4 (defence in depth): `realpath`s each source and refuses `/`, the host home,
 * FACTORY_HOME, FACTORY_HOME/state, a Docker socket, or an ancestor of any of them; anything under
 * FACTORY_HOME except this agent's workdir and its plugins dir; and anything that isn't exactly one
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
  const forbidden: { path: string; name: string }[] = [];
  const forbid = async (p: string, name: string) => {
    // Both spellings: the raw path is what a mount of an unresolvable or linked path would name.
    for (const q of new Set([path.resolve(p), await canon(p)])) forbidden.push({ path: q, name });
  };
  for (const h of new Set([ctx.home, userDbHome()]))
    if (h) await forbid(h, "the host home directory");
  await forbid(ctx.factoryHome, "FACTORY_HOME");
  await forbid(path.join(ctx.factoryHome, "state"), "the factory state directory");
  for (const s of ctx.dockerSockets) await forbid(s, "a Docker socket");

  const workdir = await canon(ctx.workdir);
  const pluginsDir = await canon(ctx.pluginsDir);
  const kind = async (paths: string[], readOnly: boolean, parity = true) =>
    (await Promise.all(paths.map(canon))).map((p) => ({ path: p, readOnly, parity }));
  const allowed = [
    ...(await kind([ctx.workdir], false)),
    ...(await kind(ctx.grantedPaths, false)),
    ...(await kind([...ctx.hostSkillPaths, ...ctx.declaredMarketplaceDirs, ctx.pluginsDir], true)),
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
    for (const f of forbidden) {
      if (real === f.path) throw refuse(`it is ${f.name}`);
      if (isUnder(f.path, real)) throw refuse(`it contains ${f.name}`);
    }
    if (isUnder(real, factoryHome) && real !== workdir && real !== pluginsDir)
      throw refuse("it is inside FACTORY_HOME and isn't this agent's workdir or plugins dir");
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
