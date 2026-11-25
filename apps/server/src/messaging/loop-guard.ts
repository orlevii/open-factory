import { schema } from "@open-factory/db";
import { sql } from "drizzle-orm";
import type { RuntimeLog } from "../agents/agent-runtime.ts";
import type { EventBus } from "../agents/event-bus.ts";
import type { EventStore, PendingRow, Tx } from "../agents/event-store.ts";
import type { AgentRuntimes } from "../agents/runtimes.ts";
import type { FactorySettings } from "../settings/factory-settings.ts";

/** An unordered agent pair, smaller id first (the `loop_holds` CHECK). */
export type PairKey = { a: string; b: string };
export const pairOf = (x: string, y: string): PairKey => (x < y ? { a: x, b: y } : { a: y, b: x });

export type GuardResult =
  | { held: false }
  | { held: true; holdId: string; opened: false }
  | {
      held: true;
      holdId: string;
      opened: true;
      /** From the sender's view: `ab` is from → to, including the row being inserted. */
      counts: { ab: number; ba: number; minutes: number };
      /** The managers' notice rows written in the hold's transaction (Task 3.5 fills them). */
      managerRows: PendingRow[];
    };

type Deps = {
  settings: FactorySettings;
  store: EventStore;
  bus: Pick<EventBus, "publishAll">;
  runtimes: Pick<AgentRuntimes, "adoptNotice">;
  log: RuntimeLog;
  clock: () => Date;
  newId: () => string;
};

/** Spec §6.3: the minutes since the first counted row in the window, rounded up, at least 1. */
export const minutesSince = (first: Date, now: Date): number =>
  Math.max(1, Math.ceil((now.getTime() - first.getTime()) / 60_000));

/**
 * I8 §6: derives an agent pair's counts at send time and opens a hold when both directions exceed the limit. Nothing is
 * counted in memory. `check` must run in the transaction that inserts the counted row, after `lockPairs`.
 */
export class LoopGuard {
  constructor(private readonly d: Deps) {}

  /**
   * Takes every pair's advisory lock once, in ascending key order, so two transactions with overlapping pair sets
   * can't deadlock on each other. The caller passes every pair its transaction will insert into. `offset 0` keeps
   * the planner from folding the sorted subquery into the outer select, so the volatile lock call runs in key order.
   */
  async lockPairs(tx: Tx, pairs: PairKey[]): Promise<void> {
    if (!pairs.length) return;
    const rows = sql.join(
      pairs.map((p) => sql`(${p.a}::text, ${p.b}::text)`),
      sql`, `,
    );
    await tx.execute(sql`
      select pg_advisory_xact_lock(k) from (
        select distinct hashtextextended('loop:' || a || ':' || b, 0) as k
        from (values ${rows}) as p(a, b)
        order by k offset 0
      ) s`);
  }

  async check(tx: Tx, from: string, to: string): Promise<GuardResult> {
    const { a, b } = pairOf(from, to);
    const open = await tx.execute<{ id: string }>(
      sql`select id from loop_holds where agent_a = ${a} and agent_b = ${b} and resumed_at is null`,
    );
    if (open[0]) return { held: true, holdId: open[0].id, opened: false };

    const now = this.d.clock();
    const limit = this.d.settings.loopGuardMessages();
    const windowSecs = this.d.settings.loopGuardWindowMs() / 1000;
    const [w] = await tx.execute<{ since: Date | string }>(sql`
      select greatest(
        ${now.toISOString()}::timestamptz - make_interval(secs => ${windowSecs}),
        (select max(resumed_at) from loop_holds where agent_a = ${a} and agent_b = ${b}),
        (select max(created_at) from messages
           where kind = 'message' and from_user_id is not null and to_agent_id in (${a}, ${b})),
        (select max(at) from session_events
           where type = 'operator_input' and agent_id in (${a}, ${b}) and payload->>'byKind' = 'human'),
        (select max(e.at) from task_events e join tasks t on t.id = e.task_id
           where e.type = 'status' and e.actor_user_id is not null and t.assignee_agent_id in (${a}, ${b}))
      ) as since`);
    const since = new Date(w?.since as Date | string).toISOString();

    // One arm per direction and sender column, each served by an existing index: agent-sent rows by
    // `messages_from_agent_idx`; scheduled rows carry their author instead of a sender (`from_agent_id` is null).
    const arm = (x: string, y: string) => sql`
      select from_agent_id as s, created_at from messages
        where from_agent_id = ${x} and to_agent_id = ${y} and created_at > ${since}::timestamptz
          and kind in ('message','task_comment','scheduled') and state <> 'cancelled'
      union all
      select author_agent_id as s, created_at from messages
        where kind = 'scheduled' and from_agent_id is null and author_agent_id = ${x} and to_agent_id = ${y}
          and created_at > ${since}::timestamptz and state <> 'cancelled'`;
    const counted = await tx.execute<{ s: string; n: number; first: Date | string }>(sql`
      select s, count(*)::int as n, min(created_at) as first
      from (${arm(a, b)} union all ${arm(b, a)}) m
      group by s`);
    const of = (id: string) => counted.find((r) => r.s === id);
    const ab = (of(from)?.n ?? 0) + 1;
    const ba = of(to)?.n ?? 0;
    if (ab <= limit || ba <= limit) return { held: false };

    const holdId = this.d.newId();
    await tx
      .insert(schema.loopHolds)
      .values({ id: holdId, agentA: a, agentB: b, openedAt: this.d.store.clock() });
    const firsts = counted.map((r) => new Date(r.first).getTime());
    const first = new Date(Math.min(...firsts));
    return {
      held: true,
      holdId,
      opened: true,
      counts: { ab, ba, minutes: minutesSince(first, now) },
      managerRows: [],
    };
  }

  /**
   * After the caller's commit, for every result of its transaction (the list is per attempt under a deadlock retry):
   * when any opened a hold, tells every client to refresh its inbox and hands the managers' notices to their runtimes.
   * Never throws.
   */
  afterCommit(results: GuardResult[]): void {
    const opened = results.filter((r) => r.held && r.opened);
    if (!opened.length) return;
    try {
      this.d.bus.publishAll({ type: "inbox_changed" });
    } catch (err) {
      this.d.log.error({ err }, "loop guard: publishing inbox_changed failed");
    }
    for (const r of opened) {
      if (!r.held || !r.opened) continue;
      for (const row of r.managerRows) {
        if (!row.toAgentId) continue;
        this.d.runtimes.adoptNotice(row.toAgentId, row.id).catch((err: unknown) => {
          this.d.log.error({ err, id: row.id }, "loop guard: handing over a manager notice failed");
        });
      }
    }
  }
}
