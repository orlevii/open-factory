import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { constants } from "node:fs";
import {
  type FileHandle,
  lstat,
  mkdir,
  open,
  readlink,
  rename,
  rm,
  symlink,
  unlink,
} from "node:fs/promises";
import path from "node:path";

export class WorkspaceError extends Error {
  constructor(
    message: string,
    readonly fix?: "projects" | "edit_agent" | "resync",
  ) {
    super(message);
    this.name = "WorkspaceError";
  }
}

/** A component the factory expects to be a real folder or file is a symlink (spec §11.4 part 3). */
export class UnsafePathError extends WorkspaceError {
  constructor(readonly unsafePath: string) {
    super(`${unsafePath} is a symlink; the factory won't write through it.`);
    this.name = "UnsafePathError";
  }
}

const enoent = (err: unknown) => (err as NodeJS.ErrnoException).code === "ENOENT";

async function lstatOrNull(p: string): Promise<Stats | null> {
  try {
    return await lstat(p);
  } catch (err) {
    if (enoent(err)) return null;
    throw err;
  }
}

// O_NOFOLLOW makes open fail (ELOOP) when the final component is a symlink; O_NONBLOCK keeps a
// planted FIFO from blocking the open (harmless for regular files).
const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

/**
 * Every host-side write, copy or delete under an agent's workdir goes through this class. The
 * workdir is agent-writable, so any component below it may be a symlink the agent planted to
 * redirect a factory write (`.claude-config` → a host dir) or read (`AGENTS.md` → a key file).
 *
 * What it guarantees: before each operation every component between `root` and the target's parent
 * is `lstat`ed and must be a real directory (a symlink throws `UnsafePathError`), the root itself
 * included. Final components are never followed: writes go to a fresh `wx` temp file in the checked
 * parent and are `rename`d into place (rename replaces a link, never writes through it); reads and
 * copies open with `O_NOFOLLOW`; factory links are replaced by rename and only links are removed.
 *
 * What it doesn't (TOCTOU): the walk and the operation are separate syscalls, so a process that
 * can write the workdir *concurrently* could swap a checked directory for a link in between. The
 * final component is race-free (O_NOFOLLOW, O_EXCL temp, rename); the parents are not (Node has no
 * openat/O_BENEATH). That race is closed by the caller, not here: Docker agents are prepared only
 * with their container stopped, and re-sync stages its files when the agent may be running (spec
 * §11.4 part 4), so no agent process runs while these writes happen. A local agent is no boundary
 * (it runs as the host user) and gets the same code.
 */
export class SafeFs {
  constructor(readonly root: string) {}

  private abs(rel: string): string {
    const abs = path.resolve(this.root, rel);
    const r = path.relative(this.root, abs);
    if (!r || r.startsWith("..") || path.isAbsolute(r)) {
      throw new WorkspaceError(`${rel} isn't a path inside ${this.root}.`);
    }
    return abs;
  }

  /** The root plus each folder component between it and `abs` (exclusive). */
  private chain(abs: string): string[] {
    const out = [this.root];
    let cur = this.root;
    for (const part of path.relative(this.root, path.dirname(abs)).split(path.sep)) {
      if (!part) continue;
      cur = path.join(cur, part);
      out.push(cur);
    }
    return out;
  }

  private static checkDir(p: string, st: Stats): void {
    if (st.isSymbolicLink()) throw new UnsafePathError(p);
    if (!st.isDirectory()) throw new WorkspaceError(`${p} isn't a folder; move it away.`);
  }

  /** Walks the parents; false when one is missing (nothing below it exists). */
  private async walk(abs: string): Promise<boolean> {
    for (const dir of this.chain(abs)) {
      const st = await lstatOrNull(dir);
      if (!st) return false;
      SafeFs.checkDir(dir, st);
    }
    return true;
  }

  /** lstat every component between root and target's parent; each must be a real directory. */
  async assertParents(rel: string): Promise<void> {
    const abs = this.abs(rel);
    if (!(await this.walk(abs))) {
      throw Object.assign(new Error(`${path.dirname(abs)} is missing.`), { code: "ENOENT" });
    }
  }

  /** The entry's own lstat after checking its parents; null when it or a parent is missing. */
  async entry(rel: string): Promise<Stats | null> {
    const abs = this.abs(rel);
    if (!(await this.walk(abs))) return null;
    return lstatOrNull(abs);
  }

