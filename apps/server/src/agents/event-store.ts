import { randomUUID } from "node:crypto";
import { type AgentRow, type Db, type RuntimeJournal, schema } from "@open-factory/db";
import {
  type AnyEvent,
  anyEventSchema,
  boundVersion,
  type Command,
  type ErrorKind,
  formatKey,
  type InboxItem,
  type MessageAttachment,
  type MessageKind,
  parseCommands,
  plainPreview,
  type SessionEvent,
  type TaskNotice,
  taskKey,
} from "@open-factory/shared";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  notInArray,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { capPayload } from "./cap.ts";
import { InvalidCursorError } from "./errors.ts";
import { type NoticeType, parseConfigNotice, renderConfigNotice } from "./notices.ts";

/**
 * Only an instant `inboxPage` minted (UTC ISO, microseconds kept) is accepted, so nothing malformed reaches Postgres;
 * the round trip rejects calendar dates that don't exist (2026-02-31), and the year must be at least 1.
 */
export function isCursorInstant(at: string): boolean {
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
  tasks,
  schedules,
  users,
} = schema;
type MessageRow = typeof messages.$inferSelect;
/** The one joined row shape the queue and the runtime use (spec §7.3): the row plus who sent it and what it is about. */
export type PendingRow = MessageRow & {
  fromHandle: string | null;
  fromSlug: string | null;
  subjectSlug: string | null;
  subjectDisplayName: string | null;
  /** S8: the task a task message is about (`T-<number>`, its current title). */
  taskNumber: number | null;
  taskTitle: string | null;
  /** S9: a `scheduled` row's schedule (`S-<number>`), its zone, and its author (`@handle` or slug). */
  scheduleKey: string | null;
  scheduleZone: string | null;
  authorLabel: string | null;
  authorKind: "human" | "agent" | null;
};
export interface MessageLookup {
  id: string;
  kind: MessageKind;
  from: string;
  fromKind: "human" | "agent" | "factory";
  to: string;
  state: "pending" | "delivered" | "rejected" | "cancelled";
  recipientEvent?: { agentSlug: string; seq: number };
  senderEvent?: { agentSlug: string; seq: number };
  scheduleKey?: string;
  firings?: number;
  late?: boolean;
  dueAt?: string;
}
/** One agent's unread messages to a user (I1 §6.7); the route adds the agent's summary. */
/** How much of a message body `plainPreview` reads: generous, so a fence or link closing late still renders. */
const PREVIEW_PREFIX = 20_000;
export type UnreadChat = {
  slug: string;
  unread: number;
  latest: { messageId: string; preview: string; createdAt: string; urgent: boolean };
};
export interface InboxEntry {
  id: string;
  messageId: string;
  kind: InboxItem["kind"];
  read: boolean;
  from: { kind: "agent" | "human" | "factory"; name: string };
  about?: string;
  to: string;
  preview: string;
  urgent: boolean;
  createdAt: string;
  /** The task a mention or task event is about (its current title). */
  task?: { key: string; title: string };
  /** A task event's notice, so the UI never parses the preview. */
  fact?: "done" | "cancelled";
  /** The credential a `credential` item is about; `current` while its expiry notice has not been re-armed. */
  credential?: { name: string; expiresAt: string | null; current: boolean };
  link:
    | { kind: "session"; agentSlug: string; seq?: number }
    | { kind: "task"; key: string; commentId?: string }
    | { kind: "credential"; name: string };
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
  /** The one clock owner: `TaskStore` and the inbox read stamps share it. */
  clock(): Date {
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
  /**
   * U3 §13.3: the command list of the agent's latest process start (a side table, never on agent reads). Only
   * well-formed entries are stored (name format and sizes, at most MAX_COMMANDS), and a version only when it is a
   * short plain string. Resolves how many entries were dropped.
   */
  async saveCommands(
    agentId: string,
    list: Command[],
    claudeCodeVersion: string | null,
  ): Promise<{ dropped: number }> {
    const commands = parseCommands(list);
    const dropped = list.length - commands.length; // malformed, or past the cap
    const values = {
      commands,
      claudeCodeVersion: boundVersion(claudeCodeVersion) ?? null,
      at: this.clock(),
    };
    await this.db
      .insert(schema.agentCommands)
      .values({ agentId, ...values })
      .onConflictDoUpdate({ target: schema.agentCommands.agentId, set: values });
    return { dropped };
  }
  async agentCommands(agentId: string) {
    const [row] = await this.db
      .select()
      .from(schema.agentCommands)
      .where(eq(schema.agentCommands.agentId, agentId));
    return row;
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
    const now = this.clock();
    await tx
      .update(agents)
      .set({ terminatedAt: now, terminatedBy: by, attempting: false, updatedAt: now })
      .where(eq(agents.id, agentId));
    await tx.delete(agentProjectGrants).where(eq(agentProjectGrants.agentId, agentId));
    const rejected = await this.rejectPending(agentId, tx);
    // S9 §10.1: a terminated target's schedules are soft-deleted in the same transaction, after the agent locks
    // (agents before schedules). Soft: delivered `scheduled` rows keep their schedule, and Restore refuses.
    await tx
      .update(schedules)
      .set({ deletedAt: now, nextRunAt: null, updatedAt: now })
      .where(and(eq(schedules.targetAgentId, agentId), isNull(schedules.deletedAt)));
    return rejected;
  }
  /**
   * Every pending row addressed to the agent becomes `rejected` (a terminated agent receives nothing). Resolves to the
   * human senders of those rows, for their `chat_changed`.
   */
  async rejectPending(agentId: string, tx: Exec = this.db): Promise<string[]> {
    const rows = await tx
      .update(messages)
      .set({ state: "rejected" })
      .where(and(eq(messages.toAgentId, agentId), eq(messages.state, "pending")))
      .returning({ from: messages.fromUserId });
    return [...new Set(rows.flatMap((r) => (r.from ? [r.from] : [])))];
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
   * such item (FIFO across the restart). Deliverable: a message, a notice or a member update (it waits only out
   * its debounce while the agent runs; peer rows never wake anyone). `resume` when a factory-restarted notice
   * is among them.
   */
  async bootWakes(): Promise<{ id: string; slug: string; resume: boolean }[]> {
    const deliverable = this.deliverableWhere();
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
  /** Pending rows that wake an agent at boot; member updates don't: their runtime's debounce timer does (I9 §4.8). */
  private deliverableWhere() {
    return sql`(${messages.kind} in ('message', 'task_assigned', 'task_comment', 'task_update', 'scheduled') or (${messages.kind} = 'system' and ${messages.notice} not in ('crons_stopped', 'config_changed', 'report_config_changed')))`;
  }
  /** Live (not archived, not terminated), non-errored agents with at least one pending member update. */
  async agentsWithPendingUpdates(): Promise<string[]> {
    const rows = await this.db
      .selectDistinct({ id: messages.toAgentId })
      .from(messages)
      .innerJoin(agents, eq(agents.id, messages.toAgentId))
      .where(
        and(
          eq(messages.kind, "member_update"),
          eq(messages.state, "pending"),
          isNull(agents.archivedAt),
          isNull(agents.terminatedAt),
          sql`${agents.status} <> 'errored'`,
        ),
      );
    return rows.flatMap((r) => (r.id ? [r.id] : []));
  }
  /**
   * Boot (S9 §5): at boot no runtime is loaded, so a pending row's write mark (`delivered_event_seq`, set when a batch
   * was written to a process that hadn't started yet) is stale: the process is gone. Only `markPending` (the exit
   * rollback) cleared it before, so after a crash a row written to a not-yet-started process kept its seq forever and
   * a firing would never have replaced it. Delivered rows keep theirs (deep links).
   */
  async clearStaleWriteMarks(): Promise<void> {
    await this.db
      .update(messages)
      .set({ deliveredEventSeq: null, deliveredTurnId: null })
      .where(and(eq(messages.state, "pending"), isNotNull(messages.deliveredEventSeq)));
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
  /** Latest rate-limit status the CLI reported for a credential; an older observation never overwrites a newer one. */
  async recordRateLimit(
    credentialId: string,
    s: {
      status: "allowed" | "allowed_warning" | "rejected";
      rateLimitType?: string;
      utilization?: number;
      resetsAt?: number;
    },
    at: Date,
  ): Promise<void> {
    await this.db
      .update(credentials)
      .set({
        rlStatus: s.status,
        rlType: s.rateLimitType ?? null,
        rlUtilization: s.utilization ?? null,
        rlResetsAt: s.resetsAt === undefined ? null : new Date(s.resetsAt * 1000),
        rlObservedAt: at,
        // Set explicitly so `$onUpdate` doesn't bump it: updated_at means the credential was edited.
        updatedAt: sql`${credentials.updatedAt}`,
      })
      .where(
        and(
          eq(credentials.id, credentialId),
          or(isNull(credentials.rlObservedAt), lte(credentials.rlObservedAt, at)),
        ),
      );
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
  async openTurn(
    agentId: string,
    credentialId: string | null,
    tx: Exec = this.db,
  ): Promise<string> {
    const id = randomUUID();
    await tx.insert(turns).values({ id, agentId, credentialId, startedAt: new Date() });
    return id;
  }
  /**
   * `endEventSeq` is the turn's `turn_end` seq for a normal close; otherwise (an exit, a boot close) the turn's last
   * event seq, null when it has none (I1 §6.3).
   */
  async closeTurn(turnId: string, d: TurnClose, tx: Exec = this.db, endEventSeq?: number) {
    const u = d.usage;
    await tx
      .update(turns)
      .set({
        endedAt: new Date(),
        endEventSeq:
          endEventSeq ?? sql`(select max(seq) from session_events where turn_id = ${turnId})`,
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
   * S10 §5.2: the turn's task when every delivered non-system message carries that one task (a lower bound): any
   * message without it (a human's, an agent's, a schedule's) or of another task leaves the turn unattributed.
   */
  async attributeTask(turnId: string, tx: Exec): Promise<void> {
    await tx.execute(sql`
      update turns set task_id = (
        select min(task_id) from messages
        where delivered_turn_id = ${turnId} and kind not in ('system', 'member_update', 'peer_joined', 'peer_left')
        having count(*) > 0 and count(*) = count(task_id) and count(distinct task_id) = 1
      )
      where id = ${turnId}`);
  }
  /** One transaction: stamp `stampIds` with the turn (when given), close it, and attribute it when `attribute` is true. */
  async closeTurnWith(
    turnId: string,
    d: TurnClose,
    stampIds: string[],
    attribute: boolean,
    endEventSeq?: number,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      await this.setDeliveredTurn(stampIds, turnId, tx);
      await this.closeTurn(turnId, d, tx, endEventSeq);
      if (attribute) await this.attributeTask(turnId, tx);
    });
  }

  /**
   * Boot (spec §5.7 step 3): turns still open when the server stopped are closed as `factory_restarted`, errors.
   * In the same transaction each agent's delivered, unstamped `message` rows written after its previous closed turn
   * ended are stamped with its turn (I1 §6.3; older ones belong to no turn): the
   * starting batch is stamped only at close, so a restart leaves it unstamped. Absorbed rows were stamped when written.
   * Returns the ids of the agents that had one.
   */
  async closeDanglingTurns(): Promise<string[]> {
    return this.db.transaction(async (tx) => {
      const open = await tx
        .select({ id: turns.id, agentId: turns.agentId })
        .from(turns)
        .where(isNull(turns.endedAt))
        .for("update");
      for (const t of open) {
        await tx.execute(sql`
          update messages set delivered_turn_id = ${t.id}
          where to_agent_id = ${t.agentId} and kind = 'message' and state = 'delivered'
            and delivered_turn_id is null and delivered_event_seq is not null
            and delivered_event_seq > coalesce((select max(end_event_seq) from turns
              where agent_id = ${t.agentId} and ended_at is not null and id <> ${t.id}), 0)`);
        await this.closeTurn(t.id, { isError: true, terminalReason: "factory_restarted" }, tx);
      }
      return [...new Set(open.map((t) => t.agentId))];
    });
  }

  // messages
  /** A message to an agent. The clock is the server's (spec §7.3), never the column default. Returns the joined row. */
  async createMessage(
    m: {
      from: { userId: string } | { agentId: string };
      toAgentId: string;
      /** The full recipient list as `@handle`s (what the envelope's `to` shows), this row's agent among them. */
      recipients: string[];
      body: string;
      urgent: boolean;
      fromToolUseId?: string | null;
      clientMessageId?: string | null;
      attachments?: MessageAttachment[] | null;
    },
    tx: Exec = this.db,
  ): Promise<PendingRow> {
    const id = randomUUID();
    await tx.insert(messages).values({
      id,
      kind: "message",
      clientMessageId: m.clientMessageId ?? null,
      attachments: m.attachments?.length ? m.attachments : null,
      ...("userId" in m.from ? { fromUserId: m.from.userId } : { fromAgentId: m.from.agentId }),
      toAgentId: m.toAgentId,
      recipients: m.recipients,
      body: m.body,
      urgent: m.urgent,
      fromToolUseId: m.fromToolUseId ?? null,
      createdAt: this.clock(),
    });
    return this.pendingRow(id, tx);
  }
  /**
   * U3 §13.2: a human's send carrying the client's id. The unique partial index on (`from_user_id`,
   * `client_message_id`, `to_agent_id`) decides: a repeat (the same sender, id and recipient agent, at any later
   * time, or concurrently) inserts nothing and returns the original row with `created: false`.
   */
  async createClientMessage(
    m: {
      fromUserId: string;
      toAgentId: string;
      recipients: string[];
      body: string;
      urgent: boolean;
      clientMessageId: string;
      attachments?: MessageAttachment[] | null;
    },
    tx: Exec = this.db,
  ): Promise<{ row: PendingRow; created: boolean }> {
    const id = randomUUID();
    const inserted = await tx
      .insert(messages)
      .values({
        id,
        kind: "message",
        clientMessageId: m.clientMessageId,
        attachments: m.attachments?.length ? m.attachments : null,
        fromUserId: m.fromUserId,
        toAgentId: m.toAgentId,
        recipients: m.recipients,
        body: m.body,
        urgent: m.urgent,
        createdAt: this.clock(),
      })
      .onConflictDoNothing({
        target: [messages.fromUserId, messages.clientMessageId, messages.toAgentId],
        where: sql`${messages.clientMessageId} is not null`,
      })
      .returning({ id: messages.id });
    if (inserted.length) return { row: await this.pendingRow(id, tx), created: true };
    const existing = (await this.byClientMessageId(m.fromUserId, m.clientMessageId, tx)).find(
      (r) => r.toAgentId === m.toAgentId,
    );
    if (!existing)
      throw new Error(`client message ${m.clientMessageId} conflicted but isn't there`);
    return { row: existing, created: false };
  }
  /** U3 §13.2: the joined rows (one per recipient agent) a sender's earlier send with this client id wrote, whatever their state. */
  async byClientMessageId(
    fromUserId: string,
    clientMessageId: string,
    tx: Exec = this.db,
  ): Promise<PendingRow[]> {
    const rows = await this.joined(tx).where(
      and(eq(messages.fromUserId, fromUserId), eq(messages.clientMessageId, clientMessageId)),
    );
    return rows.sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id),
    );
  }
  /** A member update or peer event (the org's rows about an agent's neighbours), pending until written (spec §8). Returns the joined row. */
  async createOrgRow(
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
      createdAt: this.clock(),
    });
    return this.pendingRow(id, tx);
  }
  /**
   * S8: a task message to an agent, pending until the runtime renders it. `task_assigned` and `task_update` are from
   * the factory (no sender columns); a `task_comment` is from its author. Returns the joined row.
   */
  async createTaskMessage(
    tx: Exec,
    m: {
      kind: "task_assigned" | "task_comment" | "task_update";
      taskId: string;
      commentId?: string;
      notice?: TaskNotice;
      from?: { userId: string } | { agentId: string };
      toAgentId: string;
      body: string;
    },
  ): Promise<PendingRow> {
    const id = randomUUID();
    await tx.insert(messages).values({
      id,
      kind: m.kind,
      taskId: m.taskId,
      commentId: m.commentId ?? null,
      notice: m.notice ?? null,
      ...(m.from && "userId" in m.from ? { fromUserId: m.from.userId } : {}),
      ...(m.from && "agentId" in m.from ? { fromAgentId: m.from.agentId } : {}),
      toAgentId: m.toAgentId,
      body: m.body,
      createdAt: this.clock(),
    });
    return this.pendingRow(id, tx);
  }
  /**
   * A message (or factory fact) for humans: delivered at once, with one inbox item per existing user (or the one
   * addressed), in one transaction (spec §7.4); inside `tx` when given (a savepoint of the caller's transaction).
   */
  async createHumanMessage(
    m: {
      kind: "message" | "system" | "task_comment" | "task_update";
      fromAgentId?: string | null;
      /** A human author (a human's mention in a task comment). */
      fromUserId?: string;
      notice?: string;
      subjectAgentId?: string;
      /** I3: the credential a `system` notice is about. */
      subjectCredentialId?: string;
      taskId?: string;
      commentId?: string;
      /** The message's timestamp when it must equal another written elsewhere (the expiry check); the clock otherwise. */
      createdAt?: Date;
      /** `"all"` (every user) is for factory facts (`kind: "system"`) only; people are addressed by handle. */
      to: { userId: string } | "all";
      /** A `kind: "message"` row's recipient list, as `@handle`s. */
      recipients?: string[];
      /** The inbox item's kind; `message` when not given. */
      inboxKind?: "message" | "mention" | "task_event" | "credential";
      body: string;
      urgent: boolean;
      fromToolUseId?: string | null;
    },
    outer: Exec = this.db,
  ): Promise<{ row: MessageRow; userIds: string[] }> {
    return outer.transaction(async (tx) => {
      // Per kind, the sender columns the schema's CHECK allows, said as a sentence before the database says it.
      const authors = (m.fromAgentId ? 1 : 0) + (m.fromUserId ? 1 : 0);
      if (
        m.kind === "system"
          ? !m.subjectAgentId && !m.subjectCredentialId
          : m.kind === "message" && !m.fromAgentId
      )
        throw new Error(
          "a human message needs a sender agent; a factory fact needs its subject agent or credential",
        );
      if (m.kind === "message" && !m.recipients?.length)
        throw new Error("a human message needs its recipients");
      if (m.to === "all" && m.kind !== "system")
        throw new Error("only a factory fact goes to every human; address people by handle");
      if (m.kind === "task_update" && (authors > 0 || m.subjectAgentId))
        throw new Error("a task update has no sender and no subject");
      if (m.kind === "task_comment" && authors !== 1)
        throw new Error("a task comment needs exactly one author, an agent or a user");
      if ((m.kind === "task_comment" || m.kind === "task_update") && !m.taskId)
        throw new Error("a task message needs its task");
      const targets =
        m.to === "all"
          ? await tx.select({ id: users.id }).from(users).orderBy(asc(users.id))
          : [{ id: m.to.userId }];
      const userIds = targets.map((u) => u.id);
      const now = m.createdAt ?? this.clock();
      const [row] = await tx
        .insert(messages)
        .values({
          id: randomUUID(),
          kind: m.kind,
          fromAgentId: m.fromAgentId ?? null,
          fromUserId: m.fromUserId ?? null,
          notice: m.notice ?? null,
          subjectAgentId: m.subjectAgentId ?? null,
          subjectCredentialId: m.subjectCredentialId ?? null,
          taskId: m.taskId ?? null,
          commentId: m.commentId ?? null,
          toUserId: m.to === "all" ? null : m.to.userId,
          toAllHumans: m.to === "all",
          recipients: m.kind === "message" ? (m.recipients ?? null) : null,
          fromToolUseId: m.fromToolUseId ?? null,
          body: m.body,
          urgent: m.urgent,
          state: "delivered",
          createdAt: now,
          deliveredAt: now,
        })
        .returning();
      if (!row) throw new Error("insert returned no row");
      if (userIds.length)
        await tx.insert(inboxItems).values(
          userIds.map((userId) => ({
            id: randomUUID(),
            userId,
            kind: m.inboxKind ?? ("message" as const),
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
  /** S9: the joined row if it is still `pending` (rejected, delivered or gone: undefined). Re-reads what a firing replaced. */
  async pendingJoined(id: string, tx: Exec = this.db): Promise<PendingRow | undefined> {
    const [r] = await this.joined(tx).where(
      and(eq(messages.id, id), eq(messages.state, "pending")),
    );
    return r;
  }
  /**
   * S9 §8.2 rule 1: the rendered content of every `scheduled` row in a batch, written back in the transaction that
   * records the delivery, so the row says exactly what the agent read.
   */
  async writeBackScheduled(
    rows: Pick<
      MessageRow,
      "id" | "body" | "authorAgentId" | "authorUserId" | "dueAt" | "firings" | "late"
    >[],
    tx: Exec,
  ): Promise<void> {
    for (const r of rows)
      await tx
        .update(messages)
        .set({
          body: r.body,
          authorAgentId: r.authorAgentId,
          authorUserId: r.authorUserId,
          dueAt: r.dueAt,
          firings: r.firings,
          late: r.late,
        })
        .where(eq(messages.id, r.id));
  }
  private joined(tx: Exec) {
    const fa = alias(agents, "fa");
    const sa = alias(agents, "sa");
    const aa = alias(agents, "aa");
    const au = alias(users, "au");
    const q = tx
      .select({
        m: messages,
        fromHandle: users.handle,
        fromSlug: fa.slug,
        subjectSlug: sa.slug,
        subjectDisplayName: sa.displayName,
        taskNumber: tasks.number,
        taskTitle: tasks.title,
        scheduleNumber: schedules.number,
        scheduleZone: schedules.timezone,
        authorSlug: aa.slug,
        authorHandle: au.handle,
      })
      .from(messages)
      .leftJoin(users, eq(users.id, messages.fromUserId))
      .leftJoin(fa, eq(fa.id, messages.fromAgentId))
      .leftJoin(sa, eq(sa.id, messages.subjectAgentId))
      .leftJoin(tasks, eq(tasks.id, messages.taskId))
      .leftJoin(schedules, eq(schedules.id, messages.scheduleId))
      .leftJoin(aa, eq(aa.id, messages.authorAgentId))
      .leftJoin(au, eq(au.id, messages.authorUserId));
    return {
      where: async (w: SQL | undefined, order: SQL[] = []): Promise<PendingRow[]> => {
        const rows = await q.where(w).orderBy(...order);
        return rows.map(({ m, scheduleNumber, authorSlug, authorHandle, ...rest }) => ({
          ...m,
          ...rest,
          scheduleKey: scheduleNumber === null ? null : formatKey("S", scheduleNumber),
          authorLabel: authorHandle ? `@${authorHandle}` : authorSlug ? `@${authorSlug}` : null,
          authorKind: authorHandle ? "human" : authorSlug ? "agent" : null,
        }));
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
   * one's body (same row); a written (delivered) one, or one in `inFlightIds`, is never touched.
   *
   * `config_changed` (I2 §7.3) and `report_config_changed` (I7 §8.2) merge instead: the pending body's lines and the new body's are united, sorted, instead
   * of replaced (no other type's body has lines to unite), and the row's `createdAt` moves to now, because it now holds a change newer than any process already
   * running (the runtime holds such rows for the next process). Serialised per agent and type (and subject, for
   * `report_config_changed`: one row per manager and report), so two concurrent merges never create two rows. The
   * merged body keeps the newest header.
   */
  async createNotice(
    m: { toAgentId: string; notice: NoticeType; body: string; subjectAgentId?: string },
    o: {
      /** Ids written to a process but not yet marked delivered: never replaced or merged into. */
      inFlightIds?: string[];
    } = {},
  ): Promise<MessageRow> {
    const inFlightIds = o.inFlightIds ?? [];
    const pendingOne = and(
      eq(messages.toAgentId, m.toAgentId),
      eq(messages.kind, "system"),
      eq(messages.notice, m.notice),
      eq(messages.state, "pending"),
      m.subjectAgentId
        ? eq(messages.subjectAgentId, m.subjectAgentId)
        : isNull(messages.subjectAgentId),
      ...(inFlightIds.length ? [notInArray(messages.id, inFlightIds)] : []),
    );
    if (m.notice === "config_changed" || m.notice === "report_config_changed")
      return this.db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${`notice:${m.notice}:${m.toAgentId}:${m.subjectAgentId ?? ""}`}))`,
        );
        const [pending] = await tx
          .select()
          .from(messages)
          .where(pendingOne)
          .orderBy(asc(messages.createdAt), asc(messages.id))
          .limit(1)
          .for("update");
        if (pending) {
          const body = renderConfigNotice(
            [...parseConfigNotice(pending.body), ...parseConfigNotice(m.body)],
            m.body.split("\n", 1)[0],
          );
          const [row] = await tx
            .update(messages)
            .set({ body, createdAt: this.clock() })
            .where(eq(messages.id, pending.id))
            .returning();
          if (!row) throw new Error("update returned no row");
          return row;
        }
        return this.insertNotice(m, tx);
      });
    const [existing] = await this.db
      .update(messages)
      .set({ body: m.body })
      .where(pendingOne)
      .returning();
    if (existing) return existing;
    return this.insertNotice(m, this.db);
  }
  private async insertNotice(
    m: { toAgentId: string; notice: NoticeType; body: string; subjectAgentId?: string },
    tx: Exec,
  ): Promise<MessageRow> {
    const [row] = await tx
      .insert(messages)
      .values({
        id: randomUUID(),
        kind: "system",
        notice: m.notice,
        toAgentId: m.toAgentId,
        subjectAgentId: m.subjectAgentId ?? null,
        body: m.body,
        createdAt: this.clock(),
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
  /** One message row as stored, whatever its state; undefined when there is none. */
  async messageRow(id: string): Promise<MessageRow | undefined> {
    const [r] = await this.db.select().from(messages).where(eq(messages.id, id));
    return r;
  }
  /**
   * U3 §6.4: cancels a message only while nothing has written it (`pending` and no delivery event). False when the
   * row was written, rejected or already cancelled meanwhile.
   */
  async cancelPending(id: string): Promise<boolean> {
    const rows = await this.db
      .update(messages)
      .set({ state: "cancelled" })
      .where(
        and(eq(messages.id, id), eq(messages.state, "pending"), isNull(messages.deliveredEventSeq)),
      )
      .returning({ id: messages.id });
    return rows.length > 0;
  }
  /** U3 §6.4: a cancelled message is pending again. False when it wasn't cancelled. */
  async restoreCancelled(id: string): Promise<boolean> {
    const rows = await this.db
      .update(messages)
      .set({ state: "pending" })
      .where(and(eq(messages.id, id), eq(messages.state, "cancelled")))
      .returning({ id: messages.id });
    return rows.length > 0;
  }
  /**
   * The recipient was archived between the send check and the hand-off: the row tells the truth (spec §7.3). Resolves
   * to the row's human sender when it changed, for their `chat_changed`.
   */
  async markRejected(id: string, tx: Exec = this.db): Promise<string | null> {
    const [row] = await tx
      .update(messages)
      .set({ state: "rejected" })
      .where(and(eq(messages.id, id), eq(messages.state, "pending")))
      .returning({ from: messages.fromUserId });
    return row?.from ?? null;
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
        scheduleNumber: schedules.number,
      })
      .from(messages)
      .leftJoin(fa, eq(fa.id, messages.fromAgentId))
      .leftJoin(fu, eq(fu.id, messages.fromUserId))
      .leftJoin(ta, eq(ta.id, messages.toAgentId))
      .leftJoin(tu, eq(tu.id, messages.toUserId))
      .leftJoin(schedules, eq(schedules.id, messages.scheduleId))
      .where(eq(messages.id, id));
    if (!r) return undefined;
    const { m } = r;
    const out: MessageLookup = {
      id: m.id,
      kind: m.kind as MessageLookup["kind"],
      from:
        m.kind === "scheduled"
          ? "@scheduler"
          : r.fromSlug
            ? `@${r.fromSlug}`
            : r.fromHandle
              ? `@${r.fromHandle}`
              : "@factory",
      fromKind:
        m.kind === "scheduled"
          ? "factory"
          : r.fromSlug
            ? "agent"
            : r.fromHandle
              ? "human"
              : "factory",
      to: m.toAllHumans ? "everyone" : r.toSlug ? `@${r.toSlug}` : `@${r.toHandle ?? ""}`,
      state: m.state as MessageLookup["state"],
    };
    if (r.scheduleNumber !== null) {
      out.scheduleKey = formatKey("S", r.scheduleNumber);
      if (m.firings) out.firings = m.firings;
      if (m.late) out.late = true;
      if (m.dueAt) out.dueAt = m.dueAt.toISOString();
    }
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

  /** The inbox item rows (item, message and the joined names) matching `where`, unordered. */
  private inboxRows(where: SQL | undefined) {
    const fa = alias(agents, "fa");
    const sa = alias(agents, "sa");
    const tu = alias(users, "tu");
    const fu = alias(users, "fu");
    return this.db
      .select({
        item: inboxItems,
        m: messages,
        fromSlug: fa.slug,
        fromHandle: fu.handle,
        subjectSlug: sa.slug,
        toHandle: tu.handle,
        credName: credentials.name,
        credExpiresAt: credentials.expiresAt,
        credNotifiedAt: credentials.expiryNotifiedAt,
        taskNumber: tasks.number,
        taskTitle: tasks.title,
        preview: sql<string>`left(${messages.body}, 280)`,
        createdAtIso: sql<string>`to_char(${inboxItems.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
      })
      .from(inboxItems)
      .innerJoin(messages, eq(messages.id, inboxItems.messageId))
      .leftJoin(fa, eq(fa.id, messages.fromAgentId))
      .leftJoin(fu, eq(fu.id, messages.fromUserId))
      .leftJoin(sa, eq(sa.id, messages.subjectAgentId))
      .leftJoin(tu, eq(tu.id, messages.toUserId))
      .leftJoin(credentials, eq(credentials.id, messages.subjectCredentialId))
      .leftJoin(tasks, eq(tasks.id, messages.taskId))
      .where(where);
  }

  /** Maps joined inbox rows to entries (sender, task, link), in order. */
  private async toEntries(
    page: Awaited<ReturnType<EventStore["inboxRows"]>>,
  ): Promise<InboxEntry[]> {
    const senders = await this.senderEvents(page.map((r) => r.m));
    const items: InboxEntry[] = [];
    for (const r of page) {
      // I3 §5.8: a credential notice is built first, so it never reaches the session link with an empty slug.
      if (r.m.subjectCredentialId && r.credName !== null) {
        items.push({
          id: r.item.id,
          messageId: r.m.id,
          kind: "credential",
          read: r.item.readAt !== null,
          from: { kind: "factory", name: "factory" },
          to: r.m.toAllHumans ? "everyone" : `@${r.toHandle ?? ""}`,
          preview: r.preview,
          urgent: r.m.urgent,
          createdAt: r.item.createdAt.toISOString(),
          credential: {
            name: r.credName,
            expiresAt: r.credExpiresAt?.toISOString() ?? null,
            current: r.credNotifiedAt?.getTime() === r.m.createdAt.getTime(),
          },
          link: { kind: "credential", name: r.credName },
        });
        continue;
      }
      // By kind and sender columns: a human-authored mention is that human, not the factory.
      const factory =
        !r.fromHandle && (r.m.kind === "system" || r.m.kind === "task_update" || !r.fromSlug);
      const sender = senders.get(r.m.id);
      const agentSlug =
        sender?.agentSlug ?? (factory ? r.subjectSlug : r.fromSlug) ?? r.subjectSlug ?? "";
      const task =
        r.taskNumber !== null && r.taskTitle !== null
          ? { key: taskKey(r.taskNumber), title: r.taskTitle }
          : undefined;
      const fact =
        r.item.kind === "task_event" && (r.m.notice === "done" || r.m.notice === "cancelled")
          ? r.m.notice
          : undefined;
      items.push({
        id: r.item.id,
        messageId: r.m.id,
        kind: r.item.kind === "message" ? "notice" : r.item.kind,
        read: r.item.readAt !== null,
        from: r.fromHandle
          ? { kind: "human", name: r.fromHandle }
          : factory
            ? { kind: "factory", name: "factory" }
            : { kind: "agent", name: r.fromSlug ?? "" },
        ...(r.subjectSlug ? { about: r.subjectSlug } : {}),
        to: r.m.toAllHumans ? "everyone" : `@${r.toHandle ?? ""}`,
        preview: r.preview,
        urgent: r.m.urgent,
        createdAt: r.item.createdAt.toISOString(),
        ...(task ? { task } : {}),
        ...(fact ? { fact } : {}),
        link:
          task && r.item.kind !== "message"
            ? {
                kind: "task",
                key: task.key,
                ...(r.item.kind === "mention" && r.m.commentId ? { commentId: r.m.commentId } : {}),
              }
            : { kind: "session", agentSlug, ...(sender ? { seq: sender.seq } : {}) },
      });
    }
    return items;
  }

  /** One item of the user's inbox, or null when it does not exist or belongs to someone else. */
  async inboxItem(userId: string, id: string): Promise<InboxEntry | null> {
    const rows = await this.inboxRows(and(eq(inboxItems.userId, userId), eq(inboxItems.id, id)));
    return (await this.toEntries(rows))[0] ?? null;
  }

  /**
   * The user's inbox, newest first. Cursor is `created_at|id` in base64url (spec §11). `unread` keeps only items not
   * yet read (Home's panel).
   */
  async inboxPage(
    userId: string,
    before?: string,
    limit = 50,
    o: { unread?: boolean } = {},
  ): Promise<{ chats?: UnreadChat[]; items: InboxEntry[]; nextCursor: string | null }> {
    let cursor: SQL | undefined;
    if (before) {
      const [at, id] = Buffer.from(before, "base64url").toString().split("|");
      if (!at || !id || !isCursorInstant(at)) throw new InvalidCursorError();
      cursor = sql`(${inboxItems.createdAt}, ${inboxItems.id}) < (${at}::timestamptz, ${id})`;
    }
    const rows = await this.inboxRows(
      and(
        eq(inboxItems.userId, userId),
        // Chat messages are the Chat's (I1 §6.7): they come back as `chats`, never as items. A factory notice
        // (`system`) has no chat: it is an item of kind `notice`.
        ne(messages.kind, "message"),
        cursor,
        o.unread ? isNull(inboxItems.readAt) : undefined,
      ),
    )
      .orderBy(desc(inboxItems.createdAt), desc(inboxItems.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const items = await this.toEntries(page);
    const last = page.at(-1);
    const nextCursor =
      rows.length > limit && last
        ? Buffer.from(`${last.createdAtIso}|${last.item.id}`).toString("base64url")
        : null;
    // `chats` is unpaginated: only the first page carries it.
    return { ...(before ? {} : { chats: await this.unreadChats(userId) }), items, nextCursor };
  }

  /**
   * I1 §6.7: every agent with unread messages to the user, newest first: how many, and the newest one (its body cut
   * to a plain-text preview). Unpaginated: one row per agent.
   */
  async unreadChats(userId: string): Promise<UnreadChat[]> {
    const fa = alias(agents, "fa");
    const unread = and(
      eq(inboxItems.userId, userId),
      isNull(inboxItems.readAt),
      eq(inboxItems.kind, "message"),
    );
    const [counts, latest] = await Promise.all([
      this.unreadByAgent(userId),
      this.db
        .selectDistinctOn([fa.slug], {
          slug: fa.slug,
          messageId: messages.id,
          body: sql<string>`left(${messages.body}, ${PREVIEW_PREFIX})`,
          urgent: messages.urgent,
          createdAt: sql<string>`to_char(${inboxItems.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
        })
        .from(inboxItems)
        .innerJoin(messages, eq(messages.id, inboxItems.messageId))
        .innerJoin(fa, eq(fa.id, messages.fromAgentId))
        .where(unread)
        .orderBy(fa.slug, desc(inboxItems.createdAt), desc(inboxItems.id)),
    ]);
    return latest
      .map((r) => ({
        slug: r.slug,
        unread: counts[r.slug] ?? 0,
        latest: {
          messageId: r.messageId,
          preview: Array.from(plainPreview(r.body)).slice(0, 280).join(""),
          createdAt: r.createdAt,
          urgent: r.urgent,
        },
      }))
      .sort((a, b) => (a.latest.createdAt < b.latest.createdAt ? 1 : -1));
  }

  /** The item becomes read (idempotent: a read item keeps its first `read_at`, nothing is ever un-read here). */
  async markRead(userId: string, itemId: string): Promise<boolean> {
    const rows = await this.db
      .update(inboxItems)
      .set({
        readAt: sql`coalesce(${inboxItems.readAt}, ${this.clock().toISOString()}::timestamptz)`,
      })
      .where(and(eq(inboxItems.id, itemId), eq(inboxItems.userId, userId)))
      .returning({ id: inboxItems.id });
    return rows.length > 0;
  }

  /**
   * Marks every unread item of the user created at or before `upTo` (an instant `inboxPage` minted) read with ONE
   * stamp from the shared clock, so Undo can find exactly them. Items that arrived later stay unread.
   */
  async markAllRead(userId: string, upTo: string): Promise<{ readAt: string; count: number }> {
    if (!isCursorInstant(upTo)) throw new InvalidCursorError();
    const readAt = this.clock();
    const rows = await this.db
      .update(inboxItems)
      .set({ readAt })
      .where(
        and(
          eq(inboxItems.userId, userId),
          isNull(inboxItems.readAt),
          sql`${inboxItems.createdAt} <= ${upTo}::timestamptz`,
        ),
      )
      .returning({ id: inboxItems.id });
    return { readAt: readAt.toISOString(), count: rows.length };
  }

  /**
   * Marks the user's unread `message` items sent by the agent `slug`, created at or before `upTo`, read with one
   * stamp. `null` for an unknown slug. Mentions, task events and items from other senders are untouched.
   */
  async markReadFrom(
    userId: string,
    slug: string,
    upTo: string,
  ): Promise<{ marked: number; readAt: string } | null> {
    if (!isCursorInstant(upTo)) throw new InvalidCursorError();
    const agent = await this.agentBySlug(slug);
    if (!agent) return null;
    const readAt = this.clock();
    const rows = await this.db
      .update(inboxItems)
      .set({ readAt })
      .where(
        and(
          eq(inboxItems.userId, userId),
          isNull(inboxItems.readAt),
          eq(inboxItems.kind, "message"),
          sql`${inboxItems.createdAt} <= ${upTo}::timestamptz`,
          inArray(
            inboxItems.messageId,
            this.db
              .select({ id: messages.id })
              .from(messages)
              .where(eq(messages.fromAgentId, agent.id)),
          ),
        ),
      )
      .returning({ id: inboxItems.id });
    return { marked: rows.length, readAt: readAt.toISOString() };
  }

  /** Clears `read_at` on the user's items whose `read_at` equals exactly the stamp of one mark-all action. */
  async undoReadAll(userId: string, readAt: string): Promise<{ count: number }> {
    if (!isCursorInstant(readAt)) throw new InvalidCursorError();
    const rows = await this.db
      .update(inboxItems)
      .set({ readAt: null })
      .where(and(eq(inboxItems.userId, userId), sql`${inboxItems.readAt} = ${readAt}::timestamptz`))
      .returning({ id: inboxItems.id });
    return { count: rows.length };
  }

  async unreadCount(userId: string): Promise<number> {
    const [r] = await this.db
      .select({ n: count() })
      .from(inboxItems)
      .where(and(eq(inboxItems.userId, userId), isNull(inboxItems.readAt)));
    return r?.n ?? 0;
  }

  /** Unread `message`-kind inbox items per sending agent slug (mentions, task events and factory items excluded). */
  async unreadByAgent(userId: string): Promise<Record<string, number>> {
    const fa = alias(agents, "fa");
    const rows = await this.db
      .select({ slug: fa.slug, n: count() })
      .from(inboxItems)
      .innerJoin(messages, eq(messages.id, inboxItems.messageId))
      .innerJoin(fa, eq(fa.id, messages.fromAgentId))
      .where(
        and(
          eq(inboxItems.userId, userId),
          isNull(inboxItems.readAt),
          eq(inboxItems.kind, "message"),
        ),
      )
      .groupBy(fa.slug);
    return Object.fromEntries(rows.map((r) => [r.slug, r.n]));
  }
}
