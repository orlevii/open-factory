import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  type FileHandle,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rm,
  unlink,
} from "node:fs/promises";
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

/** Test seams between the lstat walk and the syscall it guards (a swap there is what the post-checks catch). */
export interface StoreHooks {
  beforeOpen?: (abs: string) => Promise<void>;
  beforeLink?: (abs: string) => Promise<void>;
  beforeUnlink?: (abs: string) => Promise<void>;
}

const sameInode = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino;

/**
 * Uploads in an agent's workdir (U3 §13.5). The workdir is agent-writable (a Docker agent's mount is read-write and
 * the agent may run during an upload), so every step assumes the agent may plant or swap links:
 * - the workdir is resolved with `realpath` and must not itself be a link;
 * - `.factory` and `.factory/uploads` are `lstat`ed on every call (through `SafeFs`) and refused when they are links;
 * - Node has no `openat`, so the walk and the open are separate syscalls. Every create is therefore verified after it
 *   happens and **before any byte is written**: the open fd's dev/ino must equal `lstat` of the path, and the parent's
 *   realpath must equal `<workdir>/.factory/uploads` exactly. Bytes go through that verified fd, so content can't land
 *   anywhere else; the final name made by `link()` (which never replaces or follows an entry) is verified the same way;
 * - reads open with `O_NOFOLLOW`, need a regular single-link file of the row's size and sha256, and read at most that
 *   many bytes.
 * Files are 0644 and folders 0755 whatever the server's umask, so a Docker agent's uid can read them.
 */
export class UploadStore {
  private readonly fs: SafeFs;
  private readonly uploadsAbs: string;
  private constructor(
    readonly root: string,
    private readonly hooks: StoreHooks,
  ) {
    this.fs = new SafeFs(root);
    this.uploadsAbs = path.join(root, UPLOADS_DIR);
  }

  /**
   * The store over the workdir's real path: its parent is resolved with `realpath` (a symlinked FACTORY_HOME is fine),
   * the workdir entry itself must be a real folder. Nothing is created here; a missing workdir throws ENOENT.
   */
  static async open(workdir: string, hooks: StoreHooks = {}): Promise<UploadStore> {
    const abs = path.resolve(workdir);
    const st = await lstat(abs);
    if (st.isSymbolicLink()) throw new UnsafePathError(abs);
    if (!st.isDirectory()) throw new WorkspaceError(`${abs} isn't a folder.`);
    const root = path.join(await realpath(path.dirname(abs)), path.basename(abs));
    if ((await realpath(abs)) !== root) throw new UnsafePathError(abs);
    return new UploadStore(root, hooks);
  }

  /** Throws `UnsafePathError` unless `abs` is still the inode `fst` and sits directly in the real uploads folder. */
  private async verifyPlaced(abs: string, fst: Stats): Promise<void> {
    const lst = await lstat(abs).catch(() => undefined);
    const parent = await realpath(path.dirname(abs)).catch(() => undefined);
    if (lst && sameInode(lst, fst) && parent === this.uploadsAbs) return;
    // Only ever unlink the very inode we created (reached through whatever the path resolves to now).
    if (lst && sameInode(lst, fst)) await unlink(abs).catch(() => {});
    throw new UnsafePathError(path.join(this.root, ".factory"));
  }

