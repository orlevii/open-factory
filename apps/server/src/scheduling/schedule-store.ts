/**
 * SQL for `schedules`, and the one lock order every schedule transaction follows (S9 spec §12.1).
 *
 *   1. Read without locks to learn which agents are involved (target, new target, caller).
 *   2. Agent rows FIRST, in ONE global order (persistent before spawned, then id), ONE ROW PER STATEMENT so each row
 *      gets its own mode: the creating agent `FOR NO KEY UPDATE` (it serialises that agent's own creates, so the
 *      20-schedule count can't be raced), every target `FOR SHARE`; a row that is both gets `FOR NO KEY UPDATE`.
 *      (Creator first, then targets, would deadlock when A schedules for B while B schedules for A.) Re-check each is
 *      live. A deadlock is still retried once from step 1 (`withDeadlockRetry`).
 *   3. Schedule rows `FOR NO KEY UPDATE` (edit, delete, restore) or `FOR NO KEY UPDATE SKIP LOCKED` (the firing).
 *      Never `FOR UPDATE`: it would conflict with the `KEY SHARE` that message inserts take through `schedule_id`.
 *      An edit re-reads the schedule under its lock. It takes an agent lock only for a NEW target (FOR SHARE, step 2),
 *      so a target that changed meanwhile needs no retry: the old target's row is never needed.
 *   4. Message rows: the pending scheduled row `FOR NO KEY UPDATE`, then insert or update.
 *
 * Invariant: agents before schedules before messages. No transaction may lock a schedule row and then wait on an
 * agent row. S7's termination (agent rows, then `terminateRows`, which also updates the target's schedules) and
 * unarchive (agent row, then its schedules) follow it. Tasks are never touched here, so S8's "tasks before agents"
 * is unaffected.
 *
 * Every method takes `tx` first, and every call inside a schedule transaction passes it (a call on its own connection
 * would wait forever on our uncommitted rows). A transaction never awaits a runtime call (`runtimes.load`,
 * `statusOf`, `deliver`).
 */
import { randomUUID } from "node:crypto";
import { type ScheduleRow, schema } from "@open-factory/db";
import { and, asc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Exec } from "../agents/event-store.ts";

const { schedules, agents, principals, messages } = schema;

/** Who acts: a principal (spec §4.1). An agent's id is its `agents.id`. */
export type Actor = { kind: "agent" | "human"; id: string };
export type LockWant = { id: string; mode: "update" | "share" };
export type LockedAgent = {
  id: string;
  slug: string;
  displayName: string;
  kind: string;
  status: string;
  archivedAt: Date | null;
  terminatedAt: Date | null;
};

/** A schedule with the names the item needs. */
export type ScheduleRecord = ScheduleRow & {
  target: {
    slug: string;
    displayName: string;
    status: string;
    archivedAt: Date | null;
    terminatedAt: Date | null;
  };
  createdBy: SchedulePrincipal;
  bodyAuthor: SchedulePrincipal;
  pendingFiring: boolean;
};

/** A principal on a schedule: an agent carries its archived and terminated state. */
export type SchedulePrincipal =
  | {
      kind: "agent";
      ref: string;
      handle: string;
      archivedAt: Date | null;
      terminatedAt: Date | null;
    }
  | { kind: "human"; ref: string; handle: string };

/** "Done": a one-shot whose time came (R5). */
export const isDone = (s: Pick<ScheduleRow, "runAt" | "nextRunAt" | "deletedAt">) =>
  s.runAt !== null && s.nextRunAt === null && s.deletedAt === null;

/** The SQL twin of `isDone`, for counts. */
const doneSql = sql`(${schedules.runAt} is not null and ${schedules.nextRunAt} is null)`;

export class ScheduleStore {
  // Stateless: every method takes the executor (`tx` or the pool) it runs on.
  /** `deleted_at IS NULL`, written once (Q17). */
  live() {
    return isNull(schedules.deletedAt);
  }

  /**
   * ONE row per statement, persistent before spawned then id (§12.1 step 2). A row wanted in both modes gets the
   * stronger one. Returns the rows in lock order.
   */
  async lockAgents(tx: Exec, wants: LockWant[]): Promise<LockedAgent[]> {
    const mode = new Map<string, "update" | "share">();
    for (const w of wants) mode.set(w.id, mode.get(w.id) === "update" ? "update" : w.mode);
    const kinds = await tx
      .select({ id: agents.id, kind: agents.kind })
      .from(agents)
      .where(
        sql`${agents.id} in (${sql.join(
          [...mode.keys()].map((i) => sql`${i}`),
          sql`, `,
        )})`,
      );
    const order = kinds
      .map((k) => ({ id: k.id, spawned: k.kind === "ephemeral" }))
      .sort((a, b) => Number(a.spawned) - Number(b.spawned) || a.id.localeCompare(b.id));
    const out: LockedAgent[] = [];
    for (const { id } of order) {
      const lock = mode.get(id) === "update" ? sql`for no key update` : sql`for share`;
      const rows = await tx.execute(sql`
        select id, slug, display_name as "displayName", kind, status, archived_at as "archivedAt",
               terminated_at as "terminatedAt" from agents where id = ${id} ${lock}`);
      if (rows[0]) out.push(rows[0] as unknown as LockedAgent);
    }
    return out;
  }

