import { afterEach, beforeEach, expect, test } from "vitest";
import { FakeDriver } from "../../agents/testing/fake-driver.ts";
import { makeTestApp, signUp } from "../../test/helpers.ts";
import { callTool, mcpCall } from "../testing/mcp-client.ts";

let h: Awaited<ReturnType<typeof makeTestApp>>;
let url: string;
let tok: string;

beforeEach(async () => {
  h = await makeTestApp({ harnessDriver: new FakeDriver() });
  url = `http://127.0.0.1:${h.app.agentListener.port}`;
  await signUp(h.app, { handle: "or" });
  const ada = await h.seedAgent({ slug: "ada" });
  await h.seedAgent({ slug: "bob" });
  tok = h.app.agentTokens.mint(ada.id).token;
});
afterEach(() => h.close());

const text = (r: { content: { text: string }[] }) => r.content[0]?.text ?? "";

test("the result is {results} as JSON text, one entry per recipient in order", async () => {
  const r = await callTool(url, tok, "send_message", { to: ["@or", "bob"], body: "hi both" });
  expect(r.isError).toBeFalsy();
  const out = JSON.parse(text(r));
  expect(Object.keys(out)).toEqual(["results"]);
  expect(out.results).toMatchObject([
    { to: "@or", kind: "human", status: "inbox" },
    { to: "@bob", kind: "agent", status: "queued", recipient_status: "hibernated" },
  ]);
});

test("every recipient refused is a tool error with one line per reason", async () => {
  const r = await callTool(url, tok, "send_message", { to: ["ghost", "ada", "#ops"], body: "x" });
  expect(r.isError).toBe(true);
  expect(text(r).split("\n")).toEqual([
    "No agent or user named 'ghost'. Call list_peers to see who you can message.",
    "You can't message yourself.",
    "Channels aren't supported yet.",
  ]);
});

test("a partial refusal is still a result", async () => {
  const r = await callTool(url, tok, "send_message", { to: ["ghost", "bob"], body: "x" });
  expect(r.isError).toBeFalsy();
  expect(JSON.parse(text(r)).results.map((x: { status: string }) => x.status)).toEqual([
    "refused",
    "queued",
  ]);
});

test("a string `to` is a validation error; so is an empty list and more than ten", async () => {
  for (const to of ["bob", [], Array.from({ length: 11 }, (_, i) => `a${i}`)]) {
    const r = await callTool(url, tok, "send_message", { to, body: "x" });
    expect(r.isError, JSON.stringify(to)).toBe(true);
  }
  const blank = await callTool(url, tok, "send_message", { to: ["  "], body: "x" });
  expect(blank.isError).toBe(true);
  expect(text(blank)).toContain("Name a recipient");
  const many = await callTool(url, tok, "send_message", {
    to: Array.from({ length: 11 }, (_, i) => `a${i}`),
    body: "x",
  });
  expect(text(many)).toContain("Send to at most 10 recipients at once.");
});

test("the description speaks of handles and lists, never @humans", async () => {
  const list = await mcpCall(url, tok, "tools/list", {});
  const tool = (
    list.json.result.tools as { name: string; description: string; inputSchema: unknown }[]
  ).find((t) => t.name === "send_message");
  expect(tool?.description).toBe(
    "Send a message to one or more handles (an agent's @slug or a person's @handle), up to 10. Every recipient sees the full list. Set urgent to interrupt agents that are working.",
  );
  expect(JSON.stringify(tool)).not.toContain("@humans");
});
