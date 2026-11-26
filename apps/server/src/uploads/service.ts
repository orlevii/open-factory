import { randomUUID } from "node:crypto";
import { type AgentRow, type Db, schema, type UploadRow } from "@open-factory/db";
import { and, count, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import type { RuntimeLog } from "../agents/agent-runtime.ts";
import { principalById } from "../principals/principal-store.ts";
import type { KeyedMutex } from "../workspace/lock.ts";
import { agentWorkdir } from "../workspace/paths.ts";
import { excludeFactoryDir } from "./git-exclude.ts";
import { storedUploadName } from "./names.ts";
import { type ImageMime, type Refusal, sniffType, type TEXT_MIME } from "./sniff.ts";
import { type StoreHooks, UploadStore } from "./store.ts";

const { uploads, agentProjectGrants, projects } = schema;

/** U3 §13.5 (Q42): an upload never attached to a sent message is deleted after this long. */
export const UNSENT_TTL_MS = 24 * 3_600_000;
/** A temp name older than this belongs to no stream in progress. */
const TMP_TTL_MS = 3_600_000;

export type UploadInfo = {
  uploadId: string;
  kind: "image" | "text";
  bytes: number;
  width?: number;
  height?: number;
  name: string;
};
export const uploadInfo = (r: UploadRow): UploadInfo => ({
  uploadId: r.id,
  kind: r.kind,
  bytes: r.bytes,
  ...(r.width !== null ? { width: r.width } : {}),
  ...(r.height !== null ? { height: r.height } : {}),
  name: r.originalName,
});

/** Review M1/m3: per (agent, uploader) unsent caps; concurrent streams per (agent, uploader) and per agent. */
export const MAX_UNSENT_FILES = 20;
export const MAX_UNSENT_BYTES = 200 * 1024 * 1024;
export const MAX_IN_FLIGHT_PER_UPLOADER = 3;
export const MAX_IN_FLIGHT_PER_AGENT = 6;

/** Too many unsent uploads, or too many streaming at once (429 `too_many_uploads`). */
export class UploadLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UploadLimitError";
  }
}

/** The agent ended while the upload streamed: its partial file was deleted. */
export class UploadAgentEndedError extends Error {
  constructor(
    readonly code: "agent_archived" | "agent_terminated",
    message: string,
  ) {
    super(message);
    this.name = "UploadAgentEndedError";
  }
}

export interface UploadServiceDeps {
  db: Db;
  factoryHome: string;
  /** The workspace lock: a terminated agent's workspace is deleted under it. */
  lock: KeyedMutex;
  log: RuntimeLog;
  now?: () => Date;
}

/** Upload rows plus their files in each agent's workdir (U3 §13.5). */
export class UploadService {
  constructor(private readonly d: UploadServiceDeps) {}
  /** Streams under way per agent id. */
  private readonly inFlight = new Map<string, number>();
  /** Test seam (review I1): hooks every store this service opens gets. */
  storeHooks: StoreHooks = {};

  private now(): Date {
    return this.d.now?.() ?? new Date();
  }
  /** The ref the agent's workdir and workspace lock are named by (spec §4.4). */
  private async ref(agentId: string) {
    const p = await principalById(this.d.db, agentId);
    if (!p) throw new Error(`No principal ${agentId}`);
    return p.ref;
  }
  private async workdir(agentId: string) {
    return agentWorkdir(this.d.factoryHome, await this.ref(agentId));
  }

