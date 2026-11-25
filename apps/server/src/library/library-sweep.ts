/**
 * The Library's purges (spec §9.4): previews older than an hour, soft-deleted sources past their Undo
 * window, and cache dirs nothing points at. Everything runs under `libraryLock`. A cache dir that a
 * loaded runtime's `started.library` still references is kept, and retried on the next timer.
 */
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { removeTree } from "./git-fetch.ts";
import { LIBRARY_KEY, libraryLock } from "./locks.ts";
import { type SourcesService, type SourcesStore, UNDO_MS } from "./sources-service.ts";

const PREVIEW_MAX_AGE_MS = 60 * 60 * 1000;
const HOURLY_MS = 60 * 60 * 1000;

export interface SweepDeps {
  sources: SourcesService;
  store: SourcesStore;
  factoryHome: string;
  /** Directories the loaded runtimes' `started.library` reference. */
  inUse: () => string[] | Promise<string[]>;
  now?: () => Date;
  undoMs?: number;
  /** Called after rows were purged (the `library_changed` frame). */
  publish?: () => void;
  log?: (message: string, err: unknown) => void;
}

const within = (dir: string, p: string) => p === dir || p.startsWith(dir + path.sep);

/**
 * The cache directories the given running processes still use (spec §9.4): `started.library` records a GitHub skill
 * as `github:<sha>`, so every `<githubRoot>/<source id>/<sha>` for those hashes is held. Holding a same-hash directory
 * of another source too only delays its purge to the next timer.
 */
export async function skillDirsInUse(
  githubRoot: string,
  started: { library: { skills: Record<string, string> } }[],
): Promise<string[]> {
  const shas = new Set(
    started
      .flatMap((s) => Object.values(s.library.skills))
      .filter((ref) => ref.startsWith("github:"))
      .map((ref) => ref.slice("github:".length)),
  );
  if (shas.size === 0) return [];
  const ids = await readdir(githubRoot).catch(() => [] as string[]);
  return ids.flatMap((id) => [...shas].map((sha) => path.join(githubRoot, id, sha)));
}

export class LibrarySweep {
  private readonly now: () => Date;
  private readonly undoMs: number;
  private timers = new Set<NodeJS.Timeout>();
  private running = new Set<Promise<void>>();
  private stopped = false;

  constructor(private readonly d: SweepDeps) {
    this.now = d.now ?? (() => new Date());
    this.undoMs = d.undoMs ?? UNDO_MS;
  }

  start(): void {
    this.stopped = false;
    const t = setInterval(() => this.run(() => this.purge()), HOURLY_MS);
    t.unref();
    this.timers.add(t);
  }

  /** A one-shot purge `ms` from now: the end of an Undo window (spec §9.4). */
  purgeAfter(ms: number): void {
    if (this.stopped) return;
    const t = setTimeout(() => {
      this.timers.delete(t);
      this.run(() => this.purge());
    }, ms + 250);
    t.unref();
    this.timers.add(t);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const t of this.timers) {
      clearInterval(t);
      clearTimeout(t);
    }
    this.timers.clear();
    await Promise.allSettled([...this.running]);
  }

  private run(fn: () => Promise<void>): void {
    const p = fn()
      .catch((e) => this.d.log?.("library purge failed", e))
      .finally(() => this.running.delete(p));
    this.running.add(p);
  }

  /** Boot: no Undo survives a restart and no preview's metadata does, so everything of both goes. */
  async bootPurge(): Promise<void> {
    await this.purge({ boot: true });
    this.d.sources.repairInBackground();
  }

  async purge(o: { boot?: boolean } = {}): Promise<void> {
    const changed = await libraryLock.run(LIBRARY_KEY, async () => {
      await this.purgePreviews(o.boot === true);
      const rows = await this.d.sources.rows();
      let any = false;
      const now = this.now().getTime();
      for (const s of rows) {
        if (s.deletedAt === null) continue;
        if (!o.boot && s.deletedAt.getTime() + this.undoMs > now) continue;
        const dir = path.join(this.d.sources.githubRoot, s.id);
        if (await this.referenced(dir)) continue;
        // One row that can't be removed doesn't stop the rest; the next timer retries it.
        try {
          await removeTree(dir);
          await this.d.store.delete(s.id);
          any = true;
        } catch (e) {
          this.d.log?.(`purging source ${s.id} failed`, e);
        }
      }
      await this.purgeCaches();
      return any;
    });
    if (changed) this.d.publish?.();
    this.d.sources.dropOldPreviewMeta();
  }

  private async referenced(dir: string): Promise<boolean> {
    return (await this.d.inUse()).some((p) => within(dir, p));
  }

  private async purgePreviews(all: boolean): Promise<void> {
    const root = this.d.sources.previewRoot;
    const cutoff = this.now().getTime() - PREVIEW_MAX_AGE_MS;
    for (const name of await readdir(root).catch(() => [] as string[])) {
      const p = path.join(root, name);
      const st = await stat(p).catch(() => undefined);
      if (!st || !(all || st.mtimeMs < cutoff)) continue;
      await removeTree(p).catch((e) => this.d.log?.(`removing preview ${name} failed`, e));
    }
  }

  /** Cache dirs of rows that are gone, and pins an update replaced, unless a runtime still uses them. */
  private async purgeCaches(): Promise<void> {
    const root = this.d.sources.githubRoot;
    const rows = new Map((await this.d.sources.rows()).map((s) => [s.id, s]));
    for (const id of await readdir(root).catch(() => [] as string[])) {
      const row = rows.get(id);
      const idDir = path.join(root, id);
      if (!row) {
        if (!(await this.referenced(idDir))) {
          await removeTree(idDir).catch((e) => this.d.log?.(`removing cache ${id} failed`, e));
        }
        continue;
      }
      for (const sha of await readdir(idDir).catch(() => [] as string[])) {
        const dir = path.join(idDir, sha);
        if (sha === row.commit || (await this.referenced(dir))) continue;
        await removeTree(dir).catch((e) => this.d.log?.(`removing cache ${id}/${sha} failed`, e));
      }
    }
  }
}
