import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { claimTestHandleSql } from "../test/handles.ts";
import { createTestDb } from "../test/helpers.ts";
import { AgentRuntime } from "./agent-runtime.ts";
import { EventBus } from "./event-bus.ts";
import { EventStore } from "./event-store.ts";
import { liveCredentialId } from "./live-credential.ts";
import { ev, FakeDriver } from "./testing/fake-driver.ts";
import { insertAgent } from "./testing/rows.ts";
import { noForward, noopTokens, sendAs, testEffective } from "./testing/runtime-harness.ts";
import { unlimitedSlots } from "./testing/unlimited-slots.ts";

let t: Awaited<ReturnType<typeof createTestDb>>;
let store: EventStore;
let n = 0;
beforeAll(async () => {
  t = await createTestDb();
  store = new EventStore(t.db);
  await claimTestHandleSql(t.sql, "or", "user");
  await t.sql`insert into users (id, name, email, handle) values ('u1', 'Or', 'or@x.io', 'or')`;
});
afterAll(() => t.close());

let driver: FakeDriver;
let rt: AgentRuntime;
async function make(runtime: "local" | "docker" = "local") {
  n += 1;
  await insertAgent(t.sql, { id: `c${n}`, slug: `cron${n}` });
  if (runtime === "docker") await t.sql`update agents set runtime = 'docker' where id = ${`c${n}`}`;
  driver = new FakeDriver();
  const agent = await store.agentById(`c${n}`);
  if (!agent) throw new Error("no agent");
  rt = new AgentRuntime({
    tokens: noopTokens,
    forward: noForward,
    agent,
    store,
    bus: new EventBus(),
    driver,
    prepareStart: async (a) => ({
      credentialId: liveCredentialId(a),
      agentId: a.id,
      slug: a.slug,
      cwd: "/w",
      env: {},
      claudeBin: "claude",
      runtime: "local",
      permissionMode: "auto",
      mounts: [],
      effective: testEffective(),
      plugins: [],
    }),
    log: { debug() {}, info() {}, warn() {}, error() {} },
    slots: unlimitedSlots,
  });
  await rt.init();
}
beforeEach(() => make());

async function started() {
  await sendAs(store, rt, { fromUserId: "u1", body: "go", urgent: false });
  driver.last.emit(ev.session(), ev.turn());
  await rt.settled();
}

test("the status lists live crons: a one-shot with nextFireAt, a recurring one with expiresAt, durable carried", async () => {
  await started();
  const before = Date.now();
  driver.last.emit(
    {
      ...ev.cron("r1", { recurring: true, humanSchedule: "every 5 minutes" }),
      durable: false,
    } as never,
    {
      ...ev.cron("o1", { recurring: false, humanSchedule: "at 14:30, once", inMs: 600_000 }),
      durable: true,
    } as never,
  );
  await rt.settled();
  const crons = rt.live().crons;
  const r1 = crons.find((c) => c.cronId === "r1");
  const o1 = crons.find((c) => c.cronId === "o1");
  expect(r1).toMatchObject({ recurring: true, durable: false, humanSchedule: "every 5 minutes" });
  expect(r1?.nextFireAt).toBeUndefined();
  expect(new Date(r1?.expiresAt as string).getTime()).toBeGreaterThanOrEqual(
    before + 7 * 86_400_000,
  );
  expect(o1).toMatchObject({ recurring: false, durable: true });
  expect(o1?.expiresAt).toBeUndefined();
  expect(new Date(o1?.nextFireAt as string).getTime()).toBeGreaterThan(before);
  expect(rt.statusFrame().crons).toHaveLength(2);
  expect(rt.waitingOn().crons).toBe(2);
});

test("a deleted cron disappears at once; a one-shot disappears after its cron turn ends", async () => {
  await started();
  driver.last.emit(ev.cron("r1"), ev.cron("o1", { recurring: false, inMs: -1_000 }));
  await rt.settled();
  driver.last.emit({ type: "cron_deleted", cronId: "r1" });
  await rt.settled();
  expect(rt.live().crons.map((c) => c.cronId)).toEqual(["o1"]);
  // The one-shot's time has passed, but it stays until a cron turn ends.
  driver.last.emit(ev.end());
  await rt.settled();
  expect(rt.live().crons.map((c) => c.cronId)).toEqual(["o1"]);
  driver.last.emit(ev.turn(), ev.end({ originKind: "cron" }));
  await rt.settled();
  expect(rt.live().crons).toEqual([]);
});

test("cronZone is UTC for a Docker agent and the server's zone for a local one", async () => {
  expect(rt.live().cronZone).toBe(new Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  await make("docker");
  expect(rt.live().cronZone).toBe("UTC");
});
