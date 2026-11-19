import type { Db } from "@open-factory/db";
import type { AgentStatus, QueueItem } from "@open-factory/shared";
import type { FastifyBaseLogger } from "fastify";
import type { EventBus } from "../agents/event-bus.ts";
import type { EventStore } from "../agents/event-store.ts";
import type { AgentRuntimes } from "../agents/runtimes.ts";
import type { Neighborhood } from "./neighborhood.ts";
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
      code: "not_found" | "ambiguous" | "self" | "archived" | "reserved";
    };

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

/**
 * Address resolution, persistence, rejections and the delivery hand-off (spec §7). Rows are durable as soon as they
 * are committed; every hand-off to a runtime waits for `bootDone()` (the end of boot reconciliation, §7.3 step 3).
 */
export class Router {
  private release!: () => void;
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
   * Shutdown: a hand-off still waiting for a boot that never finished fails instead of hanging its request (the row
   * stays pending for the next boot). A no-op once `bootDone()` ran.
   */
  close(): void {
    this.booted.catch(() => {});
    this.abort(
      new Error("The factory is shutting down; the message will be delivered after it restarts."),
    );
  }

  /**
   * One message from an agent (`send_message`) or a human (the REST route, which addresses agents only). An agent
   * recipient's row is committed, then handed over: awaited for a human (its start failures reach the route),
   * enqueued for an agent. A message to humans is delivered at once to their inbox.
   */
  async send(from: Sender, to: string, body: string, urgent: boolean): Promise<SendResult> {
    if ("userId" in from) return this.sendFromHuman(from, to, body, urgent);
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
        const row = await this.d.store.createMessage({
          from: { agentId: from.agentId },
          toAgentId: r.agent.id,
          body,
          urgent,
          fromToolUseId: from.toolUseId ?? null,
        });
        await this.booted;
        // The recipient's status at send time (spec §6.1): read before the hand-off enqueues its wake.
        const status = await this.statusOf(r.agent.id);
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
  ): Promise<SendResult> {
    const agent = await this.d.store.agentBySlug(slug);
    if (!agent) return notFound(slug);
    if (agent.archivedAt) return archived(agent.slug);
    const row = await this.d.store.createMessage({
      from: { userId: from.userId },
      toAgentId: agent.id,
      body,
      urgent,
    });
    await this.booted;
    const status = await this.statusOf(agent.id);
    const item = await this.d.runtimes.deliver(row, "human");
    return { ok: true, id: row.id, to: agent.slug, status, ...(item ? { item } : {}) };
  }

  private async statusOf(agentId: string): Promise<AgentStatus> {
    return (await this.d.runtimes.load(agentId))?.statusFrame().status ?? "hibernated";
  }
}
