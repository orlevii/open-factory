import { type AgentRow, type Db, schema } from "@open-factory/db";
import { type AgentStatus, MAX_BODY_BYTES, type QueueItem } from "@open-factory/shared";
import { eq } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import { AgentStartError } from "../agents/errors.ts";
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
import { HUMANS_SEND_REFUSAL, resolveName } from "./principals.ts";

export type Sender =
  | { agentId: string; toolUseId?: string | null }
  | { userId: string; handle: string };

export type RefusalCode =
  | "not_found"
  | "reserved"
  | "channel"
  | "self"
  | "archived"
  | "terminated"
  | "disabled"
  | "human"
  | "invalid_attachment"
  | "too_large";

/** One recipient's outcome (spec §4.4): each succeeds or fails alone. */
export type RecipientResult =
  | { to: string; kind: "human"; status: "inbox"; id: string }
  | {
      to: string;
      kind: "agent";
      status: "queued";
      recipient_status: AgentStatus;
      id: string;
      item?: QueueItem;
    }
  | { to: string; kind: "agent"; status: "pending"; id: string; note: string }
  | { to: string; kind: "agent"; status: "start_failed"; id: string; note: string }
  | { to: string; status: "refused"; reason: string; code: RefusalCode };

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

const refusal = (to: string, code: RefusalCode, reason: string): RecipientResult => ({
  to,
  status: "refused",
  reason,
  code,
});
/** An upload was claimed or deleted between the check and the insert: the transaction rolls back. */
class AttachmentGoneError extends Error {}

