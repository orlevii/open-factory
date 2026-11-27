import { afterAll, beforeAll, expect, test } from "vitest";
import { EventStore } from "../agents/event-store.ts";
import { insertAgent } from "../agents/testing/rows.ts";
import { Neighborhood } from "../messaging/neighborhood.ts";
import { createTestDb } from "../test/helpers.ts";
import { principalSql, testRef } from "../test/principals.ts";
import { callerOf, createFactoryMcp, toolUseIdOf } from "./server.ts";
import { listPeersTool } from "./tools/list-peers.ts";

let t: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  t = await createTestDb();
  await t.sql.unsafe(principalSql("u1", "human", "or"));
  await t.sql`insert into users (id, name, email) values ('u1','Or','or@x.io')`;
  await t.sql.unsafe(principalSql("u2", "human", "ana"));
  await t.sql`insert into users (id, name, email) values ('u2','Ana','ana@x.io')`;
  await t.sql.unsafe(principalSql("u3", "human", "gone"));
  await t.sql`insert into users (id, name, email, disabled_at) values ('u3','Gone','gone@x.io', now())`;
  await insertAgent(t.sql, { id: "lead", handle: "lead", displayName: "Lead" });
  await insertAgent(t.sql, { id: "dev", handle: "dev", displayName: "Dev", reportsTo: "lead" });
  await insertAgent(t.sql, { id: "ops", handle: "ops", displayName: "Ops" });
  await insertAgent(t.sql, { id: "side", handle: "side", displayName: "Side", reportsTo: "ops" });
});
afterAll(async () => t.close());

function rpc(method: string, params: unknown, id = 1) {
  return new Request("http://agent.local/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
}

test("list_peers returns each peer's mention, relation and status for the authenticated caller", async () => {
  const errors: Error[] = [];
  const mcp = createFactoryMcp({
    version: "0.0.0",
    onerror: (e) => errors.push(e),
    loadCaller: (id) => new EventStore(t.db).agentById(id),
    tools: () => [listPeersTool({ neighborhood: new Neighborhood(t.db), statusOf: () => "idle" })],
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
  expect(dev).toEqual({
    peers: [
      {
        handle: "@lead",
        mention: `<@${testRef("lead")}|lead>`,
        kind: "agent",
        displayName: "Lead",
        description: "",
        relation: "manager",
        status: "idle",
      },
      { handle: "@ana", mention: `<@${testRef("u2")}|ana>`, kind: "human", name: "Ana" },
      { handle: "@or", mention: `<@${testRef("u1")}|or>`, kind: "human", name: "Or" },
    ],
  });
  const lead = await call("lead", "all");
  expect(
    lead.peers.map((p: { handle: string; kind: string; relation?: string }) => [
      p.handle,
      p.kind,
      p.relation,
    ]),
  ).toEqual([
    ["@ops", "agent", "peer"],
    ["@dev", "agent", "report"],
    ["@side", "agent", "other"],
    ["@ana", "human", undefined],
    ["@or", "human", undefined],
  ]);
  const hood = await call("lead");
  expect(hood.peers.some((p: { relation?: string }) => p.relation === "other")).toBe(false);
  expect(errors).toEqual([]);
});

test("callerOf refuses a call without an authenticated agent", () => {
  expect(() => callerOf({})).toThrow("factory MCP called without an authenticated agent");
  expect(() => callerOf({ http: {} })).toThrow();
  expect(() => callerOf({ http: { authInfo: {} } })).toThrow();
  expect(callerOf({ http: { authInfo: { clientId: "dev" } } })).toBe("dev");
});

test("toolUseIdOf keeps only a well-formed Claude tool-use id", () => {
  const of = (v: unknown) => toolUseIdOf({ mcpReq: { _meta: { "claudecode/toolUseId": v } } });
  expect(of("toolu_01ABCxyz")).toBe("toolu_01ABCxyz");
  expect(of(undefined)).toBeNull();
  expect(of(42)).toBeNull();
  expect(of("toolu_")).toBeNull();
  expect(of("x<script>")).toBeNull();
  expect(of(`toolu_${"a".repeat(200)}`)).toBeNull();
});

test("an agent id smuggled in the arguments is ignored: list_peers answers for the authenticated caller", async () => {
  const mcp = createFactoryMcp({
    version: "0.0.0",
    onerror: () => {},
    loadCaller: (id) => new EventStore(t.db).agentById(id),
    tools: () => [listPeersTool({ neighborhood: new Neighborhood(t.db), statusOf: () => "idle" })],
  });
  const res = await mcp(
    rpc("tools/call", {
      name: "list_peers",
      arguments: { agentId: "lead", clientId: "lead", caller: "lead" },
    }),
    "dev",
  );
  const raw = await res.text();
  const data = raw.startsWith("event:")
    ? (raw.split("\n").find((l) => l.startsWith("data:")) ?? "").slice(5)
    : raw;
  const out = JSON.parse(
    (JSON.parse(data) as { result: { content: { text: string }[] } }).result.content[0]?.text ??
      "null",
  );
  // dev's view (its manager), not lead's (its report and peer)
  expect(
    out.peers
      .filter((p: { kind: string }) => p.kind === "agent")
      .map((p: { handle: string; relation: string }) => [p.handle, p.relation]),
  ).toEqual([["@lead", "manager"]]);
});

test("an unknown caller gets no server: the request fails and no tools are built", async () => {
  const errors: Error[] = [];
  let built = 0;
  const mcp = createFactoryMcp({
    version: "0.0.0",
    onerror: (e) => errors.push(e),
    loadCaller: (id) => new EventStore(t.db).agentById(id),
    tools: () => {
      built += 1;
      return [listPeersTool({ neighborhood: new Neighborhood(t.db), statusOf: () => "idle" })];
    },
  });
  const res = await mcp(rpc("tools/list", {}), "nobody");
  expect(res.ok).toBe(false);
  expect(await res.text()).not.toContain("list_peers");
  expect(built).toBe(0);
  expect(errors.map((e) => e.message)).toContain("factory MCP request without a known caller");
});
