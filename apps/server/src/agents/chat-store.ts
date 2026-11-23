import { type Db, schema } from "@open-factory/db";
import type { ChatEntry } from "@open-factory/shared";
import { and, desc, eq, type SQL, sql } from "drizzle-orm";
import { InvalidCursorError } from "./errors.ts";
import { isCursorInstant } from "./event-store.ts";

const { messages } = schema;

/** Entries each side of an `around` message (I1 §6.3). */
export const CHAT_AROUND = 25;

const ISO = (col: SQL | string) =>
  sql<string>`to_char(${typeof col === "string" ? sql.raw(col) : col} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const encode = (iso: string, id: string) => Buffer.from(`${iso}|${id}`).toString("base64url");
function decode(cursor: string): { at: string; id: string } {
  const [at, id] = Buffer.from(cursor, "base64url").toString().split("|");
  if (!at || !id || !isCursorInstant(at)) throw new InvalidCursorError();
  return { at, id };
}

export interface ChatThread {
  agent: {
    id: string;
    slug: string;
    archivedAt: Date | null;
    terminatedAt: Date | null;
  };
  user: { id: string; handle: string };
}
export interface ChatQuery {
  before?: string;
  around?: string;
  limit: number;
}
export interface ChatSlice {
  entries: ChatEntry[];
  nextCursor: string | null;
  newerCursor: string | null;
}

/** I1 §6.3: one human's thread with one agent, read from `messages` and `turns`. */
export class ChatStore {
  constructor(private readonly db: Db) {}

  /** Both directions, cancelled rows left out (the client's cancel overlay covers them). */
  private threadWhere(t: ChatThread): SQL {
    return sql`${messages.kind} = 'message' and ${messages.state} <> 'cancelled' and (
      (${messages.toAgentId} = ${t.agent.id} and ${messages.fromUserId} = ${t.user.id})
      or (${messages.fromAgentId} = ${t.agent.id} and ${messages.toUserId} = ${t.user.id}))`;
  }

  private rows(where: SQL, order: "asc" | "desc", limit: number) {
    return this.db
      .select({ m: messages, iso: ISO(sql`${messages.createdAt}`) })
      .from(messages)
      .where(where)
      .orderBy(
        order === "desc" ? desc(messages.createdAt) : sql`${messages.createdAt} asc`,
        order === "desc" ? desc(messages.id) : sql`${messages.id} asc`,
      )
      .limit(limit);
  }

  async page(t: ChatThread, q: ChatQuery): Promise<ChatSlice | null> {
    const base = this.threadWhere(t);
    const before = (at: string, id: string) =>
      sql`(${messages.createdAt}, ${messages.id}) < (${at}::timestamptz, ${id})`;
    const after = (at: string, id: string) =>
      sql`(${messages.createdAt}, ${messages.id}) > (${at}::timestamptz, ${id})`;
    type Row = Awaited<ReturnType<ChatStore["rows"]>>[number];
    let picked: Row[];
    let hasOlder: boolean;
    let newer: Row[] = [];
    /** The time window the page's turn outcomes cover: [start, end), open where the page reaches the thread's ends. */
    let end: string | null = null;
    if (q.around !== undefined) {
      const [target] = await this.rows(and(eq(messages.id, q.around), base) as SQL, "asc", 1);
      if (!target) return null;
      const older = await this.rows(
        and(base, before(target.iso, target.m.id)) as SQL,
        "desc",
        CHAT_AROUND + 1,
      );
      newer = await this.rows(
        and(base, after(target.iso, target.m.id)) as SQL,
        "asc",
        CHAT_AROUND + 1,
      );
      hasOlder = older.length > CHAT_AROUND;
      picked = [...older.slice(0, CHAT_AROUND).reverse(), target, ...newer.slice(0, CHAT_AROUND)];
      end = newer[CHAT_AROUND]?.iso ?? null;
    } else {
      let cursor: SQL | undefined;
      if (q.before !== undefined) {
        const c = decode(q.before);
        cursor = before(c.at, c.id);
        end = c.at;
      }
      const rows = await this.rows(and(base, cursor) as SQL, "desc", q.limit + 1);
      hasOlder = rows.length > q.limit;
      picked = rows.slice(0, q.limit).reverse();
    }
    const oldest = picked[0];
    const newest = picked.at(-1);
    const state = (m: typeof messages.$inferSelect) =>
      m.state as "pending" | "delivered" | "rejected";
    const rejectReason = t.agent.terminatedAt
      ? "the agent was terminated"
      : t.agent.archivedAt
        ? "the agent is archived"
        : "the agent isn't available";
    const entries: Array<{ at: string; entry: ChatEntry }> = picked.map(({ m, iso }) => ({
      at: iso,
      entry: {
        kind: "message",
        id: m.id,
        from: `@${m.fromUserId ? t.user.handle : t.agent.slug}`,
        fromKind: m.fromUserId ? "human" : "agent",
        body: m.body,
        recipients: m.recipients ?? [],
        urgent: m.urgent,
        createdAt: iso,
        state: state(m),
        ...(m.state === "rejected" ? { rejectReason } : {}),
        ...(m.attachments ? { attachments: m.attachments } : {}),
        ...(m.clientMessageId ? { clientMessageId: m.clientMessageId } : {}),
      },
    }));
    for (const o of await this.outcomes(t, hasOlder && oldest ? oldest.iso : null, end))
      entries.push({ at: o.endedAt, entry: o });
    // Equal instants keep a message ahead of the outcome that follows it.
    entries.sort((a, b) =>
      a.at === b.at
        ? Number(a.entry.kind === "turn_outcome") - Number(b.entry.kind === "turn_outcome")
        : a.at < b.at
          ? -1
          : 1,
    );
    return {
      entries: entries.map((e) => e.entry),
      nextCursor: hasOlder && oldest ? encode(oldest.iso, oldest.m.id) : null,
      newerCursor: newer.length > CHAT_AROUND && newest ? encode(newest.iso, newest.m.id) : null,
    };
  }

  /**
   * Closed turns of the agent that consumed one of the user's messages and sent them nothing between their start and
   * end (any origin: the stamp is the proof), ended in [start, end). `key` is the user's first message in the batch.
   */
  private async outcomes(
    t: ChatThread,
    start: string | null,
    end: string | null,
  ): Promise<Array<Extract<ChatEntry, { kind: "turn_outcome" }>>> {
    const window = [
      start ? sql`and t.ended_at >= ${start}::timestamptz` : sql``,
      end
        ? sql`and t.started_at < ${end}::timestamptz and t.ended_at < ${end}::timestamptz`
        : sql``,
    ];
    const rows = await this.db.execute<{
      turn_id: string;
      key: string;
      ended: string;
      seq: number | null;
      is_error: boolean | null;
      reason: string | null;
    }>(sql`
      select t.id as turn_id,
             (array_agg(m.id order by m.created_at, m.id))[1] as key,
             ${ISO("t.ended_at")} as ended,
             t.end_event_seq as seq, t.is_error, t.terminal_reason as reason
      from turns t
      join messages m on m.delivered_turn_id = t.id and m.kind = 'message'
        and m.from_user_id = ${t.user.id} and m.to_agent_id = ${t.agent.id}
      where t.agent_id = ${t.agent.id} and t.ended_at is not null ${window[0]} ${window[1]}
        and not exists (
          select 1 from messages r
          where r.kind = 'message' and r.from_agent_id = ${t.agent.id} and r.to_user_id = ${t.user.id}
            and r.created_at between t.started_at and t.ended_at)
      group by t.id
      order by t.ended_at, t.id`);
    return rows.map((r) => ({
      kind: "turn_outcome" as const,
      key: r.key,
      turnId: r.turn_id,
      endedAt: r.ended,
      eventSeq: r.seq,
      outcome:
        r.reason === "aborted_tools" ||
        r.reason === "aborted_streaming" ||
        r.reason === "process_stopped"
          ? ("stopped" as const)
          : r.is_error || r.reason === "process_exited" || r.reason === "factory_restarted"
            ? ("error" as const)
            : ("no_reply" as const),
    }));
  }
}
