import type { HarnessEvent, ServerMessage } from "@open-factory/shared";
import { afterAll, beforeAll, expect, test } from "vitest";
import { ev } from "./testing/fake-driver.ts";
import { okSpec, RuntimeHarness } from "./testing/runtime-harness.ts";

// Spec §7.3 step 8: the first `init`'s plugins against the closure the process was started with.
const h = new RuntimeHarness();
beforeAll(() => h.setup());
afterAll(() => h.close());

const EXPECTED = [
  { key: "p@mk", pin: "commit:abc" },
  { key: "q@mk", pin: "latest" },
];
const session = (plugins?: { name: string; path: string; source: string; version?: string }[]) =>
  ({ ...ev.session(), ...(plugins ? { plugins } : {}) }) as HarnessEvent;
const withPlugins = (a: { id: string; slug: string }) => ({ ...okSpec(a), plugins: EXPECTED });
const events = async () => (await h.store.after(h.agentId, 0, 1000)).map((e) => e.event);
const notices = () =>
  h.t.sql<{ body: string; notice: string; subject_agent_id: string }[]>`
    select body, notice, subject_agent_id from messages where notice = 'plugin_not_loaded' order by body`;

test("a plugin missing from init leaves the agent running, adds the event and sends one notice per user", async () => {
  await h.makeRuntime({ spec: withPlugins });
  const inbox: ServerMessage[] = [];
  h.bus.subscribeUser("u1", (m) => inbox.push(m));
  await h.send("hi");
  h.driver.last.emit(
    session([{ name: "p", path: "/P/cache/mk/p/1.0.0", source: "p@mk", version: "1.0.0" }]),
    ev.turn(),
  );
  await h.rt.settled();

  expect((await events()).filter((e) => e.type === "plugin_not_loaded")).toEqual([
    { type: "plugin_not_loaded", key: "q@mk", pin: "latest" },
  ]);
  const rows = await notices();
  expect(rows).toEqual([
    {
      body: `q@mk didn't load for @${h.rt.agent.slug}.`,
      notice: "plugin_not_loaded",
      subject_agent_id: h.agentId,
    },
  ]);
  expect(inbox.filter((m) => m.type === "inbox_changed")).toHaveLength(1);
  // The process is still there: nothing stopped it.
  expect(h.driver.last.stopped).toBeFalsy();
  expect(h.rt.loadedPlugins).toEqual({ "p@mk": "1.0.0" });
});

test("every plugin loaded: no event, no notice, and the loaded versions are kept outside started.library", async () => {
  await h.t.sql`delete from messages where notice = 'plugin_not_loaded'`;
  await h.makeRuntime({ spec: withPlugins });
  await h.send("hi");
  h.driver.last.emit(
    session([
      { name: "p", path: "/P/cache/mk/p/1.0.0", source: "p@mk", version: "1.0.0" },
      { name: "q", path: "/P/cache/mk/q/2.0.0", source: "q@mk", version: "2.0.0" },
    ]),
    ev.turn(),
  );
  await h.rt.settled();
  expect((await events()).map((e) => e.type)).not.toContain("plugin_not_loaded");
  expect(await notices()).toEqual([]);
  expect(h.rt.loadedPlugins).toEqual({ "p@mk": "1.0.0", "q@mk": "2.0.0" });
  expect(h.rt.started?.library.plugins).toEqual({});
});

test("an init with no plugins list means every expected plugin is missing", async () => {
  await h.t.sql`delete from messages where notice = 'plugin_not_loaded'`;
  await h.makeRuntime({ spec: withPlugins });
  await h.send("hi");
  h.driver.last.emit(session(), ev.turn());
  await h.rt.settled();
  expect((await events()).filter((e) => e.type === "plugin_not_loaded")).toHaveLength(2);
  expect(await notices()).toHaveLength(2);
});
