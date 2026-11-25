import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import type { MountCheckContext } from "../workspace/mounts.ts";
import type { Effective } from "./config-resolver.ts";
import { AgentStartError } from "./errors.ts";
import { EventBus } from "./event-bus.ts";
import { notices, parseConfigNotice } from "./notices.ts";
import { AgentRuntimes } from "./runtimes.ts";
import type { PrepareStart, StartedOf } from "./start.ts";
import { ev, FakeDriver } from "./testing/fake-driver.ts";
import { insertAgent } from "./testing/rows.ts";
import {
  noForward,
  noopTokens,
  okSpec,
  RuntimeHarness,
  silentLog,
  testEffective,
} from "./testing/runtime-harness.ts";

/** I2 §6.2, §7.3: what `AgentRuntimes` adds for the config flow (started, the notice, nextImage), over a test DB. */
const h = new RuntimeHarness();
beforeAll(() => h.setup());
afterAll(() => h.close());
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

let n = 0;
async function agent(o: { docker?: boolean } = {}) {
  n += 1;
  const id = `rc${n}`;
  await insertAgent(h.t.sql, { id, slug: `rc-${n}` });
  if (o.docker) await h.t.sql`update agents set runtime = 'docker' where id = ${id}`;
  return id;
}

/** A world: runtimes over a fake driver; every start's `extra` is recorded, and each agent starts with its own config. */
function world(
  o: {
    /** The image each Docker agent's config resolves to at load; a throw is a template invalid at load. */
    imageAtLoad?: (agentId: string) => string;
  } = {},
) {
  const driver = new FakeDriver();
  const extras: { agentId: string; loaded: StartedOf }[] = [];
  const effectives = new Map<string, Effective>();
  const pulled: string[] = [];
  const prepareStart: PrepareStart = async (a, extra) => {
    extras.push({ agentId: a.id, loaded: extra.loaded });
    if (a.runtime === "docker") {
      let image = "img:default";
      try {
        if (o.imageAtLoad) image = o.imageAtLoad(a.id);
      } catch {
        throw new AgentStartError(
          `Template ${a.template} has errors. Fix it in Templates.`,
          "template",
        );
      }
      const effective = testEffective({ runtime: "docker", image });
      effectives.set(a.id, effective);
      return {
        ...okSpec(a),
        runtime: "docker",
        effective,
        launch: { image, mountCheck: {} as MountCheckContext },
      };
    }
    const spec = okSpec(a, { model: `model-of-${a.id}` });
    effectives.set(a.id, spec.effective);
    return spec;
  };
  const runtimes = new AgentRuntimes({
    store: h.store,
    bus: new EventBus(),
    driver,
    prepareStart,
    tokens: noopTokens,
    log: silentLog,
    forward: noForward,
    docker: {
      containers: {
        ensure: async () => ({
          containerId: "c1",
          action: "created" as const,
          imageId: "sha256:i",
        }),
        ensureImage: async (ref: string) => {
          pulled.push(ref);
        },
        stopIfRunning: async () => true,
        forceRemove: async () => true,
        remove: async () => true,
      },
      claudeBin: "/usr/local/bin/claude",
      defaultImage: "img:default",
      resolver: {
        effective: async (a) => {
          if (!o.imageAtLoad) return testEffective({ runtime: a.runtime });
          try {
            return testEffective({ runtime: a.runtime, image: o.imageAtLoad(a.id) });
          } catch {
            throw new AgentStartError(
              `Template ${a.template} has errors. Fix it in Templates.`,
              "template",
            );
          }
        },
      },
    },
  });
  closers.push(() => runtimes.stopAll());
  const send = async (agentId: string, body: string) => {
    const row = await h.store.createMessage({
      from: { userId: "u1" },
      toAgentId: agentId,
      recipients: [`@x`],
      body,
      urgent: false,
    });
    return runtimes.deliver(row, "human");
  };
  return { driver, runtimes, extras, effectives, pulled, send };
}

const configRows = (agentId: string) =>
  h.t.sql<{ body: string; state: string }[]>`
    select body, state from messages
    where to_agent_id = ${agentId} and kind = 'system' and notice = 'config_changed'`;

test("every start gets `loaded`: a running agent's started config, undefined once it exits or when not loaded", async () => {
  const w = world();
  const lead = await agent();
  const other = await agent();
  await w.send(lead, "hi");
  expect(w.driver.starts).toHaveLength(1);
  expect(w.runtimes.startedOf(lead)).toBe(w.effectives.get(lead));
  await w.send(other, "hi");
  const seen = w.extras.find((e) => e.agentId === other)?.loaded;
  if (!seen) throw new Error("no start for the other agent");
  // The very function `prepareStart` got reads the runtimes, live.
  expect(seen(lead)).toBe(w.effectives.get(lead));
  expect(seen(lead)?.config.model).toBe(`model-of-${lead}`);
  expect(seen("nobody")).toBeUndefined();
  await (await w.runtimes.get(lead))?.stop();
  expect(seen(lead)).toBeUndefined();
  expect(w.runtimes.startedOf(lead)).toBeUndefined();
});

