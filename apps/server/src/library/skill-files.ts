/**
 * What the Library shows of one skill folder's contents (spec §9.1): its file list, its `SKILL.md`, and
 * single text files. Nothing here follows a link or leaves the folder.
 */
import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import path from "node:path";
import { normalizeSubpath } from "@open-factory/shared";
import { ApiError } from "../errors.ts";

export const FILE_LIST_CAP = 2000;
export const TEXT_CAP = 256 * 1024;

export const FILE_MSG = {
  notInSkill: "Not a file in this skill.",
  link: "It's a link.",
  binary: "Not a text file.",
  tooLarge: "File is over 256 KB.",
} as const;

const refuse = (message: string) =>
  new ApiError(400, "validation_error", message, { fields: { path: message } });

/** The skill's files, sorted, at most 2,000, links and `.git` left out; executables marked. */
export async function listSkillFiles(
  dir: string,
): Promise<Array<{ path: string; executable: boolean }>> {
  const out: Array<{ path: string; executable: boolean }> = [];
  const walk = async (d: string, rel: string): Promise<void> => {
    const entries = await readdir(d, { withFileTypes: true }).catch(() => []);
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (out.length >= FILE_LIST_CAP) return;
      if (e.name.toLowerCase() === ".git") continue;
      const p = path.join(d, e.name);
      const r = rel === "" ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) await walk(p, r);
      else if (e.isFile()) {
        const st = await lstat(p).catch(() => undefined);
        if (st?.isFile()) out.push({ path: r, executable: (st.mode & 0o111) !== 0 });
      }
    }
  };
  await walk(dir, "");
  return out;
}

/** Reads at most `cap + 1` bytes of a regular file, refusing a link at the file itself; null when it can't be read. */
export async function readCapped(file: string, cap: number): Promise<Buffer | null> {
  let fh: Awaited<ReturnType<typeof open>> | undefined;
  try {
    // O_NONBLOCK: opening a FIFO without a writer would otherwise hang; the isFile check below refuses it.
    fh = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    if (!(await fh.stat()).isFile()) return null;
    const buf = Buffer.alloc(cap + 1);
    const { bytesRead } = await fh.read(buf, 0, cap + 1, 0);
    return buf.subarray(0, bytesRead);
  } catch {
    return null;
  } finally {
    await fh?.close();
  }
}

/** `SKILL.md`'s text cut to 256 KB (on a character boundary, `cut` says it was); empty when it can't be read. */
export async function readSkillMdText(dir: string): Promise<{ text: string; cut: boolean }> {
  const buf = await readCapped(path.join(dir, "SKILL.md"), TEXT_CAP);
  if (!buf) return { text: "", cut: false };
  let text = new TextDecoder().decode(buf.subarray(0, TEXT_CAP));
  while (Buffer.byteLength(text) > TEXT_CAP) text = text.slice(0, -1);
  return { text, cut: buf.length > TEXT_CAP };
}

/**
 * One text file inside the skill. `rel` is a `/`-separated path under `dir`. Refused: a path that isn't
 * one (absolute, `..`, backslash), any link on the way, a binary file and one over 256 KB.
 */
export async function readSkillFile(dir: string, rel: string): Promise<string> {
  const clean = normalizeSubpath(rel);
  if (clean === null || clean === "") throw refuse(FILE_MSG.notInSkill);
  // The listing hides `.git` (a clone's config may hold remote credentials), so the file route does too.
  if (clean.split("/").some((part) => part.toLowerCase() === ".git"))
    throw refuse(FILE_MSG.notInSkill);
  let cur = dir;
  for (const part of clean.split("/")) {
    cur = path.join(cur, part);
    const st = await lstat(cur).catch(() => undefined);
    if (!st) throw new ApiError(404, "not_found", "Not found");
    if (st.isSymbolicLink()) throw refuse(FILE_MSG.link);
  }
  const last = await lstat(cur).catch(() => undefined);
  if (!last?.isFile()) throw refuse(FILE_MSG.notInSkill);
  const buf = await readCapped(cur, TEXT_CAP);
  if (!buf) throw refuse(FILE_MSG.notInSkill);
  if (buf.length > TEXT_CAP) throw refuse(FILE_MSG.tooLarge);
  if (buf.includes(0)) throw refuse(FILE_MSG.binary);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    throw refuse(FILE_MSG.binary);
  }
}
