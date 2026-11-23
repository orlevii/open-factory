import { realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isHostPathShape, MSG } from "@open-factory/shared";
import { FieldError } from "./errors.ts";
import { FIELD_MSG } from "./field-messages.ts";

/** `~` and `~/…` → the factory user's home (`os.homedir()`, which honours $HOME like the shell). No resolve:
 *  a host-path field must reject a relative path, not resolve it against the server's cwd. */
export function expandHome(p: string, home = os.homedir()): string {
  if (p === "~") return home;
  return p.startsWith("~/") ? path.join(home, p.slice(2)) : p;
}

/** The realpath of an existing folder on the factory's machine, or a FieldError on `field`. */
export async function resolveHostFolder(
  field: string,
  input: string,
  home = os.homedir(),
): Promise<string> {
  const t = input.trim();
  // The same shape rule as the web's checkHostPath (one definition, owner plan review N1).
  if (!isHostPathShape(t)) throw new FieldError(field, MSG.hostPathStart);
  const p = expandHome(t, home);
  const missing = () => new FieldError(field, FIELD_MSG.noFolder);
  try {
    const real = await realpath(p);
    if (!(await stat(real)).isDirectory()) throw missing();
    return real;
  } catch (err) {
    throw err instanceof FieldError ? err : missing();
  }
}
