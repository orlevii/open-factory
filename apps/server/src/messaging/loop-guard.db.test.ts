import { schema } from "@open-factory/db";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { EventStore } from "../agents/event-store.ts";
import { insertAgent, insertSchedule } from "../agents/testing/rows.ts";
import type { FactorySettings } from "../settings/factory-settings.ts";
import { createTestDb } from "../test/helpers.ts";
import { principalSql } from "../test/principals.ts";
import { type GuardResult, LoopGuard, pairOf } from "./loop-guard.ts";

const N = 3;
const WINDOW_MIN = 10;
const NOW = new Date("2026-06-01T12:00:00Z");
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000);

let t: Awaited<ReturnType<typeof createTestDb>>;
let seq = 0;
const published: unknown[] = [];
const adopted: string[] = [];
let guard: LoopGuard;
let deps: ConstructorParameters<typeof LoopGuard>[0];

beforeAll(async () => {
  t = await createTestDb();
  await t.sql.unsafe(principalSql("u1", "human", "or"));
  await t.sql`insert into users (id, name, email) values ('u1', 'Or', 'or@x.io')`;
  for (const id of ["a1", "a2", "a3"]) await insertAgent(t.sql, { id, slug: id });
  const store = new EventStore(t.db);
  deps = {
    settings: {
      loopGuardMessages: () => N,
      loopGuardWindowMs: () => WINDOW_MIN * 60_000,
    } as FactorySettings,
    store,
    bus: { publishAll: (m: unknown) => void published.push(m) },
    runtimes: { adoptNotice: async (_a: string, id: string) => void adopted.push(id) },
    log: { error: () => {}, warn: () => {}, info: () => {} } as never,
    clock: () => NOW,
    newId: () => `hold-${++seq}`,
  };
  guard = new LoopGuard(deps);
});
afterAll(() => t.close());
beforeEach(async () => {
  await t.sql`delete from messages`;
  await t.sql`delete from schedules`;
  await t.sql`delete from task_comments`;
  await t.sql`delete from loop_holds`;
  await t.sql`delete from session_events`;
  await t.sql`delete from task_events`;
  await t.sql`delete from tasks`;
  published.length = 0;
  adopted.length = 0;
});

type Row = {
  from?: string;
  to: string;
  at: Date;
  kind?: "message" | "task_comment" | "scheduled";
  state?: string;
  authorAgent?: string;
  authorUser?: string;
  fromUser?: string;
};
async function row(r: Row) {
  const kind = r.kind ?? "message";
  const id = `m${++seq}`;
  let taskId: string | null = null;
  let commentId: string | null = null;
  let scheduleId: string | null = null;
  if (kind === "task_comment") {
    taskId = "tc";
    commentId = `c${seq}`;
    await t.sql`insert into tasks (id, title, created_by_id) values ('tc', 'T', 'u1') on conflict do nothing`;
    await t.sql`insert into task_comments (id, task_id, author_id, body) values (${commentId}, 'tc', ${r.from ?? "a1"}, 'x')`;
  }
  if (kind === "scheduled") {
    scheduleId = `s${seq}`;
    await insertSchedule(t.sql, { id: scheduleId, targetAgentId: r.to });
  }
  await t.sql`insert into messages (id, kind, from_id, to_id, author_id,
                                   recipient_ids, body, state, created_at, task_id, comment_id, schedule_id, due_at, firings, late)
              values (${id}, ${kind}, ${r.fromUser ?? r.from ?? null}, ${r.to},
                      ${r.authorAgent ?? r.authorUser ?? null},
                      ${kind === "message" ? `{"${r.to}"}` : null}::text[], 'x', ${r.state ?? "delivered"}, ${r.at.toISOString()},
                      ${taskId}, ${commentId}, ${scheduleId},
                      ${scheduleId ? r.at.toISOString() : null}, ${scheduleId ? 1 : null}, ${scheduleId ? false : null})`;
}
/** `n` rows from -> to, spread over the last few minutes. */
async function rows(from: string, to: string, n: number, over: Partial<Row> = {}) {
  for (let i = 0; i < n; i++) await row({ from, to, at: ago(5 - i * 0.01), ...over });
}
const check = (from: string, to: string) =>
  t.db.transaction(async (tx) => {
    await guard.lockPairs(tx, [pairOf(from, to)]);
    return guard.check(tx, from, to);
  });

