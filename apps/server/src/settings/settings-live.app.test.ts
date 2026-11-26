import { afterEach, expect, test, vi } from "vitest";
import type { AgentRuntime } from "../agents/agent-runtime.ts";
import { ev, FakeDriver, type FakeProcess } from "../agents/testing/fake-driver.ts";
import { sendAs } from "../agents/testing/runtime-harness.ts";
import { makeTestApp, signUp } from "../test/helpers.ts";

/**
 * S10 §8.2, AC4: a PATCH of the default warm window or the member-update debounce reaches the loaded runtimes over
 * the assembled app (the `settings.onChange` comparison in app.ts and the `AgentRuntimes.settingsChanged` fan-out).
 */
type T = Awaited<ReturnType<typeof makeTestApp>>;
let t: T | undefined;
afterEach(async () => {
  vi.useRealTimers();
  await t?.close();
  t = undefined;
});

const MIN = 60_000;

async function setup(factorySettings: {
  warmWindowMinutes?: number;
  memberUpdateDebounceSeconds?: number;
}) {
  const driver = new FakeDriver();
  t = await makeTestApp({ harnessDriver: driver, factorySettings });
  const app = t;
  const or = await signUp(app.app, { handle: "or" });
  const lead = await app.seedAgent({ slug: "lead" });
  const dev = await app.seedAgent({ slug: "dev" });
  await app.sql`update agents set reports_to = ${lead.id} where id = ${dev.id}`;
  const loaded = await app.app.runtimes.load(lead.id);
  if (!loaded) throw new Error("no runtime for lead");
  const rt: AgentRuntime = loaded;
  // Only timers and the clock: setImmediate (settled()) and the DB driver keep running for real.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], now: Date.now() });
  const tick = async (ms: number) => {
    await vi.advanceTimersByTimeAsync(ms);
    await rt.settled();
  };
  /** Started on session sess-1 and idle: the warm timer is armed when this returns. */
  const idle = async (): Promise<FakeProcess> => {
    await sendAs(app.app.store, rt, { fromUserId: or.user.id, body: "hi", urgent: false });
    await rt.settled();
    const p = driver.starts.filter((s) => s.spec.agentId === lead.id).at(-1);
    if (!p) throw new Error("lead never started");
    p.emit(...ev.fullTurn("sess-1"));
    await rt.settled();
    expect(rt.hibernatable()).toBe(true);
    return p;
  };
  const patch = async (payload: object) => {
    const r = await app.app.inject({
      method: "PATCH",
      url: "/api/settings/factory",
      headers: { cookie: or.cookie },
      payload,
    });
    expect(r.statusCode).toBe(200);
    await tick(0);
  };
  const events = async () => (await app.app.store.after(lead.id, 0, 1000)).map((e) => e.event);
  return { app, rt, lead, dev, tick, idle, patch, events };
}

test("lowering the default warm window over PATCH hibernates an idle agent already past it", async () => {
  const s = await setup({ warmWindowMinutes: 70 });
  const proc = await s.idle();
  await s.tick(2 * MIN);
  expect(proc.stopped).toBe(false);

  await s.patch({ warmWindowMinutes: 1 });

  expect(proc.stopped).toBe(true);
  expect((await s.events()).at(-1)).toMatchObject({ type: "hibernated", reason: "warm_window" });
});

test("a debounce of 0 over PATCH delivers a pending member update at once", async () => {
  const s = await setup({ memberUpdateDebounceSeconds: 30 });
  const proc = await s.idle();
  const row = await s.app.app.store.createOrgRow({
    kind: "member_update",
    toAgentId: s.lead.id,
    fromAgentId: s.dev.id,
    body: "progress",
  });
  await s.rt.receive(row);
  await s.tick(1_000);
  const written = () => proc.sent.flat().some((m) => m.body === "progress");
  expect(written()).toBe(false);

  await s.patch({ memberUpdateDebounceSeconds: 0 });

  expect(written()).toBe(true);
});