  /** Schedules created by `agentId` that count toward the 20 limit: not deleted, not done; paused ones count. */
  async countActiveCreatedBy(tx: Exec, agentId: string): Promise<number> {
    const [r] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(schedules)
      .where(and(eq(schedules.createdById, agentId), this.live(), sql`not ${doneSql}`));
    return r?.n ?? 0;
  }

  async insert(
    tx: Exec,
    s: {
      targetAgentId: string;
      cron: string | null;
      runAt: Date | null;
      timezone: string;
      body: string;
      actor: Actor;
      nextRunAt: Date;
      now: Date;
    },
  ): Promise<ScheduleRow> {
    const [row] = await tx
      .insert(schedules)
      .values({
        id: randomUUID(),
        targetAgentId: s.targetAgentId,
        cron: s.cron,
        runAt: s.runAt,
        timezone: s.timezone,
        body: s.body,
        createdById: s.actor.id,
        bodyAuthorId: s.actor.id,
        nextRunAt: s.nextRunAt,
        createdAt: s.now,
        updatedAt: s.now,
      })
      .returning();
    return row as ScheduleRow;
  }

  /** The joined records, ordered by id for determinism; callers order them as they need. */
  async records(tx: Exec, where: ReturnType<typeof and>): Promise<ScheduleRecord[]> {
    const ta = alias(agents, "ta");
    const ca = alias(agents, "ca");
    const ba = alias(agents, "ba");
    const cp = alias(principals, "cp");
    const bp = alias(principals, "bp");
    const rows = await tx
      .select({
        s: schedules,
        ta: {
          slug: ta.slug,
          displayName: ta.displayName,
          status: ta.status,
          archivedAt: ta.archivedAt,
          terminatedAt: ta.terminatedAt,
        },
        cp: { kind: cp.kind, ref: cp.ref, handle: cp.handle },
        ca: { archivedAt: ca.archivedAt, terminatedAt: ca.terminatedAt },
        bp: { kind: bp.kind, ref: bp.ref, handle: bp.handle },
        ba: { archivedAt: ba.archivedAt, terminatedAt: ba.terminatedAt },
        pending: sql<boolean>`exists (select 1 from ${messages} where ${messages.scheduleId} = ${schedules.id} and ${messages.state} in ('pending', 'loop_held'))`,
      })
      .from(schedules)
      .innerJoin(ta, eq(ta.id, schedules.targetAgentId))
      .innerJoin(cp, eq(cp.id, schedules.createdById))
      .leftJoin(ca, eq(ca.id, schedules.createdById))
      .innerJoin(bp, eq(bp.id, schedules.bodyAuthorId))
      .leftJoin(ba, eq(ba.id, schedules.bodyAuthorId))
      .where(where)
      .orderBy(asc(schedules.number));
    const principal = (
      p: { kind: "agent" | "human"; ref: string; handle: string },
      a: { archivedAt: Date | null; terminatedAt: Date | null } | null,
    ): SchedulePrincipal =>
      p.kind === "agent"
        ? {
            kind: "agent",
            ref: p.ref,
            handle: p.handle,
            archivedAt: a?.archivedAt ?? null,
            terminatedAt: a?.terminatedAt ?? null,
          }
        : { kind: "human", ref: p.ref, handle: p.handle };
    return rows.map((r) => ({
      ...r.s,
      target: r.ta,
      createdBy: principal(r.cp, r.ca),
      bodyAuthor: principal(r.bp, r.ba),
      pendingFiring: Boolean(r.pending),
    })) as ScheduleRecord[];
  }

  async recordById(tx: Exec, id: string): Promise<ScheduleRecord | undefined> {
    return (await this.records(tx, eq(schedules.id, id)))[0];
  }
  async recordByNumber(tx: Exec, n: number): Promise<ScheduleRecord | undefined> {
    return (await this.records(tx, eq(schedules.number, n)))[0];
  }

  /** The schedule row `FOR NO KEY UPDATE` (§12.1 step 3), whatever its state. */
  async lockByNumber(tx: Exec, n: number): Promise<ScheduleRow | undefined> {
    return (
      await tx.select().from(schedules).where(eq(schedules.number, n)).for("no key update")
    )[0];
  }

  /** Bumps `updated_at` (the caller passes the service clock's instant). */
  async update(tx: Exec, id: string, set: Partial<ScheduleRow>): Promise<void> {
    await tx.update(schedules).set(set).where(eq(schedules.id, id));
  }