describe("trip", () => {
  test("the new row that makes both directions exceed N opens the hold with the counts", async () => {
    await rows("a1", "a2", N);
    await rows("a2", "a1", N + 1);
    const r = await check("a1", "a2");
    expect(r).toMatchObject({ held: true, opened: true, counts: { ab: N + 1, ba: N + 1 } });
    const [h] = await t.sql`select agent_a, agent_b, resumed_at from loop_holds`;
    expect(h).toMatchObject({ agent_a: "a1", agent_b: "a2", resumed_at: null });
  });

  test("N each way (including the new row) is not held", async () => {
    await rows("a1", "a2", N - 1);
    await rows("a2", "a1", N);
    expect(await check("a1", "a2")).toEqual({ held: false });
  });

  test("counts are oriented from the sender's view", async () => {
    await rows("a2", "a1", N);
    await rows("a1", "a2", N + 2);
    const r = await check("a2", "a1");
    expect(r).toMatchObject({ opened: true, counts: { ab: N + 1, ba: N + 2 } });
  });

  test("a one-way flood never holds", async () => {
    await rows("a1", "a2", 50);
    expect(await check("a1", "a2")).toEqual({ held: false });
  });

  test("minutes run from the first counted row to now, rounded up", async () => {
    await row({ from: "a1", to: "a2", at: ago(7.5) });
    await rows("a1", "a2", N - 1);
    await rows("a2", "a1", N + 1);
    const r = await check("a1", "a2");
    expect(r).toMatchObject({ opened: true, counts: { minutes: 8 } });
  });

  test("rows older than the window do not count", async () => {
    for (let i = 0; i < N + 2; i++) {
      await row({ from: "a1", to: "a2", at: ago(WINDOW_MIN + 5) });
      await row({ from: "a2", to: "a1", at: ago(WINDOW_MIN + 5) });
    }
    expect(await check("a1", "a2")).toEqual({ held: false });
  });

  test("cancelled rows do not count, held and rejected ones do", async () => {
    await rows("a1", "a2", N, { state: "cancelled" });
    await rows("a2", "a1", N + 1);
    expect(await check("a1", "a2")).toEqual({ held: false });
    await rows("a1", "a2", 1, { state: "rejected" });
    await rows("a1", "a2", N - 1, { state: "loop_held" });
    expect(await check("a1", "a2")).toMatchObject({ held: true, opened: true });
  });

  test("a pair's counts do not include other pairs", async () => {
    await rows("a1", "a3", N + 2);
    await rows("a3", "a1", N + 2);
    await rows("a1", "a2", N);
    await rows("a2", "a1", N + 1);
    expect(await check("a1", "a2")).toMatchObject({ opened: true, counts: { ab: N + 1 } });
  });
});

describe("counted kinds", () => {
  test("task comments and agent-authored schedule firings count", async () => {
    await rows("a1", "a2", 1, { kind: "task_comment" });
    await row({ to: "a2", kind: "scheduled", authorAgent: "a1", at: ago(4) });
    await row({ to: "a2", kind: "scheduled", authorAgent: "a1", at: ago(3) });
    await rows("a2", "a1", N + 1);
    expect(await check("a1", "a2")).toMatchObject({ opened: true, counts: { ab: N + 1 } });
  });

  test("human-authored schedule firings do not count", async () => {
    for (let i = 0; i < N + 2; i++)
      await row({ to: "a2", kind: "scheduled", authorUser: "u1", at: ago(4) });
    await rows("a2", "a1", N + 1);
    expect(await check("a1", "a2")).toEqual({ held: false });
  });
});

