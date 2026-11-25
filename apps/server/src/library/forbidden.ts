import { realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MSG } from "@open-factory/shared";
import { FieldError } from "../errors.ts";

export interface ForbiddenContext {
  home: string;
  factoryHome: string;
  dockerSockets: string[];
}

export interface Forbidden {
  path: string;
  name: string;
}

/** Canonical form of a path the factory names. A missing tail keeps its spelling under the
 *  canonical form of its deepest existing ancestor (a not-yet-created socket still compares right). */
export async function canon(p: string): Promise<string> {
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

export const isUnder = (child: string, parent: string) =>
  child !== parent && child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);

/** The account's home from the user database, which `$HOME` can't override. */
function userDbHome(): string | undefined {
  try {
    return os.userInfo().homedir || undefined;
  } catch {
    return undefined;
  }
}

/** Spec §6.1 and §6.5, one list for the skill folder check and `checkMounts` so they can't drift:
 *  the host home (`$HOME` and the user-db home), FACTORY_HOME, its state directory and each Docker
 *  socket. A source may be none of them, and may contain none of them. */
export async function forbiddenSet(ctx: ForbiddenContext): Promise<Forbidden[]> {
  const forbidden: Forbidden[] = [];
  const forbid = async (p: string, name: string) => {
    // Both spellings: the raw path is what a mount of an unresolvable or linked path would name.
    for (const q of new Set([path.resolve(p), await canon(p)])) forbidden.push({ path: q, name });
  };
  for (const h of new Set([ctx.home, userDbHome()]))
    if (h) await forbid(h, "the host home directory");
  await forbid(ctx.factoryHome, "FACTORY_HOME");
  await forbid(path.join(ctx.factoryHome, "state"), "the factory state directory");
  for (const s of ctx.dockerSockets) await forbid(s, "a Docker socket");
  return forbidden;
}

/** Spec §6.1: refuses `/`, the home and its ancestors, FACTORY_HOME, anything under it and its
 *  ancestors, and a Docker socket and its ancestors. `real` is the realpath of an existing folder. */
export async function checkSkillFolder(real: string, ctx: ForbiddenContext): Promise<void> {
  if (real === path.parse(real).root) throw new FieldError("path", MSG.folderShare);
  for (const f of await forbiddenSet(ctx)) {
    const hit =
      real === f.path ||
      isUnder(f.path, real) ||
      (f.name === "FACTORY_HOME" && isUnder(real, f.path));
    if (!hit) continue;
    throw new FieldError(
      "path",
      f.name === "the host home directory"
        ? MSG.folderHome
        : f.name === "a Docker socket"
          ? MSG.folderShare
          : MSG.folderFactory,
    );
  }
}