  /**
   * Streams `source` into the agent's `.factory/uploads/`, then records the row. A refused type returns the refusal;
   * over the cap throws `UploadTooLargeError`; an agent that ended meanwhile loses the file and throws
   * `UploadAgentEndedError`. On the first upload (and idempotently after), `.factory/` goes into `info/exclude`.
   */
  async create(
    agent: AgentRow,
    uploaderId: string,
    name: string,
    source: AsyncIterable<Buffer | Uint8Array>,
  ): Promise<UploadInfo | Refusal> {
    const [unsent] = await this.d.db
      .select({ n: count(), bytes: sql<string>`coalesce(sum(${uploads.bytes}), 0)` })
      .from(uploads)
      .where(
        and(
          eq(uploads.agentId, agent.id),
          eq(uploads.uploaderId, uploaderId),
          isNull(uploads.messageId),
        ),
      );
    if ((unsent?.n ?? 0) >= MAX_UNSENT_FILES || Number(unsent?.bytes ?? 0) >= MAX_UNSENT_BYTES)
      throw new UploadLimitError(
        "Too many files are waiting to be sent; send or remove some first.",
      );
    // Review m3: slots per (agent, uploader) under a per-agent total, so one slow uploader can't hold them all.
    const mine = `${agent.id}:${uploaderId}`;
    if (
      (this.inFlight.get(mine) ?? 0) >= MAX_IN_FLIGHT_PER_UPLOADER ||
      (this.inFlight.get(agent.id) ?? 0) >= MAX_IN_FLIGHT_PER_AGENT
    )
      throw new UploadLimitError("Too many uploads at once; wait for one to finish.");
    const bump = (key: string, by: number) => {
      const n = (this.inFlight.get(key) ?? 0) + by;
      if (n > 0) this.inFlight.set(key, n);
      else this.inFlight.delete(key);
    };
    bump(mine, 1);
    bump(agent.id, 1);
    try {
      return await this.createLocked(agent, uploaderId, name, source);
    } finally {
      bump(mine, -1);
      bump(agent.id, -1);
    }
  }

  private async createLocked(
    agent: AgentRow,
    uploaderId: string,
    name: string,
    source: AsyncIterable<Buffer | Uint8Array>,
  ): Promise<UploadInfo | Refusal> {
    const id = randomUUID();
    const at = this.now();
    const store = await UploadStore.open(await this.workdir(agent.id), this.storeHooks);
    const written = await store.write(source, { storedName: storedUploadName(at, id, name), name });
    if ("status" in written) return written;
    let row: UploadRow;
    try {
      row = await this.d.lock.run(await this.ref(agent.id), async () => {
        const [now] = await this.d.db
          .select()
          .from(schema.agents)
          .where(eq(schema.agents.id, agent.id));
        if (!now || now.archivedAt || now.terminatedAt || now.workspaceDeletedAt)
          throw now?.archivedAt && !now.terminatedAt
            ? new UploadAgentEndedError("agent_archived", `@${agent.slug} is archived.`)
            : new UploadAgentEndedError("agent_terminated", `@${agent.slug} was terminated.`);
        const s = written.sniffed;
        const [r] = await this.d.db
          .insert(uploads)
          .values({
            id,
            agentId: agent.id,
            uploaderId,
            storedPath: written.rel,
            originalName: name,
            kind: s.kind,
            bytes: written.bytes,
            sha256: written.sha256,
            width: s.kind === "image" ? s.width : null,
            height: s.kind === "image" ? s.height : null,
            createdAt: at,
          })
          .returning();
        if (!r) throw new Error("the upload insert returned no row");
        return r;
      });
    } catch (err) {
      // Review I2: no file without a row (the row sweep would never find it).
      await store.remove(written.rel).catch(() => {});
      throw err;
    }
    await this.exclude(agent, store.root).catch((err: unknown) =>
      this.d.log.warn({ err, agent: agent.slug }, "adding .factory/ to info/exclude failed"),
    );
    return uploadInfo(row);
  }

  /** `workdir` is the store's real path (review I3), so it compares with the realpath'd roots. */
  private async exclude(agent: AgentRow, workdir: string) {
    const grants = await this.d.db
      .select({ hostPath: projects.hostPath })
      .from(agentProjectGrants)
      .innerJoin(projects, eq(projects.id, agentProjectGrants.projectId))
      .where(eq(agentProjectGrants.agentId, agent.id));
    const outcome = await excludeFactoryDir(workdir, [workdir, ...grants.map((g) => g.hostPath)]);
    if (outcome === "refused")
      this.d.log.warn(
        { agent: agent.slug },
        "the agent's git dir is unsafe; info/exclude was not written",
      );
  }

