import { schema } from "@open-factory/db";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createTestDb } from "../test/helpers.ts";
import { principalSql } from "../test/principals.ts";
import { TaskStore } from "./task-store.ts";

let t: Awaited<ReturnType<typeof createTestDb>>;
let store: TaskStore;
const ids = { lead: "a-lead", dev: "a-dev", kid: "a-kid", or: "u-or" };
let tick = 0;

beforeAll(async () => {
  t = await createTestDb();
  store = new TaskStore({ db: t.db, clock: () => new Date(Date.UTC(2026, 0, 1) + ++tick * 1000) });
  await t.sql.unsafe(principalSql(ids.or, "human", "or"));
  await t.sql`insert into users (id, name, email) values (${ids.or},'Or','or@x.io')`;
  await t.sql`insert into credentials (id,name,kind,value_enc) values ('c1','w','oauth_token','\\x00')`;
  await t.sql.unsafe(principalSql(ids.lead, "agent", "lead"));
  await t.sql`insert into agents (id,slug,display_name,template,config,runtime,kind,reports_to,credential_id) values
    (${ids.lead},'lead','Lead','t','{}','local','persistent',${ids.or},'c1')`;
  await t.sql.unsafe(principalSql(ids.dev, "agent", "dev"));
  await t.sql.unsafe(principalSql(ids.kid, "agent", "kid"));
  await t.sql`insert into agents (id,slug,display_name,template,config,runtime,kind,reports_to,credential_id) values
    (${ids.dev},'dev','Dev','t','{}','local','persistent',${ids.lead},'c1'),
    (${ids.kid},'kid','Kid','t','{}','local','ephemeral',${ids.dev},'c1')`;
});
afterAll(() => t.close());

const mk = (title: string) =>
  t.db.transaction((tx) =>
    store.insertTask(tx, { title, body: "", assigneeAgentId: null, createdBy: { userId: ids.or } }),
  );
const depend = (task: string, dep: string) =>
  t.db.insert(schema.taskDependencies).values({ taskId: task, dependsOnTaskId: dep });

test("insertTask numbers from a sequence and byNumber finds them", async () => {
  const a = await mk("one");
  const b = await mk("two");
  expect(b.number).toBe(a.number + 1);
  expect((await store.byNumber(t.db, b.number))?.title).toBe("two");
  expect((await store.byNumbers(t.db, [b.number, a.number])).map((x) => x.number)).toEqual([
    a.number,
    b.number,
  ]);
});

test("cyclePath finds the shortest path from the new dependency back to the task", async () => {
  const [a, b, c, d] = [await mk("a"), await mk("b"), await mk("c"), await mk("d")] as [
    Awaited<ReturnType<typeof mk>>,
    Awaited<ReturnType<typeof mk>>,
    Awaited<ReturnType<typeof mk>>,
    Awaited<ReturnType<typeof mk>>,
  ];
  await depend(a.id, b.id);
  await depend(b.id, c.id);
  // c depends on a would close a loop: a -> b -> c -> a.
  expect(await store.cyclePath(t.db, c.id, [a.id])).toEqual([a.number, b.number, c.number]);
  expect(await store.cyclePath(t.db, c.id, [d.id])).toBeNull();
});

test("cyclePath terminates on a graph that already holds a loop", async () => {
  const [x, y, z] = [await mk("x"), await mk("y"), await mk("z")] as [
    Awaited<ReturnType<typeof mk>>,
    Awaited<ReturnType<typeof mk>>,
    Awaited<ReturnType<typeof mk>>,
  ];
  await depend(x.id, y.id);
  await depend(y.id, x.id);
  expect(await store.cyclePath(t.db, z.id, [x.id])).toBeNull();
});

test("lockAgents is one statement ordered persistent before spawned, then id, with the lock above the sort", async () => {
  const rows = await t.db.transaction((tx) => store.lockAgents(tx, [ids.kid, ids.dev, ids.lead]));
  expect(rows.map((r) => r.id)).toEqual(
    [ids.dev, ids.lead, ids.kid].sort((x, y) =>
      x === ids.kid ? 1 : y === ids.kid ? -1 : x < y ? -1 : 1,
    ),
  );
  // EXPLAIN the statement lockAgents itself sends, not a hand-written copy.
  const plans: unknown[] = [];
  await t.db.transaction((tx) =>
    store.lockAgents(
      {
        execute: async (q: Parameters<typeof tx.execute>[0]) => {
          plans.push(await tx.execute(sql`explain (format json) ${q}`));
          return tx.execute(q);
        },
      } as never,
      [ids.kid, ids.dev],
    ),
  );
  expect(plans).toHaveLength(1);
  const json = JSON.stringify(plans[0]);
  expect(json.indexOf('"LockRows"')).toBeGreaterThan(-1);
  expect(json.indexOf('"LockRows"')).toBeLessThan(json.indexOf('"Sort"'));
});