describe("resets", () => {
  /** Both directions are at the threshold before and after the reset source; only the rows after it can count. */
  async function flood() {
    await rows("a1", "a2", N);
    await rows("a2", "a1", N + 1);
  }
  const verdict = async (apply: () => Promise<void>) => {
    await flood();
    await apply();
    return check("a1", "a2");
  };
  const notHeld = { held: false };
  const tripped = { held: true, opened: true };

  test.each(["a1", "a2"])("a human message to %s resets", async (to) => {
    expect(await verdict(() => row({ fromUser: "u1", to, at: ago(1) }))).toEqual(notHeld);
  });

  test.each(["a1", "a2"])("a human's raw session input on %s resets", async (agent) => {
    expect(
      await verdict(async () => {
        await t.sql`insert into session_events (agent_id, seq, type, payload, at)
                    values (${agent}, 1, 'operator_input', '{"byKind":"human"}', ${ago(1).toISOString()})`;
      }),
    ).toEqual(notHeld);
  });

  test.each(["a1", "a2"])(
    "a human status change on a task assigned to %s resets",
    async (assignee) => {
      expect(
        await verdict(async () => {
          await t.sql`insert into tasks (id, title, assignee_agent_id, created_by_id)
                    values ('t1', 'T', ${assignee}, 'u1')`;
          await t.sql`insert into task_events (id, task_id, actor_id, type, at)
                    values ('e1', 't1', 'u1', 'status', ${ago(1).toISOString()})`;
        }),
      ).toEqual(notHeld);
    },
  );

  const nonResets: [string, () => Promise<void>][] = [
    ["a human message to a third agent", () => row({ fromUser: "u1", to: "a3", at: ago(1) })],
    [
      "a human's raw session input on a third agent",
      async () => {
        await t.sql`insert into session_events (agent_id, seq, type, payload, at)
                    values ('a3', 1, 'operator_input', '{"byKind":"human"}', ${ago(1).toISOString()})`;
      },
    ],
    [
      "a human status change on a task assigned to a third agent",
      async () => {
        await t.sql`insert into tasks (id, title, assignee_agent_id, created_by_id)
                    values ('t1', 'T', 'a3', 'u1')`;
        await t.sql`insert into task_events (id, task_id, actor_id, type, at)
                    values ('e1', 't1', 'u1', 'status', ${ago(1).toISOString()})`;
      },
    ],
    [
      "an agent's raw session input",
      async () => {
        await t.sql`insert into session_events (agent_id, seq, type, payload, at)
                    values ('a1', 1, 'operator_input', '{"byKind":"agent"}', ${ago(1).toISOString()})`;
      },
    ],
    [
      "an agent's status change",
      async () => {
        await t.sql`insert into tasks (id, title, assignee_agent_id, created_by_id)
                    values ('t1', 'T', 'a2', 'u1')`;
        await t.sql`insert into task_events (id, task_id, actor_id, type, at)
                    values ('e1', 't1', 'a1', 'status', ${ago(1).toISOString()})`;
      },
    ],
    [
      "an agent's task comment",
      () => row({ from: "a1", to: "a2", kind: "task_comment", at: ago(1) }),
    ],
    [
      "a human's schedule",
      () => row({ to: "a2", kind: "scheduled", authorUser: "u1", at: ago(1) }),
    ],
  ];
  test.each(nonResets)("%s does not reset", async (_name, apply) => {
    expect(await verdict(apply)).toMatchObject(tripped);
  });

  test("a reset between the rows leaves only the later ones to count", async () => {
    await rows("a1", "a2", N);
    await rows("a2", "a1", N + 1);
    await row({ fromUser: "u1", to: "a1", at: ago(2) });
    await rows("a1", "a2", 1, { at: ago(1) });
    expect(await check("a1", "a2")).toEqual({ held: false });
  });
});

describe("open and resumed holds", () => {
  const openHold = (resumedAt: Date | null = null, id = "h0") =>
    t.db
      .insert(schema.loopHolds)
      .values({ id, agentA: "a1", agentB: "a2", openedAt: ago(8), resumedAt });

  test("an open hold holds either direction without opening another", async () => {
    await openHold();
    expect(await check("a1", "a2")).toEqual({ held: true, holdId: "h0", opened: false });
    expect(await check("a2", "a1")).toEqual({ held: true, holdId: "h0", opened: false });
    const [c] = await t.sql`select count(*)::int as n from loop_holds`;
    expect(c?.n).toBe(1);
  });

  test("a reset after the hold opened does not release it", async () => {
    await openHold();
    await row({ fromUser: "u1", to: "a1", at: ago(1) });
    expect(await check("a1", "a2")).toMatchObject({ held: true, holdId: "h0", opened: false });
  });

  test("a resumed hold's resumed_at is a window start", async () => {
    await openHold(ago(2));
    await rows("a1", "a2", N + 2, { at: ago(3) });
    await rows("a2", "a1", N + 2, { at: ago(3) });
    expect(await check("a1", "a2")).toEqual({ held: false });
    // Rows after the resume count again, and a new hold can open.
    await rows("a1", "a2", N, { at: ago(1) });
    await rows("a2", "a1", N + 1, { at: ago(1) });
    expect(await check("a1", "a2")).toMatchObject({ held: true, opened: true });
  });
});

