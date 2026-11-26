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
  const ada = await h.seedAgent({ handle: "ada" });
  await h.seedAgent({ handle: "bob" });
  tok = h.app.agentTokens.mint(ada.id).token;
});
afterEach(() => h.close());

const text = (r: { content: { text: string }[] }) => r.content[0]?.text ?? "";

test("the result is {results} as JSON text, one entry per recipient in order", async () => {
  const r = await callTool(url, tok, "send_message", { to: ["@or", "bob"], body: "hi both" });
  expect(r.isError).toBeFalsy();
  const out = JSON.parse(text(r));
  expect(out.results).toMatchObject([
    { to: expect.stringMatching(/^<@[0-9a-z]{8}\|or>$/), kind: "human", status: "inbox" },
    {
      to: expect.stringMatching(/^<@[0-9a-z]{8}\|bob>$/),
      kind: "agent",
      status: "queued",
      recipient_status: "hibernated",
    },
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
  // an archived recipient is refused too, and nothing is written for it
  await h.app.agents.archive(await h.refOf("bob"), {
    kind: "human",
    ref: "k7x2m9qd",
    handle: "or",
  });
  const archived = await callTool(url, tok, "send_message", { to: ["bob"], body: "x" });
  expect(archived.isError).toBe(true);
  expect(text(archived)).toBe("@bob is archived and can't receive messages.");
  expect(await h.sql`select id from messages where kind = 'message'`).toEqual([]);
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

test("the tool never mentions @humans", async () => {
  const list = await mcpCall(url, tok, "tools/list", {});
  const tool = (
    list.json.result.tools as { name: string; description: string; inputSchema: unknown }[]
  ).find((t) => t.name === "send_message");
  expect(JSON.stringify(tool)).not.toContain("@humans");
});

test("send_message to a plain handle delivers and warns", async () => {
  const bob = await h.sql`select ref from principals where handle = 'bob'`;
  const r = await callTool(url, tok, "send_message", { to: ["bob"], body: "hi" });
  expect(r.isError).toBeFalsy();
  const out = JSON.parse(text(r));
  expect(out.results).toMatchObject([
    { to: expect.stringMatching(/^<@[0-9a-z]{8}\|bob>$/), status: "queued" },
  ]);
  expect(out.warnings).toEqual([
    `Plain tag detected: @bob was resolved to <@${bob[0]?.ref}|bob>. Tag as <@ref|handle>.`,
  ]);
});

test("send_message to a tag delivers with no warning, even when its handle label is stale", async () => {
  const [bob] = await h.sql`select ref from principals where handle = 'bob'`;
  const r = await callTool(url, tok, "send_message", { to: [`<@${bob?.ref}|old>`], body: "hi" });
  expect(r.isError).toBeFalsy();
  const out = JSON.parse(text(r));
  expect(out.results).toMatchObject([
    { to: expect.stringMatching(/^<@[0-9a-z]{8}\|bob>$/), status: "queued" },
  ]);
  expect(out).not.toHaveProperty("warnings");
});

test("send_message to an unknown ref is refused with the fix-it error", async () => {
  const r = await callTool(url, tok, "send_message", { to: ["<@zzzzzzzz>"], body: "hi" });
  expect(r.isError).toBe(true);
  expect(text(r)).toBe(
    "<@zzzzzzzz> isn't anyone in this factory; list_peers shows each agent and human with their tag.",
  );
  expect(await h.sql`select id from messages where kind = 'message'`).toEqual([]);
});

test("send_message with an unknown tag is refused and nothing is sent", async () => {
  const r = await callTool(url, tok, "send_message", { to: ["bob"], body: "ask <@zzzzzzzz> too" });
  expect(r.isError).toBe(true);
  expect(text(r)).toBe(
    "<@zzzzzzzz> isn't anyone in this factory; list_peers shows each agent and human with their tag.",
  );
  expect(await h.sql`select id from messages where kind = 'message'`).toEqual([]);
});

test("send_message stores a plain @handle in the body as a tag and warns", async () => {
  const [bob] = await h.sql`select ref from principals where handle = 'bob'`;
  const r = await callTool(url, tok, "send_message", { to: ["bob"], body: "ask @bob later" });
  expect(r.isError).toBeFalsy();
  expect(JSON.parse(text(r)).warnings).toEqual([
    `Plain tag detected: @bob was resolved to <@${bob?.ref}|bob>. Tag as <@ref|handle>.`,
  ]);
  const [row] = await h.sql`select body from messages where kind = 'message'`;
  expect(row?.body).toBe(`ask <@${bob?.ref}> later`);
});
