import { randomInt } from "node:crypto";
import { HANDLE_PATTERN, RESERVED_HANDLES } from "@open-factory/shared";

const MAX = 40;
export const randomSuffix = () =>
  Array.from({ length: 4 }, () => String.fromCharCode(97 + randomInt(26))).join("");

export function spawnHandle(
  template: string,
  suffix: string | undefined,
  random: () => string = randomSuffix,
): { ok: true; handle: string; explicit: boolean } | { ok: false; message: string } {
  if (suffix?.endsWith("-")) return { ok: false, message: "A suffix can't end with a hyphen." };
  if (suffix === undefined) {
    if (template.length + 2 > MAX)
      return { ok: false, message: `Template ${template}'s name is too long to spawn from.` };
    if (template.length + 5 > MAX)
      return {
        ok: false,
        message: `Template ${template}'s name is too long for a 4-character suffix; pass a shorter suffix.`,
      };
  }
  const handle = `${template}-${suffix ?? random()}`;
  if (handle.length > MAX)
    return {
      ok: false,
      message: `${handle} is longer than ${MAX} characters; use a shorter suffix.`,
    };
  if (!HANDLE_PATTERN.test(handle) || (RESERVED_HANDLES as readonly string[]).includes(handle))
    return { ok: false, message: `@${handle} isn't a valid name; pick another suffix.` };
  return { ok: true, handle, explicit: suffix !== undefined };
}