describe("notices on open", () => {
  const trip = async (from: string, to: string) => {
    await rows(from, to, N);
    await rows(to, from, N + 1);
    const r = await check(from, to);
    if (!r.held || !r.opened) throw new Error("expected an opened hold");
    return r;
  };
  const notices = (toAgent: string) =>
    t.sql`select * from messages where to_id = ${toAgent} and notice = 'loop_held'`;
  const nextAgent = (() => {
    let n = 0;
    return async (
      over: Parameters<typeof insertAgent>[1] extends infer A ? Partial<A> : never = {},
    ) => {
      const id = `n${++n}`;
      await insertAgent(t.sql, { id, slug: id, ...over } as never);
      return id;
    };
  })();

  test("one human notice with the hold, and one inbox item per user", async () => {
    await t.sql.unsafe(principalSql("u2", "human", "ana"));
    await t.sql`insert into users (id, name, email) values ('u2', 'Ana', 'ana@x.io')`;
    try {
      const r = await trip("a1", "a2");
      const msgs = await t.sql`select * from messages where notice = 'loop_held' and to_all_humans`;
      expect(msgs).toHaveLength(1);
      expect(msgs[0]).toMatchObject({
        kind: "system",
        from_id: null,
        subject_agent_id: "a1",
        loop_hold_id: r.holdId,
        body: `@a1 and @a2 exchanged ${2 * N + 2} messages in 5 minutes; further messages between them are held.`,
      });
      const items = await t.sql`select user_id from inbox_items where message_id = ${msgs[0]?.id}`;
      expect(items.map((i) => i.user_id).sort()).toEqual(["u1", "u2"]);
    } finally {
      await t.sql`delete from inbox_items`;
      await t.sql`delete from messages`;
      await t.sql`delete from users where id = 'u2'`;
    }
  });

  test("a manager gets a notice for the pair, with no hold link; a shared manager gets one", async () => {
    const m = await nextAgent();
    const x = await nextAgent({ reportsTo: m });
    const y = await nextAgent({ reportsTo: m });
    const r = await trip(x, y);
    const [n] = await notices(m);
    expect(await notices(m)).toHaveLength(1);
    expect(n).toMatchObject({
      kind: "system",
      state: "pending",
      subject_agent_id: x,
      loop_hold_id: null,
    });
    expect(n?.body).toBe(
      `@${x} and @${y} exchanged ${2 * N + 2} messages in 5 minutes with no human in between. Messages between them are held until a human resumes them in the Inbox.`,
    );
    expect(r.managerRows.map((row) => [row.id, row.toId])).toEqual([[n?.id, m]]);
  });

  test("a manager who is the other agent of the pair gets nothing", async () => {
    const b = await nextAgent();
    const a = await nextAgent({ reportsTo: b });
    const r = await trip(a, b);
    expect(await notices(b)).toHaveLength(0);
    expect(r.managerRows).toEqual([]);
  });

  test("an archived or terminated manager gets nothing", async () => {
    const m1 = await nextAgent({ archived: true });
    const m2 = await nextAgent({ reportsTo: m1, terminatedAt: ago(1) });
    const a = await nextAgent({ reportsTo: m1 });
    const b = await nextAgent({ reportsTo: m2 });
    const r = await trip(a, b);
    expect(await notices(m1)).toHaveLength(0);
    expect(await notices(m2)).toHaveLength(0);
    expect(r.managerRows).toEqual([]);
  });

  test("two holds involving the same agent give its manager two notices", async () => {
    const m = await nextAgent();
    const a = await nextAgent({ reportsTo: m });
    const b = await nextAgent();
    const c = await nextAgent();
    await trip(a, b);
    await trip(a, c);
    expect(await notices(m)).toHaveLength(2);
  });

  test("afterCommit with the real rows hands each manager's notice over", async () => {
    const m = await nextAgent();
    const a = await nextAgent({ reportsTo: m });
    const b = await nextAgent();
    const r = await trip(a, b);
    guard.afterCommit([r]);
    await vi.waitFor(() => expect(adopted).toEqual(r.managerRows.map((row) => row.id)));
    expect(adopted).toHaveLength(1);
  });
});

