import { type AgentRow, type Db, schema } from "@open-factory/db";
import { type AgentStatus, MAX_BODY_BYTES, type QueueItem } from "@open-factory/shared";
import { eq } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { EventBus } from "../agents/event-bus.ts";
import type { EventStore, Exec, PendingRow, Tx } from "../agents/event-store.ts";
import type { AgentRuntimes } from "../agents/runtimes.ts";
import {
  attachmentOf,
  bodyWithAttachments,
  claimUploads,
  DUPLICATE_ATTACHMENT,
  INVALID_ATTACHMENT,
  loadAttachments,
} from "../uploads/attach.ts";
import type { Forward } from "./forwarder.ts";
import type { Neighborhood } from "./neighborhood.ts";
import { type PeerLeft, peerBody } from "./peer-body.ts";
import { resolveName } from "./principals.ts";

export type Sender =
  | { agentId: string; toolUseId?: string | null }
  | { userId: string; handle: string };

export type SendResult =
  | {
      ok: true;
      id: string;
      to: string;
      status: AgentStatus | "inbox";
      note?: string;
      item?: QueueItem;
    }
  | {
      ok: false;
      message: string;
      code:
        | "not_found"
        | "ambiguous"
        | "self"
        | "archived"
        | "terminated"
        | "ended"
        | "reserved"
        | "invalid_attachment"
        | "too_large";
    };

/** What happened to the subject of a peer event (S6 spec §10.2, S7 §9.1). `spawned` is a join. */
export type PeerChange =
  | { kind: "joined" }
  | { kind: "spawned" }
  | { kind: "left"; reason: "archived" }
  | { kind: "left"; reason: "terminated"; by: string }
  | { kind: "moved"; to: string | null };

/** The subject's manager and peers before a change; recipients of `left`/`moved` come from it. */
export type NeighborhoodSnapshot = { managerId: string | null; peerIds: string[] };

const SHUTTING_DOWN =
  "The factory is shutting down; the message will be delivered after it restarts.";

const invalidAttachment = (): SendResult => ({
  ok: false,
  code: "invalid_attachment",
  message: INVALID_ATTACHMENT,
});
/** An upload was claimed or deleted between the check and the insert: the transaction rolls back. */
class AttachmentGoneError extends Error {}

const notFound = (name: string): SendResult => ({
  ok: false,
  code: "not_found",
  message: `No agent or user named '${name}'. Call list_peers to see who you can message.`,
});
const archived = (slug: string): SendResult => ({
  ok: false,
  code: "archived",
  message: `@${slug} is archived and can't receive messages.`,
});
const terminated = (slug: string): SendResult => ({
  ok: false,
  code: "terminated",
  message: `@${slug} was terminated and can't receive messages.`,
});

/**
 * Address resolution, persistence, rejections and the delivery hand-off (spec §7). Rows are durable as soon as they
 * are committed; every hand-off to a runtime waits for `bootDone()` (the end of boot reconciliation, §7.3 step 3).
 */
export class Router {
  private release!: () => void;
  /** Set by `close()`: no hand-off starts once shutdown has begun (committed rows stay pending for the next boot). */
  private closed = false;
  private abort!: (err: Error) => void;
  private readonly booted = new Promise<void>((resolve, reject) => {
    this.release = resolve;
    this.abort = reject;
  });

  constructor(
    private readonly d: {
      db: Db;
      store: EventStore;
      runtimes: AgentRuntimes;
      bus: EventBus;
      log: FastifyBaseLogger;
      neighborhood: Neighborhood;
    },
  ) {}

  /** Opens the hand-off gate; called once `reconcile()` has finished. */
  bootDone(): void {
    this.release();
  }

  /**
   * Shutdown: from here on no hand-off runs (each row stays pending for the next boot), and one still waiting for a
   * boot that never finished fails instead of hanging its request.
   */
  close(): void {
    this.closed = true;
    this.booted.catch(() => {});
    this.abort(new Error(SHUTTING_DOWN));
  }

