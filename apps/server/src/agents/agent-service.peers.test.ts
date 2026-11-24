import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { schema } from "@open-factory/db";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { makeTestApp } from "../test/helpers.ts";
import { FakeDriver } from "./testing/fake-driver.ts";

let h: Awaited<ReturnType<typeof makeTestApp>>;
beforeEach(async () => {
  h = await makeTestApp({ harnessDriver: new FakeDriver(), env: { FACTORY_AGENT_PORT: "0" } });
  const d = path.join(h.factoryHome, "templates", "lead");
  mkdirSync(d, { recursive: true });
  writeFileSync(path.join(d, "template.yaml"), "name: lead\ndisplay_name: lead\nruntime: local\n");
  writeFileSync(path.join(d, "AGENTS.md"), "# lead\n");
  const credId = randomUUID();
  await h.db.insert(schema.credentials).values({
    id: credId,
    name: "work",
    kind: "oauth_token",
    valueEnc: h.app.vault.seal("tok", `credentials:${credId}`),
  });
  await create("lead", "Lead", null);
  await create("dev", "Dev", "lead");
  await create("boss", "Boss", null);
  await h.sql`delete from messages where kind in ('peer_joined','peer_left')`; // a clean slate per test
});
afterEach(() => h.close());

const held = async (slug: string) =>
  (
    await h.sql`select m.kind, m.notice, m.body from messages m join agents a on a.id = m.to_agent_id
                where a.slug = ${slug} and m.kind in ('peer_joined','peer_left') order by m.created_at`
  ).map((r) => ({ ...r }));
function create(slug: string, displayName: string, reportsTo: string | null) {
  return h.app.agents.create(
    {
      template: "lead",
      slug,
      displayName,
      description: "d",
      reportsTo,
      credential: "work",
    },
    { kind: "human", handle: "or" },
  );
}

test("create: peers get 'joined as your peer', the manager 'joined as your report'", async () => {
  await create("pmo", "PMO", "lead");
  expect(await held("dev")).toEqual([
    { kind: "peer_joined", notice: "peer", body: "@pmo (PMO) joined as your peer." },
  ]);
  expect(await held("lead")).toEqual([
    { kind: "peer_joined", notice: "report", body: "@pmo (PMO) joined as your report." },
  ]);
  expect(await held("pmo")).toEqual([]);
});

test("manager change: left the old neighborhood, joined the new; the moved agent gets no event but a restart", async () => {
  const restart = vi.spyOn(h.app.runtimes, "requestRestart");
  await h.app.agents.update("dev", { reportsTo: "boss" }, { kind: "human", handle: "or" });
  expect(await held("lead")).toEqual([
    { kind: "peer_left", notice: "report", body: "@dev (Dev) left: now reports to @boss." },
  ]);
  expect(await held("boss")).toEqual([
    { kind: "peer_joined", notice: "report", body: "@dev (Dev) joined as your report." },
  ]);
  expect(await held("dev")).toEqual([]);
  // The moved agent's own org changed: S4's restart request gives it a fresh CLAUDE.md (spec §10.2, §17.2).
  const [dev] = await h.sql`select id from agents where slug = 'dev'`;
  expect(restart.mock.calls.map((c) => c[0])).toEqual([dev?.id]);
});

test("moving to the top level: 'now reports to the humans'; top-level agents become peers", async () => {
  await h.app.agents.update("dev", { reportsTo: null }, { kind: "human", handle: "or" });
  // lead loses a report and gains a top-level peer; boss gains a peer. Order by created_at is deterministic.
  expect(await held("lead")).toEqual([
    { kind: "peer_left", notice: "report", body: "@dev (Dev) left: now reports to the humans." },
    { kind: "peer_joined", notice: "peer", body: "@dev (Dev) joined as your peer." },
  ]);
  expect(await held("boss")).toEqual([
    { kind: "peer_joined", notice: "peer", body: "@dev (Dev) joined as your peer." },
  ]);
});

test("archive and unarchive send left and joined; archived agents receive nothing", async () => {
  await h.app.agents.archive("dev", { kind: "human", handle: "or" });
  expect(await held("lead")).toEqual([
    { kind: "peer_left", notice: "report", body: "@dev (Dev) left: archived." },
  ]);
  await h.app.agents.unarchive("dev", { kind: "human", handle: "or" });
  expect((await held("lead")).at(-1)).toEqual({
    kind: "peer_joined",
    notice: "report",
    body: "@dev (Dev) joined as your report.",
  });
  await h.app.agents.archive("boss", { kind: "human", handle: "or" });
  await create("new", "New", null);
  expect(await held("boss")).toEqual([]);
});

test("summaries count non-archived direct reports", async () => {
  expect((await h.app.agents.summary("lead")).reports).toBe(1);
  await h.app.agents.archive("dev", { kind: "human", handle: "or" });
  expect((await h.app.agents.summary("lead")).reports).toBe(0);
});