  /** The agent's upload with this id, or undefined. */
  async get(agentId: string, id: string): Promise<UploadRow | undefined> {
    const [r] = await this.d.db
      .select()
      .from(uploads)
      .where(and(eq(uploads.id, id), eq(uploads.agentId, agentId)));
    return r;
  }

  /** The rows with these ids (any agent, any sender: the caller checks). */
  async byIds(ids: string[]): Promise<UploadRow[]> {
    if (!ids.length) return [];
    return this.d.db.select().from(uploads).where(inArray(uploads.id, ids));
  }

  /**
   * The stored bytes and their sniffed type; `gone` when the workspace no longer exists (review M5), `changed` when the
   * file is missing or isn't what was uploaded.
   */
  async read(
    agent: AgentRow,
    r: UploadRow,
  ): Promise<{ data: Buffer; mime: ImageMime | typeof TEXT_MIME } | "gone" | "changed"> {
    if (agent.workspaceDeletedAt) return "gone";
    let store: UploadStore;
    try {
      store = await UploadStore.open(await this.workdir(agent.id));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return "gone";
      return "changed";
    }
    const data = await store
      .read(r.storedPath, { bytes: r.bytes, sha256: r.sha256 })
      .catch(() => undefined);
    if (!data) return "changed";
    const s = sniffType(data);
    if ("status" in s || s.kind !== r.kind) return "changed";
    return { data, mime: s.mime };
  }

  /**
   * Deletes an unsent upload by its uploader: the row first (so a send can't claim it after its file is gone), then
   * the file. Returns what stopped it otherwise.
   */
  async removeUnsent(
    agentId: string,
    r: UploadRow,
    userId: string,
  ): Promise<"removed" | "not_uploader" | "already_sent"> {
    if (r.uploaderId !== userId) return "not_uploader";
    const gone = await this.d.db
      .delete(uploads)
      .where(and(eq(uploads.id, r.id), eq(uploads.uploaderId, userId), isNull(uploads.messageId)))
      .returning({ id: uploads.id });
    if (!gone.length) return "already_sent";
    await this.removeFile(agentId, r.storedPath);
    return "removed";
  }

  private async removeFile(agentId: string, rel: string) {
    try {
      const store = await UploadStore.open(await this.workdir(agentId));
      await store.remove(rel);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return; // the workspace is gone
      this.d.log.warn({ err, agent: agentId, path: rel }, "deleting an upload's file failed");
    }
  }

  /** Q42: unsent uploads older than 24 hours lose their row and file. Returns how many. */
  async sweepUnsent(now = this.now()): Promise<number> {
    const cutoff = new Date(now.getTime() - UNSENT_TTL_MS);
    const old = await this.d.db
      .select({ id: uploads.id, storedPath: uploads.storedPath, agentId: uploads.agentId })
      .from(uploads)
      .innerJoin(schema.agents, eq(schema.agents.id, uploads.agentId))
      .where(and(isNull(uploads.messageId), lt(uploads.createdAt, cutoff)));
    let n = 0;
    for (const r of old) {
      const gone = await this.d.db
        .delete(uploads)
        .where(and(eq(uploads.id, r.id), isNull(uploads.messageId)))
        .returning({ id: uploads.id });
      if (!gone.length) continue; // sent meanwhile
      await this.removeFile(r.agentId, r.storedPath);
      n++;
    }
    // Review M2: files no row references (a crash before the insert, a failed delete, a leftover temp name).
    const live = await this.d.db
      .select({ id: schema.agents.id, slug: schema.agents.slug })
      .from(schema.agents)
      .where(isNull(schema.agents.workspaceDeletedAt));
    for (const a of live) {
      try {
        const store = await UploadStore.open(await this.workdir(a.id));
        const rows = await this.d.db
          .select({ id: uploads.id })
          .from(uploads)
          .where(eq(uploads.agentId, a.id));
        n += await store.sweepFiles({
          known: new Set(rows.map((r) => r.id)),
          orphanBefore: cutoff,
          tmpBefore: new Date(now.getTime() - TMP_TTL_MS),
        });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
        this.d.log.warn({ err, agent: a.slug }, "sweeping an agent's upload files failed");
      }
    }
    return n;
  }
}