  /** Creates `rel` and its missing parents one level at a time, refusing any symlink on the way. */
  async mkdirp(rel: string): Promise<void> {
    const abs = this.abs(rel);
    for (const dir of [...this.chain(abs), abs]) {
      let st = await lstatOrNull(dir);
      if (!st) {
        await mkdir(dir).catch((err: NodeJS.ErrnoException) => {
          if (err.code !== "EEXIST") throw err;
        });
        st = await lstat(dir);
      }
      SafeFs.checkDir(dir, st);
    }
  }

  private async ensureParent(rel: string): Promise<string> {
    const abs = this.abs(rel);
    const parent = path.dirname(abs);
    if (parent === this.root) await this.walk(abs);
    else await this.mkdirp(path.relative(this.root, parent));
    return abs;
  }

  /** temp (wx) + rename. An existing symlink at `rel` is replaced, never written through. */
  async writeFile(rel: string, data: string | Buffer, mode?: number): Promise<void> {
    const abs = await this.ensureParent(rel);
    const tmp = `${abs}.tmp-${randomUUID()}`;
    let fh: FileHandle | undefined;
    try {
      fh = await open(tmp, "wx", mode === undefined ? 0o666 : 0o600);
      await fh.writeFile(data);
      if (mode !== undefined) await fh.chmod(mode);
      await fh.close();
      fh = undefined;
      await rename(tmp, abs);
    } catch (err) {
      await fh?.close().catch(() => {});
      await rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
  }

  /** Create/replace a factory-made symlink; an existing non-symlink entry fails. */
  async link(rel: string, target: string): Promise<void> {
    const abs = await this.ensureParent(rel);
    const st = await lstatOrNull(abs);
    if (st && !st.isSymbolicLink()) {
      throw new WorkspaceError(`${abs} exists and isn't a link; move it away.`);
    }
    const tmp = `${abs}.tmp-${randomUUID()}`;
    try {
      await symlink(target, tmp);
      await rename(tmp, abs);
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
  }

  /** Only removes a symlink; missing is fine, anything else fails. */
  async removeLink(rel: string): Promise<void> {
    const st = await this.entry(rel);
    if (!st) return;
    const abs = this.abs(rel);
    if (!st.isSymbolicLink()) throw new WorkspaceError(`${abs} isn't a link; move it away.`);
    await unlink(abs);
  }

  /** Copy for backups: a symlink source is copied as a symlink (never its target's bytes).
   *  `dest` is factory-owned (outside the root) and must not exist (EEXIST otherwise). */
  async copyOut(rel: string, dest: string): Promise<void> {
    const abs = this.abs(rel);
    const st = await this.entry(rel);
    if (!st) throw Object.assign(new Error(`${abs} is missing.`), { code: "ENOENT" });
    if (st.isSymbolicLink()) {
      await symlink(await readlink(abs), dest);
      return;
    }
    const data = await this.readIfRegular(rel);
    if (!data) throw new WorkspaceError(`${abs} isn't a file; move it away.`);
    const fh = await open(dest, "wx", st.mode & 0o777);
    try {
      await fh.writeFile(data);
    } finally {
      await fh.close();
    }
  }

  /** Moves a real (non-link) entry out to factory-owned `dest`, which must not exist. A rename
   *  moves the entry itself and never follows anything inside it. */
  async moveOut(rel: string, dest: string): Promise<void> {
    const abs = this.abs(rel);
    const st = await this.entry(rel);
    if (!st) throw Object.assign(new Error(`${abs} is missing.`), { code: "ENOENT" });
    if (st.isSymbolicLink()) throw new UnsafePathError(abs);
    if (await lstatOrNull(dest)) {
      throw Object.assign(new Error(`${dest} already exists.`), { code: "EEXIST" });
    }
    await rename(abs, dest);
  }

  /** undefined for missing, a symlink, or anything that isn't a regular file. */
  async readIfRegular(rel: string): Promise<Buffer | undefined> {
    const abs = this.abs(rel);
    if (!(await this.walk(abs))) return undefined;
    let fh: FileHandle;
    try {
      fh = await open(abs, READ_FLAGS);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ELOOP" || code === "EISDIR" || code === "ENXIO")
        return undefined;
      throw err;
    }
    try {
      if (!(await fh.stat()).isFile()) return undefined;
      return await fh.readFile();
    } finally {
      await fh.close();
    }
  }

  /** Removes the whole root (create's rollback). A symlinked root is unlinked, never followed;
   *  `rm` never follows links inside the tree. */
  async removeAll(): Promise<void> {
    const st = await lstatOrNull(this.root);
    if (!st) return;
    if (st.isSymbolicLink()) await unlink(this.root);
    else await rm(this.root, { recursive: true, force: true });
  }
}