  /**
   * One message from an agent (`send_message`) or a human (the REST route, which addresses agents only). An agent
   * recipient's row is committed, then handed over: awaited for a human (its start failures reach the route),
   * enqueued for an agent. A message to humans is delivered at once to their inbox.
   */
  async send(
    from: Sender,
    to: string,
    body: string,
    urgent: boolean,
    opts: { clientMessageId?: string; attachments?: string[] } = {},
  ): Promise<SendResult> {
    if ("userId" in from) return this.sendFromHuman(from, to, body, urgent, opts);
    const me = await this.d.store.agentById(from.agentId);
    if (!me || me.archivedAt || me.terminatedAt)
      return {
        ok: false,
        code: "ended",
        message: "You can't send messages: you were terminated.",
      };
    const r = await resolveName(this.d.db, to);
    switch (r.kind) {
      case "none":
        return notFound(r.name);
      case "ambiguous":
        return {
          ok: false,
          code: "ambiguous",
          message: `'${r.name}' matches both an agent and a user; ask a human to rename one.`,
        };
      case "reserved":
        return {
          ok: false,
          code: "reserved",
          message: `'${r.name}' is reserved and can't receive messages.`,
        };
      case "humans":
      case "user": {
        const { row } = await this.d.store.createHumanMessage({
          kind: "message",
          fromAgentId: from.agentId,
          to: r.kind === "humans" ? "all" : { userId: r.userId },
          body,
          urgent,
          fromToolUseId: from.toolUseId ?? null,
        });
        if (!row) throw new Error("a message to humans wrote no row");
        this.d.bus.publishAll({ type: "inbox_changed" });
        return {
          ok: true,
          id: row.id,
          to: r.kind === "humans" ? "@humans" : `@${r.handle}`,
          status: "inbox",
        };
      }
      case "agent": {
        if (r.agent.id === from.agentId)
          return { ok: false, code: "self", message: "You can't message yourself." };
        if (r.agent.archivedAt) return archived(r.agent.slug);
        if (r.agent.terminatedAt) return terminated(r.agent.slug);
        const row = await this.d.store.createMessage({
          from: { agentId: from.agentId },
          toAgentId: r.agent.id,
          body,
          urgent,
          fromToolUseId: from.toolUseId ?? null,
        });
        await this.booted;
        // Shutting down: the committed row is the next boot's to deliver; the sender's call still succeeds (a retry
        // would send it twice).
        if (this.closed)
          return {
            ok: true,
            id: row.id,
            to: r.agent.slug,
            status: this.d.runtimes.statusOf(r.agent),
          };
        // The recipient's status at send time (spec §6.1): read before the hand-off enqueues its wake. The row is
        // committed: a recipient whose init fails never fails the sender's call (a retry would send it twice); its
        // status is then what its row says, and the row stays pending (runtimes.deliver logs, never throws).
        const status = await this.statusOf(r.agent.id).catch((err: unknown) => {
          this.d.log.error(
            { err, agent: r.agent.slug, message: row.id },
            "loading the recipient failed; the message stays pending",
          );
          return this.d.runtimes.statusOf(r.agent);
        });
        await this.d.runtimes.deliver(row, "agent");
        return {
          ok: true,
          id: row.id,
          to: r.agent.slug,
          status,
          ...(status === "errored"
            ? {
                note: `@${r.agent.slug} is errored; your message will be delivered when a human restarts it.`,
              }
            : {}),
        };
      }
    }
  }

