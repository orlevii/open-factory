import { randomUUID } from "node:crypto";
import { type AgentRow, type Db, type RuntimeJournal, schema } from "@open-factory/db";
import {
  type AnyEvent,
  anyEventSchema,
  type ErrorKind,
  type SessionEvent,
} from "@open-factory/shared";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  notInArray,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { capPayload } from "./cap.ts";
import { InvalidCursorError } from "./errors.ts";
import type { NoticeType } from "./notices.ts";

/**
 * Only an instant `inboxPage` minted (UTC ISO, microseconds kept) is accepted, so nothing malformed reaches Postgres;
 * the round trip rejects calendar dates that don't exist (2026-02-31), and the year must be at least 1.
 */
function isCursorInstant(at: string): boolean {
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,6})?Z$/.test(at)) return false;
  // Year 0000 parses in JavaScript but isn't a Postgres timestamp (1 BC is year 1 BC there).
  if (at.startsWith("0000")) return false;
  const d = new Date(at);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 19) === at.slice(0, 19);
}

const {
  agents,
  agentProjectGrants,
  credentials,
  sessionEvents,
  turns,
  messages,
  inboxItems,
  users,
} = schema;
type MessageRow = typeof messages.$inferSelect;
/** The one joined row shape the queue and the runtime use (spec §7.3): the row plus who sent it and what it is about. */
export type PendingRow = MessageRow & {
  fromHandle: string | null;
  fromSlug: string | null;
  subjectSlug: string | null;
  subjectDisplayName: string | null;
};
export interface MessageLookup {
  id: string;
  kind: "message" | "system" | "member_update" | "peer_joined" | "peer_left";
  from: string;
  to: string;
  state: "pending" | "delivered" | "rejected";
  recipientEvent?: { agentSlug: string; seq: number };
  senderEvent?: { agentSlug: string; seq: number };
}
export interface InboxEntry {
  id: string;
  messageId: string;
  from: { kind: "agent" | "factory"; name: string };
  about?: string;
  to: string;
  preview: string;
  urgent: boolean;
  createdAt: string;
  link: { agentSlug: string; seq?: number };
}
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
/** The pool or a caller's transaction. */
export type Exec = Db | Tx;

export interface TurnClose {
  isError: boolean;
  terminalReason?: string;
  originKind?: string;
  usage?: Extract<AnyEvent, { type: "usage" }>;
}

export class EventStore {
  constructor(private readonly db: Db) {}