  /** Creates `.factory/uploads/` (0755) one level at a time, refusing any link on the way, verifying each folder. */
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
      // The folder as opened (never through a final link) must be the one at the path, at its expected real place.
      let fh: FileHandle;
      try {
        fh = await open(abs, DIR_FLAGS);
      } catch (err) {
        if (code(err) === "ELOOP" || code(err) === "ENOTDIR") throw new UnsafePathError(abs);
        throw err;
      }
      try {
        const fst = await fh.stat();
        const lst = await lstat(abs);
        if (!sameInode(fst, lst) || (await realpath(abs)) !== abs) throw new UnsafePathError(abs);
        // The umask narrowed mkdir's mode; fix it on the directory itself.
        if (created) await fh.chmod(0o755);
      } finally {
        await fh.close();
      }
    }
  }

  /**
   * Streams `source` into a fresh temp file, counting bytes (over `limit` throws `UploadTooLargeError`), hashing and
   * sniffing as it goes, then links it into place as `.factory/uploads/<storedName>`. A refused type returns the
   * refusal. On any failure the temp file is deleted; a swapped folder throws `UnsafePathError` before any byte is
   * written (and again after the link).
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
    const finalAbs = path.join(this.root, rel);
    let fh: FileHandle | undefined;
    let fst: Stats | undefined;
    try {
      await this.fs.assertParents(tmpRel);
      await this.hooks.beforeOpen?.(tmpAbs);
      fh = await open(tmpAbs, WRITE_FLAGS, 0o644);
      fst = await fh.stat();
      await this.verifyPlaced(tmpAbs, fst); // before any byte
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
      const sniffed = sniffer.finish(o.name);
      if ("status" in sniffed) return sniffed;
      await this.fs.assertParents(rel);
      await this.hooks.beforeLink?.(finalAbs);
      try {
        await link(tmpAbs, finalAbs);
      } catch (err) {
        if (code(err) === "EEXIST") throw new UploadExistsError(rel);
        if (code(err) === "ENOENT" || code(err) === "ENOTDIR")
          throw new UnsafePathError(path.join(this.root, ".factory"));
        throw err;
      }
      await this.verifyPlaced(finalAbs, fst);
      return { rel, bytes, sha256: hash.digest("hex"), sniffed };
    } finally {
      await fh?.close().catch(() => {});
      // The temp name is ours (O_EXCL); after a link it is the second name of the placed file. Removed only while the
      // path still reaches our inode (wherever a swap moved its folder); otherwise the sweep collects it.
      if (fst) {
        const lst = await lstat(tmpAbs).catch(() => undefined);
        if (lst && sameInode(lst, fst)) await rm(tmpAbs, { force: true }).catch(() => {});
      }
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
      // Bounded by the row's size: a file that grew after the fstat is refused, never read whole.
      const data = Buffer.alloc(expected.bytes);
      let got = 0;
      while (got < expected.bytes) {
        const { bytesRead } = await fh.read(data, got, expected.bytes - got, got);
        if (bytesRead === 0) return undefined;
        got += bytesRead;
      }
      const probe = await fh.read(Buffer.alloc(1), 0, 1, expected.bytes);
      if (probe.bytesRead !== 0) return undefined;
      if (createHash("sha256").update(data).digest("hex") !== expected.sha256) return undefined;
      return data;
    } finally {
      await fh.close();
    }
  }

  /**
   * Housekeeping (review M2): regular files in `.factory/uploads/` that no row references — an upload's file older than
   * `orphanBefore` whose id isn't in `known`, and a `.tmp-*` older than `tmpBefore`. Names the factory didn't make are
   * left alone; links and folders are never touched. Returns how many were deleted.
   */
  async sweepFiles(o: {
    known: Set<string>;
    orphanBefore: Date;
    tmpBefore: Date;
  }): Promise<number> {
    const dir = await this.fs.entry(UPLOADS_DIR);
    if (!dir) return 0;
    if (!dir.isDirectory()) return 0;
    let n = 0;
    for (const name of await readdir(this.uploadsAbs)) {
      const rel = `${UPLOADS_DIR}/${name}`;
      const tmp = /^\.tmp-[0-9a-f-]{36}$/.test(name);
      const id = /^\d{8}-([0-9a-f-]{36})-/.exec(name)?.[1];
      if (!tmp && !id) continue;
      const st = await this.fs.entry(rel);
      if (!st?.isFile()) continue;
      const stale = tmp
        ? st.mtime < o.tmpBefore
        : st.mtime < o.orphanBefore && !o.known.has(id as string);
      if (!stale) continue;
      if (await this.unlinkChecked(rel, st).catch(() => false)) n++;
    }
    return n;
  }

  /** Deletes the entry itself (a planted link is unlinked, never followed); missing is fine. */
  async remove(rel: string): Promise<void> {
    checkRel(rel);
    const st = await this.fs.entry(rel);
    if (!st) return;
    if (st.isDirectory()) throw new WorkspaceError(`${path.join(this.root, rel)} is a folder.`);
    await this.unlinkChecked(rel, st);
  }

  /**
   * Review m1: unlink by path is a separate syscall from the walk, so right before it the parent must still resolve to
   * the real uploads folder and the entry must still be the inode the walk saw. A swap in between refuses (or skips,
   * in the sweep) instead of unlinking a same-named entry elsewhere. Returns whether the entry was unlinked.
   */
  private async unlinkChecked(rel: string, seen: Stats): Promise<boolean> {
    const abs = path.join(this.root, rel);
    await this.hooks.beforeUnlink?.(abs);
    if ((await realpath(path.dirname(abs)).catch(() => undefined)) !== this.uploadsAbs)
      throw new UnsafePathError(path.join(this.root, ".factory"));
    const now = await lstat(abs).catch(() => undefined);
    if (!now) return false;
    if (!sameInode(now, seen)) throw new UnsafePathError(abs);
    try {
      await unlink(abs);
      return true;
    } catch (err) {
      if (code(err) === "ENOENT") return false;
      throw err;
    }
  }
}