describe("afterCommit", () => {
  const opened: GuardResult = {
    held: true,
    holdId: "h",
    opened: true,
    counts: { ab: 4, ba: 4, minutes: 1 },
    managerRows: [{ id: "n1", toId: "a3" } as never],
  };

  test("an opened hold refreshes inboxes and hands the manager notices over", async () => {
    guard.afterCommit([{ held: false }, opened]);
    await vi.waitFor(() => expect(adopted).toEqual(["n1"]));
    expect(published).toEqual([{ type: "inbox_changed" }]);
  });

  const failing = (over: Partial<ConstructorParameters<typeof LoopGuard>[0]>) => {
    const error = vi.fn();
    const g = new LoopGuard({ ...deps, log: { ...deps.log, error } as never, ...over });
    return { g, error };
  };

  test("a failing inbox publish is logged and still hands the notices over", async () => {
    const { g, error } = failing({
      bus: {
        publishAll: () => {
          throw new Error("bus down");
        },
      },
    });
    expect(() => g.afterCommit([opened])).not.toThrow();
    await vi.waitFor(() => expect(adopted).toEqual(["n1"]));
    expect(error).toHaveBeenCalledTimes(1);
  });

  test("a rejected notice hand-over is logged and does not throw", async () => {
    const { g, error } = failing({
      runtimes: { adoptNotice: () => Promise.reject(new Error("no runtime")) },
    });
    expect(() => g.afterCommit([opened])).not.toThrow();
    await vi.waitFor(() => expect(error).toHaveBeenCalledTimes(1));
    expect(published).toEqual([{ type: "inbox_changed" }]);
  });

  test("nothing happens when no result opened a hold", () => {
    guard.afterCommit([{ held: false }, { held: true, holdId: "h", opened: false }]);
    expect(published).toEqual([]);
    expect(adopted).toEqual([]);
  });
});

describe("concurrency", () => {
  const insert = (
    tx: Parameters<Parameters<typeof t.db.transaction>[0]>[0],
    from: string,
    to: string,
    held: boolean,
  ) =>
    tx.execute(sql`insert into messages (id, kind, from_id, to_id, recipient_ids, body, state, created_at)
                   values (${`m${++seq}`}, 'message', ${from}, ${to}, ${`{"${to}"}`}::text[], 'x',
                           ${held ? "loop_held" : "pending"}, ${new Date(NOW.getTime() - 1000).toISOString()})`);

  test("transactions locking overlapping pairs in opposite orders all commit without a deadlock", async () => {
    const pairsAB = [pairOf("a1", "a2"), pairOf("a1", "a3")];
    const run = (pairs: ReturnType<typeof pairOf>[]) =>
      t.db.transaction(async (tx) => {
        await guard.lockPairs(tx, pairs);
        for (const p of pairs) await check1(tx, p.a, p.b);
      });
    const check1 = async (
      tx: Parameters<Parameters<typeof t.db.transaction>[0]>[0],
      a: string,
      b: string,
    ) => {
      const r = await guard.check(tx, a, b);
      await insert(tx, a, b, r.held);
    };
    const jobs = Array.from({ length: 12 }, (_, i) =>
      run(i % 2 ? pairsAB : [...pairsAB].reverse()),
    );
    const settled = await Promise.allSettled(jobs);
    expect(settled.filter((s) => s.status === "rejected")).toEqual([]);
  });

  test("two racing sends at the threshold open exactly one hold", async () => {
    await rows("a1", "a2", N);
    await rows("a2", "a1", N + 1);
    const key = sql`hashtextextended('loop:a1:a2', 0)`;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    // A third connection holds the pair's lock so both sends are queued behind it, then lets them go together.
    const holder = t.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${key})`);
      await gate;
    });
    await vi.waitFor(async () => {
      const [l] =
        await t.sql`select count(*)::int as n from pg_locks where locktype = 'advisory' and granted`;
      expect(l?.n).toBeGreaterThan(0);
    });
    const send = () =>
      t.db.transaction(async (tx) => {
        await guard.lockPairs(tx, [pairOf("a1", "a2")]);
        const r = await guard.check(tx, "a1", "a2");
        await insert(tx, "a1", "a2", r.held);
        return r;
      });
    const sends = [send(), send()];
    await vi.waitFor(async () => {
      const [l] =
        await t.sql`select count(*)::int as n from pg_locks where locktype = 'advisory' and not granted`;
      expect(l?.n).toBe(2);
    });
    release();
    await holder;
    const results = await Promise.all(sends);
    expect(results.filter((r) => r.held && r.opened)).toHaveLength(1);
    expect(results.filter((r) => r.held && !r.opened)).toHaveLength(1);
    const [c] = await t.sql`select count(*)::int as n from loop_holds where resumed_at is null`;
    expect(c?.n).toBe(1);
  });
});