  private lastStamp = 0;
  /** Server-clock stamp, strictly increasing within this process so created order is insert order (spec §7.3). */
  private stamp(): Date {
    const t = Math.max(Date.now(), this.lastStamp + 1);
    this.lastStamp = t;
    return new Date(t);
  }

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
  /** Inside `tx` when given (S7 §5.7: a call in a locked transaction must not use its own connection). */
  async agentById(id: string, tx: Exec = this.db) {
    return (await tx.select().from(agents).where(eq(agents.id, id)))[0];
  }
  async setSessionId(agentId: string, sessionId: string | null) {
    await this.db.update(agents).set({ sessionId }).where(eq(agents.id, agentId));
  }
  async setStatus(agentId: string, status: "hibernated" | "errored") {
    await this.db.update(agents).set({ status }).where(eq(agents.id, agentId));
  }
  /** Errored with its reason (spec §8.3). An error ends any attempt in progress, so `attempting` clears too. */
  async setErrored(agentId: string, message: string, kind: ErrorKind) {
    await this.db
      .update(agents)
      .set({ status: "errored", lastError: message, errorKind: kind, attempting: false })
      .where(eq(agents.id, agentId));
  }
  /** An attempt succeeded (spec §9.2): the error and the attempt clear together. */
  async clearErrored(agentId: string) {
    await this.db
      .update(agents)
      .set({
        status: "hibernated",
        lastError: null,
        errorKind: null,
        attempting: false,
        erroredReported: false,
      })
      .where(eq(agents.id, agentId));
  }
  /** S6 §9.1: the current errored episode's `errored` fact was forwarded; cleared by `clearErrored`. */
  async setErroredReported(agentId: string, tx: Exec = this.db) {
    await tx.update(agents).set({ erroredReported: true }).where(eq(agents.id, agentId));
  }
  async setAttempting(agentId: string, attempting: boolean) {
    await this.db.update(agents).set({ attempting }).where(eq(agents.id, agentId));
  }
  /**
   * S7 §8 step 2, inside the termination's transaction (the agent rows are locked first): terminated, `attempting`
   * cleared, its grants deleted (projects keep their RESTRICT FKs), and every pending row addressed to it rejected.
   */
  async terminateRows(tx: Tx, agentId: string, by: string) {
    await tx
      .update(agents)
      .set({ terminatedAt: new Date(), terminatedBy: by, attempting: false })
      .where(eq(agents.id, agentId));
    await tx.delete(agentProjectGrants).where(eq(agentProjectGrants.agentId, agentId));
    await this.rejectPending(agentId, tx);
  }
  /** Every pending row addressed to the agent becomes `rejected` (a terminated agent receives nothing). */
  async rejectPending(agentId: string, tx: Exec = this.db) {
    await tx
      .update(messages)
      .set({ state: "rejected" })
      .where(and(eq(messages.toAgentId, agentId), eq(messages.state, "pending")));
  }
  /**
   * Whether the agent has its `terminated` event. The type is a literal, not a parameter, so even a generic plan
   * matches the partial index `session_events_terminated_idx` (never a read of the agent's whole log).
   */
  async hasTerminatedEvent(agentId: string): Promise<boolean> {
    const [r] = await this.db
      .select({ id: sessionEvents.id })
      .from(sessionEvents)
      .where(and(eq(sessionEvents.agentId, agentId), sql`${sessionEvents.type} = 'terminated'`))
      .limit(1);
    return Boolean(r);
  }
  /**
   * S7 §10.3 step 2: which of `ids` (agents with a container still listed) are terminated. Bounded by the listed
   * containers, so the sweep never reads every terminated agent.
   */
  async terminatedAmong(ids: string[]): Promise<AgentRow[]> {
    if (!ids.length) return [];
    return this.db
      .select()
      .from(agents)
      .where(and(inArray(agents.id, ids), isNotNull(agents.terminatedAt)))
      .orderBy(asc(agents.terminatedAt), asc(agents.id));
  }
  /**
   * S7 §10.2: the agent's last activity, as its own statement (never inside a batch's transaction, which holds message
   * rows: an agents-row update after them would invert the lock order). `greatest` keeps a late write from moving it
   * backwards.
   */
  async setLastActivity(agentId: string, at: Date) {
    await this.db
      .update(agents)
      .set({
        lastActivityAt: sql`greatest(${agents.lastActivityAt}, ${at.toISOString()}::timestamptz)`,
      })
      .where(eq(agents.id, agentId));
  }
  /**
   * S7 §10.3 step 1: live spawned agents idle since before `cutoff`, except those owed a continue notice and those
   * whose credential is paused at `now` (a rate-limit pause is waiting, not idleness). The runtime re-checks each.
   */
  async ttlCandidates(cutoff: Date, now: Date): Promise<AgentRow[]> {
    const rows = await this.db
      .select({ agent: agents })
      .from(agents)
      .leftJoin(credentials, eq(credentials.id, agents.credentialId))
      .where(
        and(
          eq(agents.kind, "ephemeral"),
          isNull(agents.terminatedAt),
          isNull(agents.archivedAt),
          lt(agents.lastActivityAt, cutoff),
          eq(agents.rateLimitNoticeOwed, false),
          or(isNull(credentials.rateLimitedUntil), lte(credentials.rateLimitedUntil, now)),
        ),
      )
      .orderBy(asc(agents.lastActivityAt), asc(agents.id));
    return rows.map((r) => r.agent);
  }
  /**
   * S7 §10.3 step 2, bounded (never every terminated agent): a failed stop or removal (`stop_failed`, which every
   * failed container removal sets), a journal still kept, or a termination recent enough that its stop may still be
   * in flight (`terminated_at > recentCutoff`).
   */
  async stuckCandidates(recentCutoff: Date): Promise<AgentRow[]> {
    return this.db
      .select()
      .from(agents)
      .where(
        and(
          isNotNull(agents.terminatedAt),
          or(
            eq(agents.errorKind, "stop_failed"),
            isNotNull(agents.runtimeJournal),
            gt(agents.terminatedAt, recentCutoff),
          ),
        ),
      )
      .orderBy(asc(agents.terminatedAt), asc(agents.id));
  }
  /** S7 §10.3 step 3: terminated before `cutoff`, its workspace neither pinned nor deleted yet. */
  async workspaceCandidates(cutoff: Date): Promise<AgentRow[]> {
    return this.db
      .select()
      .from(agents)
      .where(
        and(
          lt(agents.terminatedAt, cutoff),
          eq(agents.workspacePinned, false),
          isNull(agents.workspaceDeletedAt),
        ),
      )
      .orderBy(asc(agents.terminatedAt), asc(agents.id));
  }
  /** S7 §10.4: under the workspace lock, so a deletion that re-reads it under the same lock sees the pin. */
  async setWorkspacePinned(agentId: string, pinned: boolean) {
    await this.db.update(agents).set({ workspacePinned: pinned }).where(eq(agents.id, agentId));
  }
  async setWorkspaceDeleted(agentId: string, at: Date) {
    await this.db.update(agents).set({ workspaceDeletedAt: at }).where(eq(agents.id, agentId));
  }
  /** Replaces the whole journal (spec §12); null clears it. */
  async setRuntimeJournal(agentId: string, runtimeJournal: RuntimeJournal | null) {
    await this.db.update(agents).set({ runtimeJournal }).where(eq(agents.id, agentId));
  }
  /**
   * Boot (spec §5.7 step 4): every agent still `attempting` was in an attempt when the server stopped. It becomes
   * errored (its error kept when it already had one, else `crash` with `message`) and the attempt clears. Returns ids.
   */
  async failCutShortAttempts(message: string): Promise<string[]> {
    const rows = await this.db
      .update(agents)
      .set({
        status: "errored",
        lastError: sql`coalesce(${agents.lastError}, ${message})`,
        errorKind: sql`coalesce(${agents.errorKind}, 'crash')`,
        attempting: false,
      })
      .where(and(eq(agents.attempting, true), isNull(agents.terminatedAt)))
      .returning({ id: agents.id });
    return rows.map((r) => r.id);
  }
  /**
   * Boot (spec §5.7 step 6, §8): the live (not archived, not terminated), non-errored agents with deliverable pending items, by their oldest
   * such item (FIFO across the restart). Deliverable: a message or a notice, or a member update older than the
   * debounce (a young one waits for its timer; peer rows never wake anyone). `resume` when a factory-restarted notice
   * is among them.
   */
  async bootWakes(debounceMs: number): Promise<{ id: string; slug: string; resume: boolean }[]> {
    const deliverable = this.deliverableWhere(debounceMs);
    const rows = await this.db
      .select({
        id: agents.id,
        slug: agents.slug,
        resume: sql<boolean>`bool_or(${messages.notice} = 'factory_restarted')`,
      })
      .from(agents)
      .innerJoin(
        messages,
        and(eq(messages.toAgentId, agents.id), eq(messages.state, "pending"), deliverable),
      )
      .where(
        and(
          isNull(agents.archivedAt),
          isNull(agents.terminatedAt),
          sql`${agents.status} <> 'errored'`,
        ),
      )
      .groupBy(agents.id, agents.slug)
      .orderBy(sql`min(${messages.createdAt})`, asc(agents.id));
    return rows.map((r) => ({ ...r, resume: Boolean(r.resume) }));
  }
  private deliverableWhere(debounceMs: number) {
    const cutoff = new Date(Date.now() - debounceMs);
    return sql`(${messages.kind} in ('message', 'system') or (${messages.kind} = 'member_update' and ${messages.createdAt} <= ${cutoff.toISOString()}::timestamptz))`;
  }
  /** Live (not archived, not terminated), non-errored agents with at least one pending member update still inside the debounce window. */
  async agentsWithYoungUpdates(debounceMs: number): Promise<string[]> {
    const cutoff = new Date(Date.now() - debounceMs);
    const rows = await this.db
      .selectDistinct({ id: messages.toAgentId })
      .from(messages)
      .innerJoin(agents, eq(agents.id, messages.toAgentId))
      .where(
        and(
          eq(messages.kind, "member_update"),
          eq(messages.state, "pending"),
          sql`${messages.createdAt} > ${cutoff.toISOString()}::timestamptz`,
          isNull(agents.archivedAt),
          isNull(agents.terminatedAt),
          sql`${agents.status} <> 'errored'`,
        ),
      );
    return rows.flatMap((r) => (r.id ? [r.id] : []));
  }
  /**
   * Boot (S7 §8, §12): rows still pending to a terminated agent (one that raced in during the crash window, after the
   * termination's transaction rejected the rest) become `rejected`, as `terminateRows` makes them.
   */
  async rejectPendingToTerminated() {
    await this.db
      .update(messages)
      .set({ state: "rejected" })
      .where(
        and(
          eq(messages.state, "pending"),
          inArray(
            messages.toAgentId,
            this.db.select({ id: agents.id }).from(agents).where(isNotNull(agents.terminatedAt)),
          ),
        ),
      );
  }
  /**
   * Boot (S7 §8 crash safety): terminated agents with no `terminated` event (the server died between the termination's
   * commit and its stop job). Each `NOT EXISTS` is one probe of the partial index `session_events_terminated_idx`;
   * only the rare crash-window agents come back.
   */
  async terminatedWithoutEvent(): Promise<
    { id: string; slug: string; runtime: string; terminatedBy: string | null }[]
  > {
    return this.db
      .select({
        id: agents.id,
        slug: agents.slug,
        runtime: agents.runtime,
        terminatedBy: agents.terminatedBy,
      })
      .from(agents)
      .where(
        and(
          isNotNull(agents.terminatedAt),
          sql`not exists (select 1 from ${sessionEvents} e where e.agent_id = ${agents.id} and e.type = 'terminated')`,
        ),
      )
      .orderBy(asc(agents.id));
  }
  /** Boot (spec §5.7 step 7): every journal was read and acted on, except those of `keep` (a reap that failed). */
  async clearRuntimeJournals(keep: string[] = []) {
    await this.db
      .update(agents)
      .set({ runtimeJournal: null })
      .where(
        and(
          isNotNull(agents.runtimeJournal),
          ...(keep.length ? [notInArray(agents.id, keep)] : []),
        ),
      );
  }
  /** The cut-off agent is owed one continue notice at the reset (spec §7.3). */
  async setNoticeOwed(agentId: string, owed: boolean) {
    await this.db.update(agents).set({ rateLimitNoticeOwed: owed }).where(eq(agents.id, agentId));
  }
  /** The live (not archived, not terminated) agents on the credential that are owed a continue notice. */
  async owedAgents(credentialId: string): Promise<{ id: string; slug: string }[]> {
    return this.db
      .select({ id: agents.id, slug: agents.slug })
      .from(agents)
      .where(
        and(
          eq(agents.credentialId, credentialId),
          eq(agents.rateLimitNoticeOwed, true),
          isNull(agents.archivedAt),
          isNull(agents.terminatedAt),
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

  /**
   * Boot (spec §5.7 step 3): turns still open when the server stopped are closed as `factory_restarted`, errors.
   * Returns the ids of the agents that had one.
   */
  async closeDanglingTurns(): Promise<string[]> {
    const rows = await this.db
      .update(turns)
      .set({ endedAt: new Date(), isError: true, terminalReason: "factory_restarted" })
      .where(isNull(turns.endedAt))
      .returning({ agentId: turns.agentId });
    return [...new Set(rows.map((r) => r.agentId))];
  }

  // messages
  /** A message to an agent. The clock is the server's (spec §7.3), never the column default. Returns the joined row. */
  async createMessage(
    m: {
      from: { userId: string } | { agentId: string };
      toAgentId: string;
      body: string;
      urgent: boolean;
      fromToolUseId?: string | null;
    },
    tx: Exec = this.db,
  ): Promise<PendingRow> {
    const id = randomUUID();
    await tx.insert(messages).values({
      id,
      kind: "message",
      ...("userId" in m.from ? { fromUserId: m.from.userId } : { fromAgentId: m.from.agentId }),
      toAgentId: m.toAgentId,
      body: m.body,
      urgent: m.urgent,
      fromToolUseId: m.fromToolUseId ?? null,
      createdAt: this.stamp(),
    });
    return this.pendingRow(id, tx);
  }
  /** A held peer or member-update row, pending until the runtime renders it (spec §8). Returns the joined row. */
  async createHeld(
    m: {
      kind: "member_update" | "peer_joined" | "peer_left";
      toAgentId: string;
      fromAgentId?: string;
      subjectAgentId?: string;
      notice?: string;
      body: string;
    },
    tx: Exec = this.db,
  ): Promise<PendingRow> {
    const id = randomUUID();
    await tx.insert(messages).values({
      id,
      kind: m.kind,
      toAgentId: m.toAgentId,
      fromAgentId: m.fromAgentId ?? null,
      subjectAgentId: m.subjectAgentId ?? null,
      notice: m.notice ?? null,
      body: m.body,
      createdAt: this.stamp(),
    });
    return this.pendingRow(id, tx);
  }
  /**
   * A message (or factory fact) for humans: delivered at once, with one inbox item per existing user (or the one
   * addressed), in one transaction (spec §7.4); inside `tx` when given (a savepoint of the caller's transaction).
   */
  async createHumanMessage(
    m: {
      fromAgentId: string | null;
      notice?: string;
      subjectAgentId?: string;
      kind: "message" | "system";
      to: { userId: string } | "all";
      body: string;
      urgent: boolean;
      fromToolUseId?: string | null;
    },
    outer: Exec = this.db,
  ): Promise<{ row: MessageRow; userIds: string[] }> {
    return outer.transaction(async (tx) => {
      if (m.kind === "system" ? !m.subjectAgentId : !m.fromAgentId)
        throw new Error(
          "a human message needs a sender agent; a factory fact needs its subject agent",
        );
      const now = this.stamp();
      const [row] = await tx
        .insert(messages)
        .values({
          id: randomUUID(),
          kind: m.kind,
          fromAgentId: m.fromAgentId,
          notice: m.notice ?? null,
          subjectAgentId: m.subjectAgentId ?? null,
          toUserId: m.to === "all" ? null : m.to.userId,
          toAllHumans: m.to === "all",
          fromToolUseId: m.fromToolUseId ?? null,
          body: m.body,
          urgent: m.urgent,
          state: "delivered",
          createdAt: now,
          deliveredAt: now,
        })
        .returning();
      if (!row) throw new Error("insert returned no row");
      const targets =
        m.to === "all"
          ? await tx.select({ id: users.id }).from(users).orderBy(asc(users.id))
          : [{ id: m.to.userId }];
      const userIds = targets.map((u) => u.id);
      if (userIds.length)
        await tx.insert(inboxItems).values(
          userIds.map((userId) => ({
            id: randomUUID(),
            userId,
            kind: "message" as const,
            messageId: row.id,
            createdAt: now,
          })),
        );
      return { row, userIds };
    });
  }
  /** One row with the same joins as the queue (sender handle and slug, subject slug and name), whatever its state. */
  async pendingRow(id: string, tx: Exec = this.db): Promise<PendingRow> {
    const [r] = await this.joined(tx).where(eq(messages.id, id));
    if (!r) throw new Error(`message ${id} not found`);
    return r;
  }
  private joined(tx: Exec) {
    const fa = alias(agents, "fa");
    const sa = alias(agents, "sa");
    const q = tx
      .select({
        m: messages,
        fromHandle: users.handle,
        fromSlug: fa.slug,
        subjectSlug: sa.slug,
        subjectDisplayName: sa.displayName,
      })
      .from(messages)
      .leftJoin(users, eq(users.id, messages.fromUserId))
      .leftJoin(fa, eq(fa.id, messages.fromAgentId))
      .leftJoin(sa, eq(sa.id, messages.subjectAgentId));
    return {
      where: async (w: SQL | undefined, order: SQL[] = []): Promise<PendingRow[]> => {
        const rows = await q.where(w).orderBy(...order);
        return rows.map(({ m, ...rest }) => ({ ...m, ...rest }));
      },
    };
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
        createdAt: this.stamp(),
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
  /** Pending items in delivery order (system notices first, then by age), as the joined row. */
  async pendingQueue(agentId: string): Promise<PendingRow[]> {
    return this.joined(this.db).where(
      and(eq(messages.toAgentId, agentId), eq(messages.state, "pending")),
      [sql`(${messages.kind} = 'system') desc`, asc(messages.createdAt), asc(messages.id)],
    );
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
        .set({
          state: "pending",
          deliveredAt: null,
          deliveredTurnId: null,
          deliveredEventSeq: null,
        })
        .where(inArray(messages.id, ids));
  }
  async setDeliveredTurn(ids: string[], turnId: string, tx: Exec = this.db) {
    if (ids.length)
      await tx.update(messages).set({ deliveredTurnId: turnId }).where(inArray(messages.id, ids));
  }
  /** The recipient's session event that carries the delivered batch (spec §11); written with the batch. */
  async setDeliveredEventSeq(ids: string[], seq: number, tx: Exec = this.db) {
    if (ids.length)
      await tx.update(messages).set({ deliveredEventSeq: seq }).where(inArray(messages.id, ids));
  }
  /** The recipient was archived between the send check and the hand-off: the row tells the truth (spec §7.3). */
  async markRejected(id: string, tx: Exec = this.db) {
    await tx
      .update(messages)
      .set({ state: "rejected" })
      .where(and(eq(messages.id, id), eq(messages.state, "pending")));
  }

  /** One message with the events that show it on each side (spec §11); from and to rendered as in the inbox. */
  async messageLookup(id: string): Promise<MessageLookup | undefined> {
    const fa = alias(agents, "fa");
    const ta = alias(agents, "ta");
    const fu = alias(users, "fu");
    const tu = alias(users, "tu");
    const [r] = await this.db
      .select({
        m: messages,
        fromSlug: fa.slug,
        fromHandle: fu.handle,
        toSlug: ta.slug,
        toHandle: tu.handle,
      })
      .from(messages)
      .leftJoin(fa, eq(fa.id, messages.fromAgentId))
      .leftJoin(fu, eq(fu.id, messages.fromUserId))
      .leftJoin(ta, eq(ta.id, messages.toAgentId))
      .leftJoin(tu, eq(tu.id, messages.toUserId))
      .where(eq(messages.id, id));
    if (!r) return undefined;
    const { m } = r;
    const out: MessageLookup = {
      id: m.id,
      kind: m.kind as MessageLookup["kind"],
      from: r.fromSlug ?? (r.fromHandle ? `@${r.fromHandle}` : "@factory"),
      to: m.toAllHumans ? "@humans" : (r.toSlug ?? `@${r.toHandle ?? ""}`),
      state: m.state as MessageLookup["state"],
    };
    if (m.state === "delivered" && m.deliveredEventSeq !== null && r.toSlug)
      out.recipientEvent = { agentSlug: r.toSlug, seq: m.deliveredEventSeq };
    const sender = await this.senderEvent(m);
    if (sender) out.senderEvent = sender;
    return out;
  }
  private async senderEvent(
    m: MessageRow,
  ): Promise<{ agentSlug: string; seq: number } | undefined> {
    if (!m.fromAgentId || !m.fromToolUseId) return undefined;
    const [row] = await this.db
      .select({ seq: sessionEvents.seq, slug: agents.slug })
      .from(sessionEvents)
      .innerJoin(agents, eq(agents.id, sessionEvents.agentId))
      .where(
        and(
          eq(sessionEvents.agentId, m.fromAgentId),
          eq(sessionEvents.type, "tool_call"),
          sql`${sessionEvents.payload}->>'toolUseId' = ${m.fromToolUseId}`,
        ),
      )
      .limit(1);
    return row ? { agentSlug: row.slug, seq: row.seq } : undefined;
  }

  /** The sender's tool-call events for several messages in one query, by message id. */
  private async senderEvents(
    rows: MessageRow[],
  ): Promise<Map<string, { agentSlug: string; seq: number }>> {
    const withCall = rows.filter((m) => m.fromAgentId && m.fromToolUseId);
    const out = new Map<string, { agentSlug: string; seq: number }>();
    if (!withCall.length) return out;
    const pairs = sql.join(
      withCall.map((m) => sql`(${m.fromAgentId}, ${m.fromToolUseId})`),
      sql`, `,
    );
    const found = await this.db
      .select({
        agentId: sessionEvents.agentId,
        toolUseId: sql<string>`${sessionEvents.payload}->>'toolUseId'`,
        seq: sessionEvents.seq,
        slug: agents.slug,
      })
      .from(sessionEvents)
      .innerJoin(agents, eq(agents.id, sessionEvents.agentId))
      .where(
        and(
          eq(sessionEvents.type, "tool_call"),
          sql`(${sessionEvents.agentId}, ${sessionEvents.payload}->>'toolUseId') in (${pairs})`,
        ),
      )
      .orderBy(asc(sessionEvents.seq));
    for (const m of withCall) {
      const f = found.find((x) => x.agentId === m.fromAgentId && x.toolUseId === m.fromToolUseId);
      if (f) out.set(m.id, { agentSlug: f.slug, seq: f.seq });
    }
    return out;
  }

  /** The user's inbox, newest first. Cursor is `created_at|id` in base64url (spec §11). */
  async inboxPage(
    userId: string,
    before?: string,
    limit = 50,
  ): Promise<{ items: InboxEntry[]; nextCursor: string | null }> {
    const fa = alias(agents, "fa");
    const sa = alias(agents, "sa");
    const tu = alias(users, "tu");
    let cursor: SQL | undefined;
    if (before) {
      const [at, id] = Buffer.from(before, "base64url").toString().split("|");
      if (!at || !id || !isCursorInstant(at)) throw new InvalidCursorError();
      cursor = sql`(${inboxItems.createdAt}, ${inboxItems.id}) < (${at}::timestamptz, ${id})`;
    }
    const rows = await this.db
      .select({
        item: inboxItems,
        m: messages,
        fromSlug: fa.slug,
        subjectSlug: sa.slug,
        toHandle: tu.handle,
        preview: sql<string>`left(${messages.body}, 280)`,
        createdAtIso: sql<string>`to_char(${inboxItems.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
      })
      .from(inboxItems)
      .innerJoin(messages, eq(messages.id, inboxItems.messageId))
      .leftJoin(fa, eq(fa.id, messages.fromAgentId))
      .leftJoin(sa, eq(sa.id, messages.subjectAgentId))
      .leftJoin(tu, eq(tu.id, messages.toUserId))
      .where(and(eq(inboxItems.userId, userId), cursor))
      .orderBy(desc(inboxItems.createdAt), desc(inboxItems.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const senders = await this.senderEvents(page.map((r) => r.m));
    const items: InboxEntry[] = [];
    for (const r of page) {
      const factory = r.m.kind === "system" || !r.fromSlug;
      const sender = senders.get(r.m.id);
      const agentSlug =
        sender?.agentSlug ?? (factory ? r.subjectSlug : r.fromSlug) ?? r.subjectSlug ?? "";
      items.push({
        id: r.item.id,
        messageId: r.m.id,
        from: factory
          ? { kind: "factory", name: "factory" }
          : { kind: "agent", name: r.fromSlug ?? "" },
        ...(r.subjectSlug ? { about: r.subjectSlug } : {}),
        to: r.m.toAllHumans ? "@humans" : `@${r.toHandle ?? ""}`,
        preview: r.preview,
        urgent: r.m.urgent,
        createdAt: r.item.createdAt.toISOString(),
        link: { agentSlug, ...(sender ? { seq: sender.seq } : {}) },
      });
    }
    const last = page.at(-1);
    const nextCursor =
      rows.length > limit && last
        ? Buffer.from(`${last.createdAtIso}|${last.item.id}`).toString("base64url")
        : null;
    return { items, nextCursor };
  }
}
