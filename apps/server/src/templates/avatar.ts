import { constants } from "node:fs";
import { type FileHandle, lstat, open, realpath } from "node:fs/promises";
import path from "node:path";

/** U2 §15.3: a template's `avatar.svg` larger than this is treated as absent. */
export const MAX_AVATAR_BYTES = 256 * 1024;
const AVATAR_FILE = "avatar.svg";

type Opened =
  | { kind: "file"; handle: FileHandle; version: string; size: number }
  | { kind: "tooLarge" }
  | { kind: "absent" };

const ABSENT: Opened = { kind: "absent" };

/**
 * Opens `<dir>/avatar.svg` only when it is a regular file inside `dir` (U2 §15.3). Template folders can be written by
 * unsandboxed agents, so a link could expose any file: the path must `lstat` as a regular file that is not a symbolic
 * link, its realpath must sit inside the folder's realpath, and it is opened with `O_NOFOLLOW` and `fstat`ed on the
 * handle (regular, the same inode `lstat` saw, ≤ MAX_AVATAR_BYTES), so the file can't be swapped between the checks
 * and the read. A file with more than one hard link is rejected too, and so is a folder whose realpath is outside the
 * templates `root`. Any failure counts as absent. The caller closes the handle.
 */
async function openAvatar(dir: string, root?: string): Promise<Opened> {
  const file = path.join(dir, AVATAR_FILE);
  let handle: FileHandle | undefined;
  try {
    const l = await lstat(file);
    if (!l.isFile() || l.isSymbolicLink()) return ABSENT;
    const [realDir, realFile] = await Promise.all([realpath(dir), realpath(file)]);
    if (!realFile.startsWith(realDir + path.sep)) return ABSENT;
    // The folder itself may be a link: with a templates root, its realpath must sit inside the root's realpath.
    if (root !== undefined && !realDir.startsWith((await realpath(root)) + path.sep)) return ABSENT;
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const st = await handle.stat();
    // nlink > 1: a hard link could alias a file outside the folder (links can't be told apart from the original).
    if (!st.isFile() || st.nlink > 1 || st.dev !== l.dev || st.ino !== l.ino) {
      await handle.close();
      return ABSENT;
    }
    if (st.size > MAX_AVATAR_BYTES) {
      await handle.close();
      return { kind: "tooLarge" };
    }
    return { kind: "file", handle, version: `${Math.trunc(st.mtimeMs)}-${st.size}`, size: st.size };
  } catch {
    await handle?.close().catch(() => {});
    return ABSENT;
  }
}

/** `"<mtimeMs>-<size>"` of the template's avatar, or null when it is absent (any check failing) or too large. */
export async function avatarStat(
  dir: string,
  root?: string,
): Promise<{ version: string | null; tooLarge: boolean }> {
  const o = await openAvatar(dir, root);
  if (o.kind !== "file") return { version: null, tooLarge: o.kind === "tooLarge" };
  await o.handle.close().catch(() => {});
  return { version: o.version, tooLarge: false };
}

/** The avatar's bytes, read from the same `O_NOFOLLOW` handle the checks ran on; null when absent or too large. */
export async function readAvatar(
  dir: string,
  root?: string,
): Promise<{ version: string; body: Buffer } | null> {
  const o = await openAvatar(dir, root);
  if (o.kind !== "file") return null;
  try {
    // Read at most one byte past the checked size: a file growing after the fstat is never read past the cap.
    const buf = Buffer.alloc(Math.min(o.size + 1, MAX_AVATAR_BYTES + 1));
    let n = 0;
    while (n < buf.length) {
      const { bytesRead } = await o.handle.read(buf, n, buf.length - n, n);
      if (bytesRead === 0) break;
      n += bytesRead;
    }
    if (n !== o.size) return null; // changed under us: treat as absent rather than serve a torn read
    return { version: o.version, body: buf.subarray(0, n) };
  } catch {
    return null;
  } finally {
    await o.handle.close().catch(() => {});
  }
}
