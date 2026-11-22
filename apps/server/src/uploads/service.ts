import { randomUUID } from "node:crypto";
import { type AgentRow, type Db, schema, type UploadRow } from "@open-factory/db";
import { and, eq, inArray, isNull, lt } from "drizzle-orm";
import type { RuntimeLog } from "../agents/agent-runtime.ts";
import type { KeyedMutex } from "../workspace/lock.ts";
import { agentWorkdir } from "../workspace/paths.ts";
import { excludeFactoryDir } from "./git-exclude.ts";
import { storedUploadName } from "./names.ts";
import { type ImageMime, type Refusal, sniffType, type TEXT_MIME } from "./sniff.ts";
import { UploadStore } from "./store.ts";

const { uploads, agentProjectGrants, projects } = schema;

/** U3 §13.5 (Q42): an upload never attached to a sent message is deleted after this long. */
export const UNSENT_TTL_MS = 24 * 3_600_000;

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

  private now(): Date {
    return this.d.now?.() ?? new Date();
  }
  private workdir(slug: string) {
    return agentWorkdir(this.d.factoryHome, slug);
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
    const id = randomUUID();
    const at = this.now();
    const store = await UploadStore.open(this.workdir(agent.slug));
    const written = await store.write(source, { storedName: storedUploadName(at, id, name), name });
    if ("status" in written) return written;
    const row = await this.d.lock.run(agent.slug, async () => {
      const [now] = await this.d.db
        .select()
        .from(schema.agents)
        .where(eq(schema.agents.id, agent.id));
      if (!now || now.archivedAt || now.terminatedAt || now.workspaceDeletedAt) {
        await store.remove(written.rel).catch(() => {});
        throw now?.archivedAt && !now.terminatedAt
          ? new UploadAgentEndedError("agent_archived", `@${agent.slug} is archived.`)
          : new UploadAgentEndedError("agent_terminated", `@${agent.slug} was terminated.`);
      }
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
    await this.exclude(agent).catch((err: unknown) =>
      this.d.log.warn({ err, agent: agent.slug }, "adding .factory/ to info/exclude failed"),
    );
    return uploadInfo(row);
  }

  private async exclude(agent: AgentRow) {
    const grants = await this.d.db
      .select({ hostPath: projects.hostPath })
      .from(agentProjectGrants)
      .innerJoin(projects, eq(projects.id, agentProjectGrants.projectId))
      .where(eq(agentProjectGrants.agentId, agent.id));
    const wd = this.workdir(agent.slug);
    const outcome = await excludeFactoryDir(wd, [wd, ...grants.map((g) => g.hostPath)]);
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

  /** The stored bytes and their sniffed type, or undefined when the file is gone or changed on disk. */
  async read(
    slug: string,
    r: UploadRow,
  ): Promise<{ data: Buffer; mime: ImageMime | typeof TEXT_MIME } | undefined> {
    const store = await UploadStore.open(this.workdir(slug)).catch(() => undefined);
    if (!store) return undefined;
    const data = await store.read(r.storedPath, { bytes: r.bytes, sha256: r.sha256 });
    if (!data) return undefined;
    const s = sniffType(data);
    if ("status" in s || s.kind !== r.kind) return undefined;
    return { data, mime: s.mime };
  }

  /**
   * Deletes an unsent upload by its uploader: the row first (so a send can't claim it after its file is gone), then
   * the file. Returns what stopped it otherwise.
   */
  async removeUnsent(
    slug: string,
    r: UploadRow,
    userId: string,
  ): Promise<"removed" | "not_uploader" | "already_sent"> {
    if (r.uploaderId !== userId) return "not_uploader";
    const gone = await this.d.db
      .delete(uploads)
      .where(and(eq(uploads.id, r.id), eq(uploads.uploaderId, userId), isNull(uploads.messageId)))
      .returning({ id: uploads.id });
    if (!gone.length) return "already_sent";
    await this.removeFile(slug, r.storedPath);
    return "removed";
  }

  private async removeFile(slug: string, rel: string) {
    try {
      const store = await UploadStore.open(this.workdir(slug));
      await store.remove(rel);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return; // the workspace is gone
      this.d.log.warn({ err, agent: slug, path: rel }, "deleting an upload's file failed");
    }
  }

  /** Q42: unsent uploads older than 24 hours lose their row and file. Returns how many. */
  async sweepUnsent(now = this.now()): Promise<number> {
    const cutoff = new Date(now.getTime() - UNSENT_TTL_MS);
    const old = await this.d.db
      .select({ id: uploads.id, storedPath: uploads.storedPath, slug: schema.agents.slug })
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
      await this.removeFile(r.slug, r.storedPath);
      n++;
    }
    return n;
  }
}