async function waitForLock(): Promise<void> {
  for (;;) {
    const r =
      await t.sql`select 1 from pg_stat_activity where wait_event_type = 'Lock' and datname = current_database()`;
    if (r.length) return;
    await new Promise((res) => setImmediate(res));
  }
}

test("lockTasks locks in id order in one statement and a competing lock waits", async () => {
  const [a, b, c] = [await mk("l1"), await mk("l2"), await mk("l3")] as [
    Awaited<ReturnType<typeof mk>>,
    Awaited<ReturnType<typeof mk>>,
    Awaited<ReturnType<typeof mk>>,
  ];
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let locked!: () => void;
  const gotLocks = new Promise<void>((r) => (locked = r));
  const holder = t.db.transaction(async (tx) => {
    const rows = await store.lockTasks(tx, [c.id, a.id, b.id]);
    expect(rows.map((r) => r.id)).toEqual([a.id, b.id, c.id].sort());
    locked();
    await held;
  });
  await gotLocks;
  let done = false;
  const waiter = t.db.transaction(async (tx) => {
    await store.lockTasks(tx, [b.id]);
    done = true;
  });
  await waitForLock();
  expect(done).toBe(false);
  release();
  await Promise.all([holder, waiter]);
  expect(done).toBe(true);
});

test("managerChain walks reports_to upwards", async () => {
  expect(await store.managerChain(t.db, ids.kid)).toEqual([ids.dev, ids.lead]);
  expect(await store.managerChain(t.db, ids.dev)).toEqual([ids.lead]);
  expect(await store.managerChain(t.db, ids.lead)).toEqual([]);
});

test("replaceDependencies reports added and removed; replaceLinks keeps order", async () => {
  const [a, b, c] = [await mk("r1"), await mk("r2"), await mk("r3")] as [
    Awaited<ReturnType<typeof mk>>,
    Awaited<ReturnType<typeof mk>>,
    Awaited<ReturnType<typeof mk>>,
  ];
  expect(await store.replaceDependencies(t.db, a.id, [b.id])).toEqual({
    added: [b.id],
    removed: [],
  });
  expect(await store.replaceDependencies(t.db, a.id, [c.id])).toEqual({
    added: [c.id],
    removed: [b.id],
  });
  expect((await store.dependencies(t.db, a.id)).map((x) => x.id)).toEqual([c.id]);
  expect((await store.dependents(t.db, c.id)).map((x) => x.id)).toEqual([a.id]);
  await store.replaceLinks(t.db, a.id, [
    { kind: "url", target: "https://x.io", title: "X" },
    { kind: "agent", agentId: ids.dev },
    { kind: "file", target: "a.md" },
  ]);
  const links = await store.links(t.db, a.id);
  expect(links.map((l) => [l.kind, l.target ?? l.agentSlug])).toEqual([
    ["url", "https://x.io"],
    ["agent", "dev"],
    ["file", "a.md"],
  ]);
});

test("comments and events insert with strictly increasing times", async () => {
  const a = await mk("e1");
  await store.insertEvents(t.db, [
    { taskId: a.id, actor: { userId: ids.or }, type: "created" },
    { taskId: a.id, actor: { agentId: ids.dev }, type: "status", from: "open", to: "done" },
  ]);
  const ev = await t.db.select().from(schema.taskEvents).orderBy(sql`at`);
  const mine = ev.filter((e) => e.taskId === a.id);
  expect(mine.map((e) => e.type)).toEqual(["created", "status"]);
  expect(mine[1]?.at.getTime()).toBeGreaterThan(mine[0]?.at.getTime() as number);
  const c = await store.insertComment(t.db, {
    taskId: a.id,
    author: { agentId: ids.dev },
    body: "hi",
  });
  expect(c.authorAgentId).toBe(ids.dev);
  expect(c.createdAt.getTime()).toBeGreaterThan(mine[1]?.at.getTime() as number);
});