/** The principal a target names, once resolved: the key de-duplicates, `accepted` is set when it can receive. */
type Target = {
  to: string;
  key: string;
  refused?: RecipientResult;
  agent?: AgentRow;
  user?: { userId: string; handle: string };
};

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
   * One message to a list of handles (spec §4.4), from an agent (`send_message`) or a human (the REST route, which
   * addresses agents only). Each target is resolved and de-duplicated by principal and succeeds or is refused alone;
   * every accepted row is written in one transaction with the same `recipients` (the accepted list, in order). After
   * the commit an agent row is handed over (awaited for a human sender, whose start failure then is that recipient's
   * `start_failed`; enqueued for an agent sender), and a human recipient's inbox is told. Results follow the input.
   */
  async send(
    from: Sender,
    to: string[],
    body: string,
    urgent: boolean,
    opts: { clientMessageId?: string; attachments?: string[] } = {},
  ): Promise<{ results: RecipientResult[] }> {
    const { clientMessageId } = opts;
    // U3 §13.2: a repeat of an earlier send answers with the original, for every row, whatever happened since (the
    // agent may have ended, its uploads been claimed). The inserts below settle a concurrent repeat.
    if ("userId" in from && clientMessageId) {
      const earlier = await this.d.store.byClientMessageId(from.userId, clientMessageId);
      if (earlier.length)
        return { results: await Promise.all(earlier.map((r) => this.repeated(r))) };
    }
    if ("agentId" in from) {
      const me = await this.d.store.agentById(from.agentId);
      if (!me || me.archivedAt || me.terminatedAt)
        return {
          results: [...new Set(to.map(recipientLabel))].map((t) =>
            refusal(t, "terminated", "You can't send messages: you were terminated."),
          ),
        };
    }
    const targets = await this.resolveTargets(from, to);
    const accepted = targets.filter((t) => !t.refused);
    const ids = opts.attachments ?? [];
    if (ids.length && (accepted.length !== 1 || !accepted[0]?.agent))
      return {
        results: targets.map(
          (t) => t.refused ?? refusal(t.to, "invalid_attachment", INVALID_ATTACHMENT),
        ),
      };
    if (!accepted.length) return { results: targets.map((t) => t.refused as RecipientResult) };

    // U3 §13.5: each upload must be this agent's, this sender's and unused; its `[attached: …]` line joins the body
    // (so the 64 KB limit counts it) and the row's `message_id` is set in the insert's transaction.
    const only = accepted[0]?.agent;
    let fullBody = body;
    let attachments: ReturnType<typeof attachmentOf>[] = [];
    if (ids.length && only && "userId" in from) {
      const files = await loadAttachments(this.d.db, ids, only.id, from.userId);
      if (!files || files === "duplicate") {
        const reason = files === "duplicate" ? DUPLICATE_ATTACHMENT : INVALID_ATTACHMENT;
        return {
          results: targets.map((t) => t.refused ?? refusal(t.to, "invalid_attachment", reason)),
        };
      }
      fullBody = bodyWithAttachments(body, files);
      attachments = files.map(attachmentOf);
    }
    if (Buffer.byteLength(fullBody, "utf8") > MAX_BODY_BYTES)
      return {
        results: targets.map(
          (t) => t.refused ?? refusal(t.to, "too_large", "Message is larger than 64 KB"),
        ),
      };

    const recipients = accepted.map((t) => t.to);
    type Written = { target: Target; row?: PendingRow; humanRowId?: string; created: boolean };
    let written: Written[];
    try {
      written = await this.d.store.transaction(async (tx) => {
        const out: Written[] = [];
        for (const target of accepted) {
          if (target.user) {
            const { row } = await this.d.store.createHumanMessage(
              {
                kind: "message",
                fromAgentId: (from as { agentId: string }).agentId,
                to: { userId: target.user.userId },
                recipients,
                body: fullBody,
                urgent,
                fromToolUseId: (from as { toolUseId?: string | null }).toolUseId ?? null,
              },
              tx,
            );
            out.push({ target, humanRowId: row.id, created: true });
            continue;
          }
          const agent = target.agent as AgentRow;
          if ("userId" in from) {
            const made = clientMessageId
              ? await this.d.store.createClientMessage(
                  {
                    fromUserId: from.userId,
                    toAgentId: agent.id,
                    recipients,
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
                      recipients,
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
            out.push({ target, row: made.row, created: made.created });
          } else {
            const row = await this.d.store.createMessage(
              {
                from: { agentId: from.agentId },
                toAgentId: agent.id,
                recipients,
                body: fullBody,
                urgent,
                fromToolUseId: from.toolUseId ?? null,
              },
              tx,
            );
            out.push({ target, row, created: true });
          }
        }
        return out;
      });
    } catch (e) {
      if (e instanceof AttachmentGoneError)
        return {
          results: targets.map(
            (t) => t.refused ?? refusal(t.to, "invalid_attachment", INVALID_ATTACHMENT),
          ),
        };
      throw e;
    }

    for (const w of written)
      if (w.target.user) this.d.bus.publishToUser(w.target.user.userId, { type: "inbox_changed" });
    // I1 §6.5: the human party's chat with each agent on the other side changed.
    if ("userId" in from) {
      for (const w of written)
        if (w.created && w.target.agent)
          this.d.bus.publishToUser(from.userId, {
            type: "chat_changed",
            agent: w.target.agent.slug,
          });
    } else {
      const me = await this.d.store.agentById(from.agentId);
      for (const w of written)
        if (me && w.target.user)
          this.d.bus.publishToUser(w.target.user.userId, {
            type: "chat_changed",
            agent: me.slug,
          });
    }

    const outcome = new Map<Target, RecipientResult>();
    for (const w of written)
      if (w.humanRowId)
        outcome.set(w.target, {
          to: w.target.to,
          kind: "human",
          status: "inbox",
          id: w.humanRowId,
        });
    const agentRows = written.filter((w) => w.row);
    if (agentRows.length) {
      await this.booted;
      // Only the request whose insert wrote the row hands it to the runtime; a concurrent repeat answers from the row.
      await Promise.all(
        agentRows.map(async (w) => {
          const agent = w.target.agent as AgentRow;
          const row = w.row as PendingRow;
          try {
            outcome.set(
              w.target,
              w.created ? await this.handOver(from, agent, row) : await this.repeated(row),
            );
          } catch (e) {
            // Every row is committed: one recipient's failure (or the shutdown) is that recipient's result, not the call's.
            this.d.log.error({ err: e, agent: agent.slug, message: row.id }, "handing over failed");
            outcome.set(w.target, {
              to: `@${agent.slug}`,
              kind: "agent",
              status: "start_failed",
              id: row.id,
              note: e instanceof Error ? e.message : String(e),
            });
          }
        }),
      );
    }
    return { results: targets.map((t) => t.refused ?? (outcome.get(t) as RecipientResult)) };
  }

  /** Resolves every target in input order; a repeat of one principal (`bob`, `@bob`) is dropped. */
  private async resolveTargets(from: Sender, to: string[]): Promise<Target[]> {
    const targets: Target[] = [];
    const seen = new Set<string>();
    for (const raw of to) {
      const r = await resolveName(this.d.db, raw);
      let t: Target;
      switch (r.kind) {
        case "channel":
          t = {
            to: r.name,
            key: `#${r.name}`,
            refused: refusal(r.name, "channel", "Channels aren't supported yet."),
          };
          break;
        case "reserved": {
          const label = `@${r.name}`;
          t = {
            to: label,
            key: label,
            refused: refusal(
              label,
              "reserved",
              r.name === "humans"
                ? HUMANS_SEND_REFUSAL
                : `'${r.name}' is reserved and can't receive messages.`,
            ),
          };
          break;
        }
        case "none": {
          const label = `@${r.name}`;
          t = {
            to: label,
            key: label,
            refused: refusal(
              label,
              "not_found",
              `No agent or user named '${r.name}'. Call list_peers to see who you can message.`,
            ),
          };
          break;
        }
        case "user": {
          const label = `@${r.handle}`;
          t = { to: label, key: `user:${r.userId}`, user: r };
          if ("userId" in from)
            t.refused = refusal(
              label,
              "human",
              `${label} is a person; you can message agents only.`,
            );
          else if (r.disabled)
            t.refused = refusal(label, "disabled", `${label}'s account is disabled.`);
          break;
        }
        case "agent": {
          const a = r.agent;
          const label = `@${a.slug}`;
          t = { to: label, key: `agent:${a.id}`, agent: a };
          if ("agentId" in from && a.id === from.agentId)
            t.refused = refusal(label, "self", "You can't message yourself.");
          else if (a.archivedAt)
            t.refused = refusal(
              label,
              "archived",
              `${label} is archived and can't receive messages.`,
            );
          else if (a.terminatedAt)
            t.refused = refusal(
              label,
              "terminated",
              `${label} was terminated and can't receive messages.`,
            );
          break;
        }
      }
      if (seen.has(t.key)) continue;
      seen.add(t.key);
      targets.push(t);
    }
    return targets;
  }

  /** One committed agent row's hand-off and its result. The row is durable, so nothing here fails the other recipients. */
  private async handOver(from: Sender, agent: AgentRow, row: PendingRow): Promise<RecipientResult> {
    const to = `@${agent.slug}`;
    if ("userId" in from) {
      if (this.closed) throw new Error(SHUTTING_DOWN);
      const status = await this.statusOf(agent.id);
      try {
        const item = await this.d.runtimes.deliver(row, "human");
        return {
          to,
          kind: "agent",
          status: "queued",
          recipient_status: status,
          id: row.id,
          ...(item ? { item } : {}),
        };
      } catch (e) {
        if (e instanceof AgentStartError)
          return { to, kind: "agent", status: "start_failed", id: row.id, note: e.message };
        throw e;
      }
    }
    // Shutting down: the committed row is the next boot's to deliver; the sender's call still succeeds (a retry would
    // send it twice).
    if (this.closed)
      return {
        to,
        kind: "agent",
        status: "queued",
        recipient_status: this.d.runtimes.statusOf(agent),
        id: row.id,
      };
    // The recipient's status at send time (spec §6.1): read before the hand-off enqueues its wake. The row is
    // committed: a recipient whose init fails never fails the sender's call; its status is then what its row says, and
    // the row stays pending (runtimes.deliver logs, never throws).
    const status = await this.statusOf(agent.id).catch((err: unknown) => {
      this.d.log.error(
        { err, agent: agent.slug, message: row.id },
        "loading the recipient failed; the message stays pending",
      );
      return this.d.runtimes.statusOf(agent);
    });
    await this.d.runtimes.deliver(row, "agent");
    if (status === "errored")
      return {
        to,
        kind: "agent",
        status: "pending",
        id: row.id,
        note: `${to} is errored; your message will be delivered when a human restarts it.`,
      };
    return { to, kind: "agent", status: "queued", recipient_status: status, id: row.id };
  }

  /** U3 §13.2: one earlier row's original result; nothing is queued or delivered again. */
  private async repeated(row: PendingRow): Promise<RecipientResult> {
    await this.booted;
    const agent = row.toAgentId ? await this.d.store.agentById(row.toAgentId) : undefined;
    if (!agent) throw new Error(`message ${row.id} has no agent recipient`);
    const rt = await this.d.runtimes.load(agent.id);
    return {
      to: `@${agent.slug}`,
      kind: "agent",
      status: "queued",
      recipient_status: this.d.runtimes.statusOf(agent),
      id: row.id,
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

/** How a result names a raw recipient: a channel as typed, anything else as `@handle` (one leading `@` dropped). */
function recipientLabel(raw: string): string {
  const t = raw.trim();
  return t.startsWith("#") ? t : `@${t.startsWith("@") ? t.slice(1) : t}`;
}