  /** The human REST route resolves agents only (a user, `humans` or a reserved name is "not found"). */
  private async sendFromHuman(
    from: { userId: string; handle: string },
    slug: string,
    body: string,
    urgent: boolean,
    opts: { clientMessageId?: string; attachments?: string[] },
  ): Promise<SendResult> {
    const { clientMessageId } = opts;
    // U3 §13.2: a repeat of an earlier send answers with the original, whatever happened since (the agent may have
    // ended, the message been written, its uploads been claimed by it). The insert below settles a concurrent repeat.
    if (clientMessageId) {
      const earlier = await this.d.store.byClientMessageId(from.userId, clientMessageId);
      if (earlier) return this.repeated(earlier);
    }
    const agent = await this.d.store.agentBySlug(slug);
    if (!agent) return notFound(slug);
    if (agent.archivedAt) return archived(agent.slug);
    if (agent.terminatedAt) return terminated(agent.slug);
    // U3 §13.5: each upload must be this agent's, this sender's and unused; its `[attached: …]` line joins the body
    // (so the 64 KB limit counts it) and the row's `message_id` is set in the insert's transaction.
    const ids = opts.attachments ?? [];
    const files = ids.length ? await loadAttachments(this.d.db, ids, agent.id, from.userId) : [];
    if (files === "duplicate")
      return { ok: false, code: "invalid_attachment", message: DUPLICATE_ATTACHMENT };
    if (!files) return invalidAttachment();
    const fullBody = bodyWithAttachments(body, files);
    if (Buffer.byteLength(fullBody, "utf8") > MAX_BODY_BYTES)
      return { ok: false, code: "too_large", message: "Message is larger than 64 KB" };
    const attachments = files.map(attachmentOf);
    let row: PendingRow;
    try {
      const r = await this.d.store.transaction(async (tx) => {
        const made = clientMessageId
          ? await this.d.store.createClientMessage(
              {
                fromUserId: from.userId,
                toAgentId: agent.id,
                body: fullBody,
                urgent,
                clientMessageId,
                attachments,
              },
              tx,
            )
          : {
              row: await this.d.store.createMessage(
                {
                  from: { userId: from.userId },
                  toAgentId: agent.id,
                  body: fullBody,
                  urgent,
                  attachments,
                },
                tx,
              ),
              created: true,
            };
        if (
          made.created &&
          ids.length &&
          !(await claimUploads(tx, ids, made.row.id, agent.id, from.userId))
        )
          throw new AttachmentGoneError();
        return made;
      });
      // Only the request whose insert wrote the row hands it to the runtime.
      if (!r.created) return this.repeated(r.row);
      row = r.row;
    } catch (e) {
      if (e instanceof AttachmentGoneError) return invalidAttachment();
      throw e;
    }
    await this.booted;
    if (this.closed) throw new Error(SHUTTING_DOWN);
    const status = await this.statusOf(agent.id);
    const item = await this.d.runtimes.deliver(row, "human");
    return { ok: true, id: row.id, to: agent.slug, status, ...(item ? { item } : {}) };
  }

  /** U3 §13.2: the original send's 202, from the row it wrote; nothing is queued or delivered again. */
  private async repeated(row: PendingRow): Promise<SendResult> {
    await this.booted;
    const agent = row.toAgentId ? await this.d.store.agentById(row.toAgentId) : undefined;
    if (!agent) throw new Error(`message ${row.id} has no agent recipient`);
    const rt = await this.d.runtimes.load(agent.id);
    return {
      ok: true,
      id: row.id,
      to: agent.slug,
      status: this.d.runtimes.statusOf(agent),
      ...(rt ? { item: rt.itemFor(row) } : {}),
    };
  }

  /**
   * Spec §9.1: one forwarded item of a report, persisted before this resolves (the report's job awaits it, §16). With
   * a manager, a held `member_update` (the report's text as itself; a fact as `@factory` about it), handed over once
   * boot is done and never awaited. A top-level agent's `errored` goes to every human's inbox; anything else of a
   * top-level agent stays in its session. The manager is read from the database: a change moves future rows only.
   */
  async forward(f: Forward): Promise<void> {
    const agent = await this.d.store.agentById(f.agentId);
    if (!agent) return;
    // One transaction with the durable episode state (R4): a crash between the two would report the same errored
    // episode again on the next boot. The hand-off and the inbox frame follow the commit.
    const out = await this.d.store.transaction(async (tx) => {
      // S7 §8, §9.3: nothing about a terminated agent is forwarded. Its row is locked FOR NO KEY UPDATE (the lock a
      // termination takes, so the two serialize; agent rows before message rows), and a forward that lost the race
      // writes nothing.
      const [subject] = await tx
        .select({ terminatedAt: schema.agents.terminatedAt })
        .from(schema.agents)
        .where(eq(schema.agents.id, f.agentId))
        .for("no key update");
      if (!subject || subject.terminatedAt) return undefined;
      const persisted = await this.persistForward(agent, f, tx);
      if (f.fact === "errored") await this.d.store.setErroredReported(f.agentId, tx);
      return persisted;
    });
    if (out?.held) this.handOffHeld(out.held);
    if (out?.inbox) this.d.bus.publishAll({ type: "inbox_changed" });
  }

