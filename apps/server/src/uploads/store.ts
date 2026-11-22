import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, link, lstat, mkdir, open, realpath, rm, unlink } from "node:fs/promises";
import path from "node:path";
import { SafeFs, UnsafePathError, WorkspaceError } from "../workspace/safe-fs.ts";
import { type Refusal, type Sniffed, Sniffer } from "./sniff.ts";

/** U3 §13.5: the per-route size cap (D4), enforced while streaming. */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
export const UPLOADS_DIR = ".factory/uploads";
const DIRS = [".factory", UPLOADS_DIR] as const;
const STORED = /^[A-Za-z0-9._-]+$/;
const STORED_REL = /^\.factory\/uploads\/[A-Za-z0-9._-]+$/;

export class UploadTooLargeError extends Error {
  constructor(readonly limit: number) {
    super(`The file is larger than ${Math.round(limit / 1024 / 1024)} MB.`);
    this.name = "UploadTooLargeError";
  }
}
export class UploadExistsError extends Error {
  constructor(rel: string) {
    super(`${rel} already exists.`);
    this.name = "UploadExistsError";
  }
}

const WRITE_FLAGS =
  constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const DIR_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;

const code = (err: unknown) => (err as NodeJS.ErrnoException).code;

function checkStored(name: string): void {
  if (!STORED.test(name) || name.includes("..") || name.startsWith("."))
    throw new WorkspaceError(`${name} isn't a stored upload name.`);
}
function checkRel(rel: string): void {
  if (!STORED_REL.test(rel) || rel.slice(UPLOADS_DIR.length + 1).includes(".."))
    throw new WorkspaceError(`${rel} isn't an upload path.`);
}

export type Written = { rel: string; bytes: number; sha256: string; sniffed: Sniffed };

/**
 * Uploads in an agent's workdir (U3 §13.5). The workdir is agent-writable, so every step assumes the agent may have
 * planted links: the workdir must be its own realpath, `.factory` and `.factory/uploads` are `lstat`ed on every call
 * (through `SafeFs`) and refused when they are links, files are created with `O_CREAT | O_EXCL | O_NOFOLLOW` and moved
 * into place with `link()` (which never replaces or follows an existing entry), and reads open with `O_NOFOLLOW` and
 * must match the row's size and sha256 on a file with a single link. Files are 0644 and folders 0755 whatever the
 * server's umask, so a Docker agent's uid can read them.
 */
export class UploadStore {
  private readonly fs: SafeFs;
  private constructor(readonly root: string) {
    this.fs = new SafeFs(root);
  }

  /** Refuses a workdir that is a symlink or lies outside its own realpath (nothing is created here). */
  static async open(workdir: string): Promise<UploadStore> {
    const abs = path.resolve(workdir);
    const st = await lstat(abs);
    if (st.isSymbolicLink()) throw new UnsafePathError(abs);
    if (!st.isDirectory()) throw new WorkspaceError(`${abs} isn't a folder.`);
    if ((await realpath(abs)) !== abs) throw new UnsafePathError(abs);
    return new UploadStore(abs);
  }

  /** Creates `.factory/uploads/` (0755) one level at a time, refusing any link on the way. */
  async ensureDir(): Promise<void> {
    for (const rel of DIRS) {
      const abs = path.join(this.root, rel);
      let st = await this.fs.entry(rel); // walks and lstats every parent, the root included
      let created = false;
      if (!st) {
        try {
          await mkdir(abs, 0o755);
          created = true;
        } catch (err) {
          if (code(err) !== "EEXIST") throw err;
        }
        st = await lstat(abs);
      }
      if (st.isSymbolicLink()) throw new UnsafePathError(abs);
      if (!st.isDirectory()) throw new WorkspaceError(`${abs} isn't a folder; move it away.`);
      if (created) {
        // The umask narrowed mkdir's mode; fix it on the directory itself, never through a link.
        const fh = await open(abs, DIR_FLAGS);
        try {
          await fh.chmod(0o755);
        } finally {
          await fh.close();
        }
      }
    }
  }

  /**
   * Streams `source` into a fresh temp file, counting bytes (over `limit` throws `UploadTooLargeError`), hashing and
   * sniffing as it goes, then links it into place as `.factory/uploads/<storedName>`. A refused type returns the
   * refusal. On any failure the temp file is deleted.
   */
  async write(
    source: AsyncIterable<Buffer | Uint8Array>,
    o: { storedName: string; name: string; limit?: number },
  ): Promise<Written | Refusal> {
    checkStored(o.storedName);
    const limit = o.limit ?? MAX_UPLOAD_BYTES;
    await this.ensureDir();
    const tmpRel = `${UPLOADS_DIR}/.tmp-${randomUUID()}`;
    const tmpAbs = path.join(this.root, tmpRel);
    const rel = `${UPLOADS_DIR}/${o.storedName}`;
    let fh: FileHandle | undefined;
    try {
      await this.fs.assertParents(tmpRel);
      fh = await open(tmpAbs, WRITE_FLAGS, 0o644);
      await fh.chmod(0o644);
      const sniffer = new Sniffer();
      const hash = createHash("sha256");
      let bytes = 0;
      for await (const chunk of source) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buf.length;
        if (bytes > limit) throw new UploadTooLargeError(limit);
        sniffer.push(buf);
        hash.update(buf);
        await fh.write(buf);
      }
      await fh.close();
      fh = undefined;
      const sniffed = sniffer.finish(o.name);
      if ("status" in sniffed) return sniffed;
      await this.fs.assertParents(rel);
      try {
        await link(tmpAbs, path.join(this.root, rel));
      } catch (err) {
        if (code(err) === "EEXIST") throw new UploadExistsError(rel);
        throw err;
      }
      return { rel, bytes, sha256: hash.digest("hex"), sniffed };
    } finally {
      await fh?.close().catch(() => {});
      // The temp name is ours (O_EXCL); after a link it is the second name of the placed file.
      await rm(tmpAbs, { force: true }).catch(() => {});
    }
  }

  /** The file's bytes if it is still the regular, single-link file of `expected` size and sha256; else undefined. */
  async read(
    rel: string,
    expected: { bytes: number; sha256: string },
  ): Promise<Buffer | undefined> {
    checkRel(rel);
    const st = await this.fs.entry(rel);
    if (!st?.isFile()) return undefined;
    let fh: FileHandle;
    try {
      fh = await open(path.join(this.root, rel), READ_FLAGS);
    } catch (err) {
      if (["ENOENT", "ELOOP", "EISDIR", "ENXIO", "EMLINK"].includes(code(err) ?? ""))
        return undefined;
      throw err;
    }
    try {
      const fst = await fh.stat();
      if (!fst.isFile() || fst.nlink !== 1 || fst.size !== expected.bytes) return undefined;
      const data = await fh.readFile();
      if (data.length !== expected.bytes) return undefined;
      if (createHash("sha256").update(data).digest("hex") !== expected.sha256) return undefined;
      return data;
    } finally {
      await fh.close();
    }
  }

  /** Deletes the entry itself (a planted link is unlinked, never followed); missing is fine. */
  async remove(rel: string): Promise<void> {
    checkRel(rel);
    const st = await this.fs.entry(rel);
    if (!st) return;
    if (st.isDirectory()) throw new WorkspaceError(`${path.join(this.root, rel)} is a folder.`);
    await unlink(path.join(this.root, rel)).catch((err: unknown) => {
      if (code(err) !== "ENOENT") throw err;
    });
  }
}
