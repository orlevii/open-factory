import type { HarnessEvent } from "@open-factory/shared";
import { afterAll, beforeAll, expect, test } from "vitest";
import { ev } from "./testing/fake-driver.ts";
import { RuntimeHarness } from "./testing/runtime-harness.ts";

const h = new RuntimeHarness();
beforeAll(() => h.setup());
afterAll(() => h.close());
const session = (mcpServers: { name: string; status: string }[]): HarnessEvent => ({
  type: "session_started",
  sessionId: "sess-1",
  model: "m",
  cwd: "/w",
  claudeCodeVersion: "2.1.327",
  mcpServers,
});
const types = async () => (await h.store.after(h.agentId, 0, 1000)).map((e) => e.event.type);

test("each launch mints a token, passes it to prepareStart, and its exit revokes exactly that one", async () => {
  await h.makeRuntime();
  await h.send("hi");
  expect(h.tokenCalls).toEqual([["mint", h.agentId, 1]]);
  expect(h.lastAgentToken).toBe("tok-1");
  h.driver.last.emit(...ev.fullTurn("sess-1"));
  await h.rt.settled();
  h.driver.last.exit(0);
  await h.rt.settled();
  expect(h.tokenCalls).toContainEqual(["revoke", h.agentId, 1]);
});

test("a start that fails before a process exists revokes its token", async () => {
  await h.makeRuntime({ startError: new Error("prepare failed") });
  await h.send("hi").catch(() => {});
  await h.rt.settled();
  const minted = h.tokenCalls.filter((c) => c[0] === "mint");
  expect(minted).toHaveLength(1);
  expect(h.tokenCalls).toContainEqual(["revoke", h.agentId, minted[0]?.[2]]);
});

test("a session whose factory MCP failed appends mcp_unavailable once", async () => {
  await h.makeRuntime();
  await h.send("hi");
  h.driver.last.emit(
    session([{ name: "factory", status: "failed" }]),
    ev.turn(),
    ev.usage(),
    ev.end(),
  );
  await h.rt.settled();
  expect((await types()).filter((x) => x === "mcp_unavailable")).toHaveLength(1);
});

test("a missing factory entry is unavailable too", async () => {
  await h.makeRuntime();
  await h.send("hi");
  h.driver.last.emit(session([{ name: "x", status: "connected" }]));
  await h.rt.settled();
  expect((await types()).filter((x) => x === "mcp_unavailable")).toHaveLength(1);
});

test("connected and pending (init precedes the connection) are not failures", async () => {
  for (const status of ["connected", "pending"]) {
    await h.makeRuntime();
    await h.send("hi");
    h.driver.last.emit(session([{ name: "factory", status }]));
    await h.rt.settled();
    expect(await types()).not.toContain("mcp_unavailable");
  }
});