  private async persistForward(
    agent: NonNullable<Awaited<ReturnType<EventStore["agentById"]>>>,
    f: Forward,
    tx: Tx,
  ): Promise<{ held?: PendingRow; inbox?: true } | undefined> {
    if (agent.reportsTo) {
      const held = await this.d.store.createHeld(
        {
          kind: "member_update",
          toAgentId: agent.reportsTo,
          ...(f.fact ? { subjectAgentId: f.agentId, notice: f.fact } : { fromAgentId: f.agentId }),
          body: f.body,
        },
        tx,
      );
      return { held };
    }
    if (f.fact !== "errored") return undefined;
    await this.d.store.createHumanMessage(
      {
        kind: "system",
        fromAgentId: null,
        notice: "agent_errored",
        subjectAgentId: f.agentId,
        to: "all",
        body: f.body,
        urgent: false,
      },
      tx,
    );
    return { inbox: true };
  }

  /**
   * The subject's manager and peers now (S6's snapshot), read in `tx` when given: a termination snapshots inside its
   * transaction (S7 §5.7).
   */
  async snapshot(tx: Exec, agentId: string): Promise<NeighborhoodSnapshot> {
    const n = await this.d.neighborhood.of(agentId, tx);
    return { managerId: n.manager?.id ?? null, peerIds: n.peers.map((p) => p.id) };
  }

  /**
   * S6 spec §10.2: held `peer_joined`/`peer_left` rows for everyone whose neighborhood changed, persisted and then
   * handed over once boot is done, never awaited. A thin wrapper over `persistPeerEvents` in its own transaction.
   */
  async peerEvents(
    subjectId: string,
    change: PeerChange,
    before: NeighborhoodSnapshot,
  ): Promise<void> {
    const rows = await this.d.db.transaction((tx) =>
      this.persistPeerEvents(tx, subjectId, change, before),
    );
    this.handOffHeldRows(rows);
  }

  /**
   * S7 §9.1: the rows of a peer event, written in the caller's transaction (which may hold the uncommitted subject)
   * and returned for `handOffHeldRows` after the commit. Recipients are the subject's peers (notice `peer`) and its
   * manager (notice `report`), bodies by `peerBody`. `joined`/`spawned` read the neighborhood now (call it after the
   * change); `left` and `moved` notify the `before` snapshot, and `moved` also announces the join to the new
   * neighborhood. Only live recipients get a row; the subject itself gets nothing, and the manager nothing when
   * `excludeManager` (a spawner's own act: it has the tool result).
   */
  async persistPeerEvents(
    tx: Tx,
    subjectId: string,
    change: PeerChange,
    before: NeighborhoodSnapshot,
    o: { excludeManager?: boolean } = {},
  ): Promise<PendingRow[]> {
    const subject = await this.d.store.agentById(subjectId, tx);
    if (!subject) return [];
    const rows: PendingRow[] = [];
    if (change.kind === "left" || change.kind === "moved") {
      const left: PeerLeft =
        change.kind === "moved"
          ? { reason: "moved", to: change.to }
          : change.reason === "terminated"
            ? { reason: "terminated", by: change.by }
            : { reason: "archived" };
      rows.push(
        ...(await this.notify(
          tx,
          subject,
          "peer_left",
          before.peerIds,
          o.excludeManager ? null : before.managerId,
          left,
        )),
      );
    }
    if (change.kind !== "left") {
      const now = await this.d.neighborhood.of(subjectId, tx);
      rows.push(
        ...(await this.notify(
          tx,
          subject,
          "peer_joined",
          now.peers.map((p) => p.id),
          o.excludeManager ? null : (now.manager?.id ?? null),
        )),
      );
    }
    return rows;
  }

