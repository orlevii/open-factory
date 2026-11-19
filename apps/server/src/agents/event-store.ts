import { randomUUID } from "node:crypto";
import { type Db, type RuntimeJournal, schema } from "@open-factory/db";
import { type AnyEvent, anyEventSchema, type SessionEvent } from "@open-factory/shared";
import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  notInArray,
  sql,
} from "drizzle-orm";
import { capPayload } from "./cap.ts";
import type { NoticeType } from "./notices.ts";

const { agents, credentials, sessionEvents, turns, messages } = schema;
type MessageRow = typeof messages.$inferSelect;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Exec = Db | Tx;

export interface TurnClose {
  isError: boolean;
  terminalReason?: string;
  originKind?: string;
  usage?: Extract<AnyEvent, { type: "usage" }>;
}

export class EventStore {
  constructor(private readonly db: Db) {}

  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.db.transaction(fn);
  }

  // agents
  async listAgents() {
    return this.db.select().from(agents).orderBy(asc(agents.slug));
  }
  async agentBySlug(slug: string) {
    return (await this.db.select().from(agents).where(eq(agents.slug, slug)))[0];
  }
  async agentById(id: string) {
    return (await this.db.select().from(agents).where(eq(agents.id, id)))[0];
  }
  async setSessionId(agentId: string, sessionId: string | null) {
    await this.db.update(agents).set({ sessionId }).where(eq(agents.id, agentId));
  }
  async setStatus(agentId: string, status: "hibernated" | "errored") {
    await this.db.update(agents).set({ status }).where(eq(agents.id, agentId));
  }
  /** Replaces the whole journal (spec §12); null clears it. */
  async setRuntimeJournal(agentId: string, runtimeJournal: RuntimeJournal | null) {
    await this.db.update(agents).set({ runtimeJournal }).where(eq(agents.id, agentId));
  }
  /** The cut-off agent is owed one continue notice at the reset (spec §7.3). */
  async setNoticeOwed(agentId: string, owed: boolean) {
    await this.db.update(agents).set({ rateLimitNoticeOwed: owed }).where(eq(agents.id, agentId));
  }
  /** The non-archived agents on the credential that are owed a continue notice. */
  async owedAgents(credentialId: string): Promise<{ id: string; slug: string }[]> {
    return this.db
      .select({ id: agents.id, slug: agents.slug })
      .from(agents)
      .where(
        and(
          eq(agents.credentialId, credentialId),
          eq(agents.rateLimitNoticeOwed, true),
          isNull(agents.archivedAt),
        ),
      )
      .orderBy(asc(agents.slug));
  }

  // credentials (rate-limit pauses, spec §7.2)
  /**
   * Pauses the credential until `until`. A later window wins; it never shortens. Returns the window in force
   * afterwards (the stored one when this one was shorter) and the credential's name.
   */
  async pauseCredential(
    id: string,
    until: Date,
    exact: boolean,
  ): Promise<{ name: string; until: Date; exact: boolean }> {
    const at = sql`${until.toISOString()}::timestamptz`;
    const longer = sql`(${credentials.rateLimitedUntil} is null or ${credentials.rateLimitedUntil} < ${at})`;
    const [row] = await this.db
      .update(credentials)
      .set({
        rateLimitedUntil: sql`case when ${longer} then ${at} else ${credentials.rateLimitedUntil} end`,
        rateLimitExact: sql`case when ${longer} then ${exact} else ${credentials.rateLimitExact} end`,
      })
      .where(eq(credentials.id, id))
      .returning({
        name: credentials.name,
        until: credentials.rateLimitedUntil,
        exact: credentials.rateLimitExact,
      });
    if (!row?.until) throw new Error(`credential ${id} not found`);
    return { name: row.name, until: row.until, exact: row.exact };
  }
  /** Clears the pause; with `until`, only a window that ends by then (a later one landed meanwhile: keep it). */
  async clearCredentialPause(id: string, until?: Date) {
    await this.db
      .update(credentials)
      .set({ rateLimitedUntil: null, rateLimitExact: true })
      .where(
        and(eq(credentials.id, id), ...(until ? [lte(credentials.rateLimitedUntil, until)] : [])),
      );
  }
  /** Every credential with a stored pause, past or future (boot re-arms or clears them). */
  async pausedCredentials(): Promise<{ id: string; name: string; until: Date; exact: boolean }[]> {
    const rows = await this.db
      .select({
        id: credentials.id,
        name: credentials.name,
        until: credentials.rateLimitedUntil,
        exact: credentials.rateLimitExact,
      })
      .from(credentials)
      .where(isNotNull(credentials.rateLimitedUntil));
    return rows.flatMap((r) => (r.until ? [{ ...r, until: r.until }] : []));
  }
  async credentialName(id: string): Promise<string | undefined> {
    const [row] = await this.db
      .select({ name: credentials.name })
      .from(credentials)
      .where(eq(credentials.id, id));
    return row?.name;
  }

  // events
  async append(
    agentId: string,
    turnId: string | null,
    event: AnyEvent,
    tx: Exec = this.db,
  ): Promise<SessionEvent> {
    const { payload, truncated } = capPayload(event);
    const stored = truncated ? { ...payload, truncated } : payload;
    // Seq = max + 1 in the same statement. Safe because the agent's serial job queue is the only writer;
    // the unique index turns any violation of that into a loud failure.
    const [row] = await tx.execute<{ seq: number; at: Date; slug: string }>(sql`
      insert into session_events (agent_id, seq, turn_id, type, payload)
      select ${agentId}, coalesce(max(seq), 0) + 1, ${turnId}, ${event.type}, ${JSON.stringify(stored)}::jsonb
      from session_events where agent_id = ${agentId}
      returning seq, at, (select slug from agents where id = ${agentId}) as slug`);
    if (!row) throw new Error("append returned no row");
    return {
      seq: Number(row.seq),
      agentSlug: row.slug,
      turnId,
      at: new Date(row.at).toISOString(),
      // Live frames must equal replayed history, so the DTO carries the capped payload (spec §6.4).
      event: truncated ? ({ type: event.type, ...payload } as AnyEvent) : event,
      ...(truncated ? { truncated } : {}),
    };
  }

  async lastSeq(agentId: string): Promise<number> {
    const [r] = await this.db
      .select({ m: sql<number>`coalesce(max(${sessionEvents.seq}), 0)` })
      .from(sessionEvents)
      .where(eq(sessionEvents.agentId, agentId));
    return Number(r?.m ?? 0);
  }

  private async rowsToDto(
    agentId: string,
    rows: (typeof sessionEvents.$inferSelect)[],
  ): Promise<SessionEvent[]> {
    const agent = await this.agentById(agentId);
    return rows.map((r) => {
      const { truncated, ...rest } = r.payload as Record<string, unknown> & {
        truncated?: Record<string, number>;
      };
      return {
        seq: r.seq,
        agentSlug: agent?.slug ?? "",
        turnId: r.turnId,
        at: r.at.toISOString(),
        event: anyEventSchema.parse({ type: r.type, ...rest }),
        ...(truncated ? { truncated } : {}),
      };
    });
  }

  async after(agentId: string, afterSeq: number, limit: number): Promise<SessionEvent[]> {
    const rows = await this.db
      .select()
      .from(sessionEvents)
      .where(and(eq(sessionEvents.agentId, agentId), gt(sessionEvents.seq, afterSeq)))
      .orderBy(asc(sessionEvents.seq))
      .limit(limit);
    return this.rowsToDto(agentId, rows);
  }

  async page(
    agentId: string,
    q: { before?: number; around?: number; limit: number },
  ): Promise<{ events: SessionEvent[]; hasMore: { before: boolean; after: boolean } } | null> {
    const last = await this.lastSeq(agentId);
    let from: number;
    if (q.around !== undefined) {
      const exists = await this.db
        .select({ s: sessionEvents.seq })
        .from(sessionEvents)
        .where(and(eq(sessionEvents.agentId, agentId), eq(sessionEvents.seq, q.around)));
      if (!exists.length) return null;
      from = Math.max(1, q.around - Math.floor((q.limit - 1) / 2));
    } else {
      const end = (q.before ?? last + 1) - 1;
      from = Math.max(1, end - q.limit + 1);
    }
    const rows = await this.db
      .select()
      .from(sessionEvents)
      .where(
        and(
          eq(sessionEvents.agentId, agentId),
          gt(sessionEvents.seq, from - 1),
          ...(q.before !== undefined ? [lt(sessionEvents.seq, q.before)] : []),
        ),
      )
      .orderBy(asc(sessionEvents.seq))
      .limit(q.limit);
    const events = await this.rowsToDto(agentId, rows);
    const first = events[0]?.seq ?? from;
    const lastShown = events.at(-1)?.seq ?? 0;
    return { events, hasMore: { before: first > 1, after: lastShown < last } };
  }

  // turns
  async openTurn(agentId: string, tx: Exec = this.db): Promise<string> {
    const id = randomUUID();
    await tx.insert(turns).values({ id, agentId, startedAt: new Date() });
    return id;
  }
  async closeTurn(turnId: string, d: TurnClose, tx: Exec = this.db) {
    const u = d.usage;
    await tx
      .update(turns)
      .set({
        endedAt: new Date(),
        isError: d.isError,
        terminalReason: d.terminalReason ?? null,
        originKind: d.originKind ?? null,
        ...(u
          ? {
              model: u.model,
              inputTokens: u.inputTokens,
              outputTokens: u.outputTokens,
              cacheReadTokens: u.cacheReadTokens,
              cacheWriteTokens: u.cacheWriteTokens,
              costUsd: u.costUsd,
            }
          : {}),
      })
      .where(eq(turns.id, turnId));
  }

  // messages
  async createMessage(m: { fromUserId: string; toAgentId: string; body: string; urgent: boolean }) {
    const [row] = await this.db
      .insert(messages)
      .values({ id: randomUUID(), ...m })
      .returning();
    if (!row) throw new Error("insert returned no row");
    return row;
  }
  async pendingMessages(agentId: string) {
    return this.db
      .select()
      .from(messages)
      .where(and(eq(messages.toAgentId, agentId), eq(messages.state, "pending")))
      .orderBy(asc(messages.createdAt), asc(messages.id));
  }
  /**
   * A system notice from `@factory`. One pending notice of each type per agent: a second one replaces the pending
   * one's body (same row); a written (delivered) one is never touched.
   */
  async createNotice(
    m: { toAgentId: string; notice: NoticeType; body: string },
    /** Ids written to a process but not yet marked delivered: never replaced. */
    inFlightIds: string[] = [],
  ): Promise<MessageRow> {
    const [existing] = await this.db
      .update(messages)
      .set({ body: m.body })
      .where(
        and(
          eq(messages.toAgentId, m.toAgentId),
          eq(messages.kind, "system"),
          eq(messages.notice, m.notice),
          eq(messages.state, "pending"),
          ...(inFlightIds.length ? [notInArray(messages.id, inFlightIds)] : []),
        ),
      )
      .returning();
    if (existing) return existing;
    const [row] = await this.db
      .insert(messages)
      .values({
        id: randomUUID(),
        kind: "system",
        notice: m.notice,
        toAgentId: m.toAgentId,
        body: m.body,
      })
      .returning();
    if (!row) throw new Error("insert returned no row");
    return row;
  }
  /** Pending system notices describe the old session; "Start a new session" drops them. */
  async deletePendingNotices(agentId: string): Promise<void> {
    await this.db
      .delete(messages)
      .where(
        and(
          eq(messages.toAgentId, agentId),
          eq(messages.kind, "system"),
          eq(messages.state, "pending"),
        ),
      );
  }
  /** Pending items in delivery order (system notices first, then by age), with the sender's handle (null for `@factory`). */
  async pendingQueue(agentId: string): Promise<(MessageRow & { fromHandle: string | null })[]> {
    const rows = await this.db
      .select({ m: messages, fromHandle: schema.users.handle })
      .from(messages)
      .leftJoin(schema.users, eq(schema.users.id, messages.fromUserId))
      .where(and(eq(messages.toAgentId, agentId), eq(messages.state, "pending")))
      .orderBy(sql`(${messages.kind} = 'system') desc`, asc(messages.createdAt), asc(messages.id));
    return rows.map((r) => ({ ...r.m, fromHandle: r.fromHandle }));
  }
  async markDelivered(ids: string[], tx: Exec = this.db) {
    if (ids.length)
      await tx
        .update(messages)
        .set({ state: "delivered", deliveredAt: new Date() })
        .where(inArray(messages.id, ids));
  }
  async markPending(ids: string[], tx: Exec = this.db) {
    if (ids.length)
      await tx
        .update(messages)
        .set({ state: "pending", deliveredAt: null, deliveredTurnId: null })
        .where(inArray(messages.id, ids));
  }
  async setDeliveredTurn(ids: string[], turnId: string, tx: Exec = this.db) {
    if (ids.length)
      await tx.update(messages).set({ deliveredTurnId: turnId }).where(inArray(messages.id, ids));
  }
}
