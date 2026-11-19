import { afterAll, beforeAll, expect, test } from "vitest";
import { insertAgent } from "../agents/testing/rows.ts";
import { Neighborhood } from "../messaging/neighborhood.ts";
import { createTestDb } from "../test/helpers.ts";
import { createFactoryMcp } from "./server.ts";
import { listPeersTool } from "./tools/list-peers.ts";

let t: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  t = await createTestDb();
  await t.sql`insert into users (id,name,email,handle) values ('u1','Or','or@x.io','or')`;
  await insertAgent(t.sql, { id: "lead", slug: "lead", displayName: "Lead" });
  await insertAgent(t.sql, { id: "dev", slug: "dev", displayName: "Dev", reportsTo: "lead" });
  await insertAgent(t.sql, { id: "ops", slug: "ops", displayName: "Ops" });
});
afterAll(async () => t.close());

function rpc(method: string, params: unknown, id = 1) {
  return new Request("http://agent.local/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
}

test("list_peers reads the caller from authInfo and reports relations and status", async () => {
  const errors: Error[] = [];
  const mcp = createFactoryMcp({
    version: "0.0.0",
    onerror: (e) => errors.push(e),
    tools: [listPeersTool({ neighborhood: new Neighborhood(t.db), statusOf: () => "idle" })],
  });
  const call = async (agentId: string, scope?: string) => {
    const res = await mcp(
      rpc("tools/call", { name: "list_peers", arguments: scope ? { scope } : {} }),
      agentId,
    );
    const raw = await res.text();
    const data = raw.startsWith("event:")
      ? (raw.split("\n").find((l) => l.startsWith("data:")) ?? "").slice(5)
      : raw;
    const json = JSON.parse(data) as { result: { content: { text: string }[] } };
    return JSON.parse(json.result.content[0]?.text ?? "null");
  };
  const dev = await call("dev");
  expect(dev.agents).toEqual([
    { slug: "lead", displayName: "Lead", description: "", relation: "manager", status: "idle" },
  ]);
  expect(dev.humans).toEqual([{ handle: "or", name: "Or" }]);
  const lead = await call("lead", "all");
  expect(lead.agents.map((a: { slug: string; relation: string }) => [a.slug, a.relation])).toEqual([
    ["ops", "peer"],
    ["dev", "report"],
  ]);
  expect(errors).toEqual([]);
});