  /** Schedules targeting `agentId` that are neither deleted nor done: what the strip's link counts. */
  async countFor(tx: Exec, agentId: string): Promise<number> {
    const [r] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(schedules)
      .where(and(eq(schedules.targetAgentId, agentId), this.live(), sql`not ${doneSql}`));
    return r?.n ?? 0;
  }

  /** Every schedule targeting `agentId` and not deleted, by row (for unarchive's recompute). */
  async idsTargeting(tx: Exec, agentId: string): Promise<string[]> {
    const rows = await tx
      .select({ id: schedules.id })
      .from(schedules)
      .where(and(eq(schedules.targetAgentId, agentId), this.live()))
      .orderBy(asc(schedules.number));
    return rows.map((r) => r.id);
  }

  // ---------- the firing (spec §8.1) ----------

  /** Due ids with their targets, read without locks, oldest first (§8.1 step 1). `now` is a parameter, never `now()`. */
  async dueIds(
    tx: Exec,
    now: Date,
    limit: number,
  ): Promise<{ id: string; targetAgentId: string }[]> {
    return tx
      .select({ id: schedules.id, targetAgentId: schedules.targetAgentId })
      .from(schedules)
      .where(
        and(
          this.live(),
          isNull(schedules.pausedAt),
          lte(schedules.nextRunAt, now),
          or(isNull(schedules.retryAt), lte(schedules.retryAt, now)),
        ),
      )
      .orderBy(asc(schedules.nextRunAt), asc(schedules.number))
      .limit(limit);
  }

  /** The earliest moment anything can fire: `min(coalesce(retry_at, next_run_at))` over active schedules. */
  async earliest(tx: Exec): Promise<Date | null> {
    const [r] = await tx
      .select({
        at: sql<string | null>`min(coalesce(${schedules.retryAt}, ${schedules.nextRunAt}))`,
      })
      .from(schedules)
      .where(and(this.live(), isNull(schedules.pausedAt), sql`${schedules.nextRunAt} is not null`));
    return r?.at ? new Date(r.at) : null;
  }

  /** The firing's schedule lock: `FOR NO KEY UPDATE SKIP LOCKED` (never `FOR UPDATE`). None: gone or being edited. */
  async lockForFiring(tx: Exec, id: string): Promise<ScheduleRow | undefined> {
    return (
      await tx
        .select()
        .from(schedules)
        .where(eq(schedules.id, id))
        .for("no key update", { skipLocked: true })
    )[0];
  }

  /**
   * Replace, never stack (spec §8.2). The pending row of this schedule and target is locked `FOR NO KEY UPDATE`, found
   * through its partial unique index: none, insert; not yet written (`delivered_event_seq IS NULL`), update in place
   * (body, author, due, firings + missed, late; `created_at` and so its queue position stay); written to a process that
   * hasn't confirmed it, write nothing (the agent is about to read that row; this firing coalesces into it).
   * Returns the row id to hand over, or undefined when nothing was written.
   */
  async upsertFiring(
    tx: Exec,
    f: { schedule: ScheduleRow; due: Date; missed: number; late: boolean; now: Date },
    /** Runs only on the insert path (no open row), before the insert; `{ holdId }` inserts the row `loop_held`. */
    beforeInsert?: () => Promise<{ holdId: string } | undefined>,
  ): Promise<string | undefined> {
    const s = f.schedule;
    const [pending] = await tx
      .select({
        id: messages.id,
        seq: messages.deliveredEventSeq,
        firings: messages.firings,
        state: messages.state,
      })
      .from(messages)
      .where(
        and(
          eq(messages.scheduleId, s.id),
          eq(messages.toId, s.targetAgentId),
          inArray(messages.state, ["pending", "loop_held"]),
        ),
      )
      .for("no key update");
    if (pending) {
      if (pending.seq !== null) return undefined;
      await tx
        .update(messages)
        .set({
          body: s.body,
          authorId: s.bodyAuthorId,
          dueAt: f.due,
          firings: (pending.firings ?? 0) + f.missed,
          late: f.late,
        })
        .where(eq(messages.id, pending.id));
      // A held row stays held (I8 §6.3): coalesced into, never handed over.
      return pending.state === "loop_held" ? undefined : pending.id;
    }
    const held = await beforeInsert?.();
    const id = randomUUID();
    await tx.insert(messages).values({
      id,
      kind: "scheduled",
      toId: s.targetAgentId,
      scheduleId: s.id,
      authorId: s.bodyAuthorId,
      dueAt: f.due,
      firings: f.missed,
      late: f.late,
      body: s.body,
      ...(held ? { state: "loop_held" as const, loopHoldId: held.holdId } : {}),
      createdAt: f.now,
    });
    return held ? undefined : id;
  }

  /** In its own statement after a failed firing transaction (§8.1 step 4): backoff computed in TypeScript. */
  async recordFailure(tx: Exec, id: string, failCount: number, retryAt: Date): Promise<void> {
    await tx
      .update(schedules)
      .set({ failCount: failCount + 1, retryAt })
      .where(eq(schedules.id, id));
  }
}