test("an unloaded agent gets the notice through the store, merged, and is never loaded for it", async () => {
  const w = world();
  const id = await agent();
  await w.runtimes.recordConfigNotice(id, ["model: sonnet → opus"]);
  await w.runtimes.recordConfigNotice(id, ["added skill release"]);
  await w.runtimes.recordConfigNotice(id, []); // nothing to record
  expect(await w.runtimes.get(id)).toBeUndefined();
  const rows = await configRows(id);
  expect(rows).toHaveLength(1);
  expect(rows[0]?.state).toBe("pending");
  expect(parseConfigNotice(rows[0]?.body ?? "")).toEqual([
    "added skill release",
    "model: sonnet → opus",
  ]);
  // A later load queues it; the next start delivers it ahead of the message.
  await w.send(id, "hi");
  expect(w.driver.last.sent[0]?.map((m) => m.body)).toEqual([rows[0]?.body, "hi"]);
});

test("a loaded agent gets the notice through its runtime, merged in its queue", async () => {
  const w = world();
  const id = await agent();
  const rt = await w.runtimes.load(id);
  await w.runtimes.recordConfigNotice(id, ["model: sonnet → opus"]);
  await w.runtimes.recordConfigNotice(id, ["added skill release"]);
  expect(rt?.queueItems().map((i) => i.body)).toEqual([
    notices.configChanged(["added skill release", "model: sonnet → opus"]),
  ]);
  expect(await configRows(id)).toHaveLength(1);
});

test("a runtime whose load began during the store write adopts the row", async () => {
  const w = world();
  const id = await agent();
  // The write lands after the runtime's init read its queue: the init sees nothing, the adoption queues the row.
  const real = h.store.createNotice.bind(h.store);
  const spy = vi.spyOn(h.store, "createNotice").mockImplementationOnce(async (...args) => {
    await w.runtimes.load(id);
    return real(...args);
  });
  try {
    await w.runtimes.recordConfigNotice(id, ["model: sonnet → opus"]);
  } finally {
    spy.mockRestore();
  }
  const rt = await w.runtimes.get(id);
  expect(rt?.queueItems().map((i) => i.kind)).toEqual(["notice"]);
});

test("restartChanges: the runtime's while pending; empty for an agent with no runtime", async () => {
  const w = world();
  const id = await agent();
  expect((await w.runtimes.liveFields(id, { status: "hibernated" })).restartChanges).toEqual([]);
  await w.send(id, "hi");
  w.driver.last.emit(...ev.fullTurn("sess-1"), ev.turn());
  const rt = await w.runtimes.get(id);
  await rt?.settled();
  await w.runtimes.requestRestart(id, { changes: ["model: sonnet → opus"] });
  expect((await w.runtimes.liveFields(id, { status: "running" })).restartChanges).toEqual([
    "model: sonnet → opus",
  ]);
  w.driver.last.emit(ev.usage(), ev.end());
  await rt?.settled();
  expect((await w.runtimes.liveFields(id, { status: "hibernated" })).restartChanges).toEqual([]);
});

test("refOf reads nextImage: set at load, refreshed by setNextImage, undefined for a template invalid at load", async () => {
  let broken = "";
  const w = world({
    imageAtLoad: (id) => {
      if (id === broken) throw new Error("invalid");
      return `img:${id}`;
    },
  });
  const good = await agent({ docker: true });
  broken = await agent({ docker: true });
  const local = await agent();
  // Never loaded: nothing to keep.
  w.runtimes.setNextImage(good, "img:ignored");
  const rtGood = await w.runtimes.load(good);
  const rtBroken = await w.runtimes.load(broken);
  const rtLocal = await w.runtimes.load(local);
  expect(rtGood?.nextImage).toBe(`img:${good}`);
  expect(rtBroken?.nextImage).toBeUndefined();
  expect(rtLocal?.nextImage).toBeUndefined();
  // The Supervisor checks and pulls nextImage before the grant.
  await w.send(good, "hi");
  await vi.waitFor(() => expect(w.driver.starts).toHaveLength(1));
  expect(w.pulled).toEqual([`img:${good}`]);
  // A config change refreshes it for the next start.
  w.runtimes.setNextImage(good, "img:next");
  expect(rtGood?.nextImage).toBe("img:next");
  expect(w.runtimes.imageRef({ runtime: "docker", image: "img:x" })).toBe("img:x");
  expect(w.runtimes.imageRef({ runtime: "docker" })).toBe("img:default");
  expect(w.runtimes.imageRef({ runtime: "local", image: "img:x" })).toBeUndefined();
  // Invalid at load: no image to check, so nothing is pulled and the start itself fails closed.
  await w.send(broken, "hi").catch(() => {});
  await rtBroken?.settled();
  expect(w.pulled).toEqual([`img:${good}`]);
});
