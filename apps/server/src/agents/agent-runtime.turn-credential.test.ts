import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { ev } from "./testing/fake-driver.ts";
import { insertAgent } from "./testing/rows.ts";
import { okSpec, RuntimeHarness } from "./testing/runtime-harness.ts";

const h = new RuntimeHarness();
beforeAll(() => h.setup());
afterAll(() => h.close());
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  return () => vi.useRealTimers();
});

async function turnCredentials(agentId: string) {
  const rows = await h.t
    .sql`select credential_id from turns where agent_id = ${agentId} order by started_at, id`;
  return rows.map((r) => r.credential_id as string | null);
}
async function oneTurn(sessionId = "sess-1") {
  await h.send("go");
  h.driver.last.emit(...ev.fullTurn(sessionId));
  await h.rt.settled();
}

test("a persistent agent's turn records its credential", async () => {
  await h.makeRuntime();
  await oneTurn();
  expect(await turnCredentials(h.agentId)).toEqual([`cred-${h.agentId}`]);
});

test("a spawned agent's turn records the spawner's credential", async () => {
  await insertAgent(h.t.sql, { id: "spawner", handle: "spawner" });
  await h.makeRuntime({
    seed: async (id) => {
      await h.t
        .sql`update agents set kind = 'ephemeral', reports_to = 'spawner', credential_id = 'cred-spawner' where id = ${id}`;
    },
  });
  await h.rt.reload();
  await oneTurn();
  expect(await turnCredentials(h.agentId)).toEqual(["cred-spawner"]);
});

test("a spawned agent started on the spawner's credential while its own row still names another: the turn records the launch one", async () => {
  // prepareStart reads the spawner's current credential; a start can race syncChildren updating the child row.
  await insertAgent(h.t.sql, { id: "spawner2", handle: "spawner2" });
  await h.makeRuntime({ spec: (a) => ({ ...okSpec(a), credentialId: "cred-spawner2" }) });
  await oneTurn();
  expect(await turnCredentials(h.agentId)).toEqual(["cred-spawner2"]);
});

test("moving the agent to another credential mid-process: the next turn still records the launch credential", async () => {
  await h.makeRuntime();
  await oneTurn();
  const launch = `cred-${h.agentId}`;
  await insertAgent(h.t.sql, { id: "other", handle: "other" });
  await h.t.sql`update agents set credential_id = 'cred-other' where id = ${h.agentId}`;
  await h.rt.reload();
  await h.send("again");
  h.driver.last.emit(ev.turn(), ev.usage(), ev.end());
  await h.rt.settled();
  expect(h.driver.starts).toHaveLength(1);
  expect(await turnCredentials(h.agentId)).toEqual([launch, launch]);
});

test("after the credential row is deleted (agent terminated first), the turn's credential_id is NULL", async () => {
  await h.makeRuntime();
  await oneTurn();
  expect(await turnCredentials(h.agentId)).toEqual([`cred-${h.agentId}`]);
  // A terminated agent is ephemeral, so it reports to someone (a DB check).
  await insertAgent(h.t.sql, { id: "boss", handle: "boss" });
  await h.t
    .sql`update agents set kind = 'ephemeral', reports_to = 'boss', terminated_at = now(), terminated_by = null where id = ${h.agentId}`;
  await h.t.sql`delete from credentials where id = ${`cred-${h.agentId}`}`;
  expect(await turnCredentials(h.agentId)).toEqual([null]);
});
