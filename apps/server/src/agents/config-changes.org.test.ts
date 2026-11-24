import type { AgentRow } from "@open-factory/db";
import type { Actor, AnyEvent, ConfigDoc } from "@open-factory/shared";
import { expect, test } from "vitest";
import { ConfigChanges } from "./config-changes.ts";

/** I7 §8.2: who is told when an agent actor changes an agent's overlay (fake ports, no database). */

const doc = (template: Record<string, unknown> = {}): ConfigDoc => ({
  template: { name: "dev", display_name: "Dev", runtime: "local", ...template },
  settings: {},
  mcp: { mcpServers: {} },
});

const row = (id: string, slug: string, reportsTo: string | null): AgentRow =>
  ({
    id,
    slug,
    kind: "persistent",
    runtime: "local",
    reportsTo,
    config: {},
    archivedAt: null,
    terminatedAt: null,
  }) as AgentRow;

const lead = row("lead-id", "lead", null);
const dev = row("dev-id", "dev", "lead-id");
const hrRow = row("hr-id", "hr", "lead-id");
const solo = row("solo-id", "solo", null);

const agentActor = (r: AgentRow): Actor => ({ kind: "agent", id: r.id, slug: r.slug });

function world(live: AgentRow[] = []) {
  const restarts: { id: string; wake: boolean }[] = [];
  const reportNotices: { managerId: string; reportId: string; by: string; lines: string[] }[] = [];
  const own: { id: string; lines: string[] }[] = [];
  const events: AnyEvent[] = [];
  const changes = new ConfigChanges({
    agents: {
      liveOfTemplate: async () => live,
      liveChildren: async () => [],
      allLive: async () => [],
      currentEffective: async () => undefined,
    },
    resolver: { libraryOf: async () => ({ skills: {}, plugins: {} }) },
    templates: { scan: async () => {} },
    store: {
      append: async (_id: string, _turn: string | null, event: AnyEvent) => {
        events.push(event);
        return {} as never;
      },
    },
    runtimes: {
      get: async () =>
        ({
          hasProcess: () => true,
          appendConfigChanged: async (by: string, changes: string[]) => {
            events.push({ type: "config_changed", by, changes });
          },
        }) as never,
      recordConfigNotice: async (id: string, lines: string[]) => void own.push({ id, lines }),
      recordReportNotice: async (
        managerId: string,
        reportId: string,
        by: string,
        lines: string[],
      ) => void reportNotices.push({ managerId, reportId, by, lines }),
      requestRestart: async (id: string, opts?: { wake?: boolean }) =>
        void restarts.push({ id, wake: opts?.wake === true }),
      setNextImage: () => {},
      imageRef: () => undefined,
      startedOf: () => undefined,
    },
    bus: { publishAll: () => {} },
    log: { error: () => {} },
  });
  return { changes, reportNotices, own, events, restarts };
}

const before = doc({ model: "sonnet" });
const after = doc({ model: "haiku" });

test("an agent changing a report's overlay gives the manager one passive notice", async () => {
  const w = world();
  await w.changes.overlaySaved(dev, agentActor(hrRow), before, after);
  expect(w.reportNotices).toEqual([
    { managerId: "lead-id", reportId: "dev-id", by: "@hr", lines: ["model: sonnet → haiku"] },
  ]);
  expect(w.events).toEqual([
    { type: "config_changed", by: "@hr", changes: ["model: sonnet → haiku"] },
  ]);
});

test("the manager changing its own report gets no notice about its own act", async () => {
  const w = world();
  await w.changes.overlaySaved(dev, agentActor(lead), before, after);
  expect(w.reportNotices).toEqual([]);
});

test("an agent editing itself notifies its own manager", async () => {
  const w = world();
  await w.changes.overlaySaved(hrRow, agentActor(hrRow), before, after);
  expect(w.reportNotices).toEqual([
    { managerId: "lead-id", reportId: "hr-id", by: "@hr", lines: ["model: sonnet → haiku"] },
  ]);
});

test("a top-level target has no manager, so nobody is notified", async () => {
  const w = world();
  await w.changes.overlaySaved(solo, agentActor(hrRow), before, after);
  expect(w.reportNotices).toEqual([]);
});

test("a human actor sends no manager notice", async () => {
  const w = world();
  await w.changes.overlaySaved(dev, { kind: "human", handle: "or" }, before, after);
  expect(w.reportNotices).toEqual([]);
  expect(w.own.map((n) => n.id)).toEqual(["dev-id"]);
});

test("a change with no effective difference sends nothing", async () => {
  const w = world();
  await w.changes.overlaySaved(dev, agentActor(hrRow), before, before);
  expect(w.reportNotices).toEqual([]);
});

const tplChange = (actor?: Actor) => ({
  name: "dev",
  before,
  after,
  by: actor ? `@${actor.kind === "agent" ? actor.slug : actor.handle}` : "file change",
  ...(actor ? { actor } : {}),
});

test("a template written by an agent: by names the template, the manager is told, the actor's own agent wakes", async () => {
  const w = world([dev, hrRow]);
  await w.changes.templateChanged(tplChange(agentActor(hrRow)));
  expect(w.events.map((e) => (e as { by: string }).by)).toEqual([
    "@hr in template dev",
    "@hr in template dev",
  ]);
  // Both report to lead, who isn't the actor: one notice each, naming the actor alone.
  expect(w.reportNotices.map((n) => [n.managerId, n.reportId, n.by])).toEqual([
    ["lead-id", "dev-id", "@hr"],
    ["lead-id", "hr-id", "@hr"],
  ]);
  // Only the actor's own agent wakes on its restart.
  expect(w.restarts).toEqual([
    { id: "dev-id", wake: false },
    { id: "hr-id", wake: true },
  ]);
});

test("a template written by the manager tells it nothing, and wakes only itself", async () => {
  const w = world([dev, lead]);
  await w.changes.templateChanged(tplChange(agentActor(lead)));
  expect(w.reportNotices).toEqual([]);
  expect(w.restarts.find((r) => r.id === "lead-id")).toEqual({ id: "lead-id", wake: true });
});

test("a template written by a human or found on disk keeps today's by and sends no manager notice", async () => {
  for (const actor of [{ kind: "human", handle: "or" } as const, undefined]) {
    const w = world([dev]);
    await w.changes.templateChanged(tplChange(actor));
    expect((w.events[0] as { by: string }).by).toBe(
      actor ? "template dev" : "a file change in template dev",
    );
    expect(w.reportNotices).toEqual([]);
    expect(w.restarts).toEqual([{ id: "dev-id", wake: false }]);
  }
});