  /**
   * S7 §5.2 step 5: a spawned agent's committed brief. Its status is read before the hand-off (as `send` does for an
   * agent sender), once boot is done; the hand-off wakes it `spawned` and is enqueued, never awaited. Shutting down
   * (or before a boot that failed): the row stays pending for the next boot. Never throws: the child exists.
   */
  async handOffBrief(row: PendingRow, child: AgentRow): Promise<AgentStatus> {
    try {
      await this.booted;
    } catch {
      return this.d.runtimes.statusOf(child);
    }
    if (this.closed) return this.d.runtimes.statusOf(child);
    const status = await this.statusOf(child.id).catch((err: unknown) => {
      this.d.log.error(
        { err, agent: child.slug, message: row.id },
        "loading the spawned agent failed; its brief stays pending",
      );
      return this.d.runtimes.statusOf(child);
    });
    await this.d.runtimes.deliver(row, "agent", "spawned");
    return status;
  }

  /** Hands committed held rows over (after the caller's commit), once boot is done; never awaited. */
  handOffHeldRows(rows: PendingRow[]): void {
    for (const row of rows) this.handOffHeld(row);
  }

  private async notify(
    tx: Tx,
    subject: { id: string; slug: string; displayName: string },
    kind: "peer_joined" | "peer_left",
    peerIds: string[],
    managerId: string | null,
    left?: PeerLeft,
  ): Promise<PendingRow[]> {
    const targets: { id: string; relation: "peer" | "report" }[] = peerIds.map((id) => ({
      id,
      relation: "peer",
    }));
    if (managerId) targets.push({ id: managerId, relation: "report" });
    const rows: PendingRow[] = [];
    for (const t of targets) {
      const to = await this.d.store.agentById(t.id, tx);
      if (!to || to.archivedAt || to.terminatedAt || to.id === subject.id) continue;
      rows.push(
        await this.d.store.createHeld(
          {
            kind,
            toAgentId: to.id,
            subjectAgentId: subject.id,
            notice: t.relation,
            body: peerBody(subject, t.relation, left ? { kind, left } : { kind: "peer_joined" }),
          },
          tx,
        ),
      );
    }
    return rows;
  }

  /** A held row's hand-off, once boot is done and unless shutdown has begun (the row then waits for the next boot). */
  private handOffHeld(row: PendingRow): void {
    void this.booted.then(
      () => {
        if (!this.closed) this.d.runtimes.deliverHeld(row);
      },
      () => {}, // shutting down before boot finished: the row is pending for the next boot
    );
  }

  /**
   * S8 §7.4: committed task rows, handed over once boot is done and unless shutdown has begun; never awaited (the
   * change succeeded, and a start failure shows on the agent). A human's comment is a human message (it starts an
   * errored agent's recovery); every other task row wakes with `task_message`. Every hand-off is `.catch`ed and
   * logged: `deliver` can reject, the server has no `unhandledRejection` handler, and the row stays pending for the
   * next wake or boot.
   */
  handOffTaskRows(rows: { row: PendingRow; wake: "human" | "task_message" }[]): void {
    void this.booted.then(
      () => {
        if (this.closed) return;
        for (const { row, wake } of rows) {
          const p =
            wake === "human"
              ? this.d.runtimes.deliver(row, "human")
              : this.d.runtimes.deliver(row, "agent", "task_message");
          p.catch((err: unknown) =>
            this.d.log.info({ err, message: row.id }, "a task message stays pending"),
          );
        }
      },
      () => {}, // shutting down before boot finished: the rows are pending for the next boot
    );
  }

  /** The agent's status after its runtime is loaded; never throws (a failed init is logged and read from the row). */
  async statusOfAgent(agentId: string): Promise<AgentStatus> {
    return this.statusOf(agentId).catch(async (err: unknown) => {
      this.d.log.error({ err, agentId }, "loading the recipient failed; its row says its status");
      const agent = await this.d.store.agentById(agentId);
      return agent ? this.d.runtimes.statusOf(agent) : "hibernated";
    });
  }

  private async statusOf(agentId: string): Promise<AgentStatus> {
    return (await this.d.runtimes.load(agentId))?.statusFrame().status ?? "hibernated";
  }
}
