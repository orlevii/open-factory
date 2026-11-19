import { afterEach, beforeEach, expect, test } from "vitest";
import { ev, FakeDriver } from "../agents/testing/fake-driver.ts";
import { callTool } from "../mcp/testing/mcp-client.ts";
import { makeTestApp, signUp } from "../test/helpers.ts";

let h: Awaited<ReturnType<typeof makeTestApp>>;
let driver: FakeDriver;
let cookie: string;
let tokA: string;
let url: string;
beforeEach(async () => {
  driver = new FakeDriver();
  h = await makeTestApp({ harnessDriver: driver });
  url = `http://127.0.0.1:${h.app.agentListener.port}`;
  await h.seedAgent({ slug: "ada" });
  await h.seedAgent({ slug: "bob" });
  cookie = (await signUp(h.app, { handle: "or" })).cookie;
  await h.app.inject({
    method: "POST",
    url: "/api/agents/ada/messages",
    headers: { cookie },
    payload: { body: "hi" },
  });
  driver.last.emit(...ev.fullTurn("sess-a"));
  await (await h.app.runtimes.bySlug("ada"))?.settled();
  tokA = driver.last.spec.env.OPEN_FACTORY_AGENT_TOKEN as string;
});
afterEach(() => h.close());

const get = (path: string, headers: Record<string, string> = { cookie }) =>
  h.app.inject({ method: "GET", url: path, headers });
const procOf = (slug: string) => {
  const p = driver.starts.filter((s) => s.spec.slug === slug).at(-1);
  if (!p) throw new Error(`${slug} not started`);
  return p;
};
/** `ada` opens a turn and records the `send_message` tool call Claude would make before calling the tool. */
async function aCalls(toolUseId: string, input: object) {
  procOf("ada").emit(ev.turn(), {
    type: "tool_call",
    toolUseId,
    name: "mcp__factory__send_message",
    input,
  });
  await (await h.app.runtimes.bySlug("ada"))?.settled();
  return callTool(url, tokA, "send_message", input, toolUseId);
}

test("GET /api/inbox: newest first, link to the sender's send_message call, preview capped, human session only", async () => {
  await aCalls("toolu_01X", { to: "@humans", body: "first" });
  await callTool(url, tokA, "send_message", { to: "@or", body: "x".repeat(400), urgent: true });
  const r = await get("/api/inbox");
  expect(r.statusCode).toBe(200);
  const page = r.json();
  expect(page.items.map((i: { to: string }) => i.to)).toEqual(["@or", "@humans"]);
  expect(page.items[0]).toMatchObject({ urgent: true, from: { kind: "agent", name: "ada" } });
  expect(page.items[0].preview).toHaveLength(280);
  // No tool call recorded for the second send: the link names the sender's session only.
  expect(page.items[0].link).toEqual({ agentSlug: "ada" });
  expect(page.items[1].link).toEqual({ agentSlug: "ada", seq: expect.any(Number) });
  expect(page.nextCursor).toBeNull();
  expect((await get("/api/inbox", {})).statusCode).toBe(401);
});

test("GET /api/inbox pages with a cursor; a bad cursor or limit is a 400, not a 500", async () => {
  for (let i = 0; i < 3; i += 1)
    await callTool(url, tokA, "send_message", { to: "@or", body: `m${i}` });
  const p1 = (await get("/api/inbox?limit=2")).json();
  expect(p1.items.map((i: { preview: string }) => i.preview)).toEqual(["m2", "m1"]);
  const p2 = (await get(`/api/inbox?limit=2&before=${p1.nextCursor}`)).json();
  expect(p2.items.map((i: { preview: string }) => i.preview)).toEqual(["m0"]);
  expect(p2.nextCursor).toBeNull();

  const forged = (s: string) => Buffer.from(s).toString("base64url");
  for (const before of [
    "garbage",
    forged("not-a-date|x"),
    forged("2026-02-31T00:00:00.000000Z|x"),
    forged("1|x"),
  ]) {
    const bad = await get(`/api/inbox?before=${before}`);
    expect(bad.statusCode, before).toBe(400);
    expect(bad.json()).toMatchObject({
      error: { code: "validation_error", fields: { before: expect.any(String) } },
    });
  }
  for (const limit of ["0", "101", "x"]) {
    const bad = await get(`/api/inbox?limit=${limit}`);
    expect(bad.statusCode, limit).toBe(400);
    expect(bad.json().error.code).toBe("validation_error");
  }
});

test("GET /api/messages/:id: 404, pending without recipientEvent, delivered with both events", async () => {
  const missing = await get("/api/messages/nope");
  expect(missing.statusCode).toBe(404);
  expect(missing.json().error.code).toBe("message_not_found");

  const out = JSON.parse(
    (await aCalls("toolu_01Y", { to: "bob", body: "hello bob" })).content[0]?.text ?? "{}",
  );
  // The send woke the hibernated `bob`: its start job, settled, has written the batch, and no session has begun.
  const b = await h.app.runtimes.bySlug("bob");
  await b?.settled();
  expect(
    procOf("bob")
      .sent.flat()
      .map((m) => m.id),
  ).toEqual([out.id]);
  const before = (await get(`/api/messages/${out.id}`)).json();
  expect(before).toEqual({
    id: out.id,
    kind: "message",
    from: "ada",
    to: "bob",
    state: "pending",
    senderEvent: { agentSlug: "ada", seq: expect.any(Number) },
  });

  procOf("bob").emit(...ev.fullTurn("sess-b"));
  await b?.settled();
  const after = (await get(`/api/messages/${out.id}`)).json();
  expect(after).toMatchObject({
    state: "delivered",
    senderEvent: before.senderEvent,
    recipientEvent: { agentSlug: "bob", seq: expect.any(Number) },
  });
  expect((await get(`/api/messages/${out.id}`, {})).statusCode).toBe(401);
});

test("spec §5.1: a live agent token is refused by the inbox and message lookup routes", async () => {
  const out = JSON.parse(
    (await callTool(url, tokA, "send_message", { to: "@or", body: "for or" })).content[0]?.text ??
      "{}",
  );
  const bearer = { authorization: `Bearer ${tokA}` };
  for (const path of ["/api/inbox", `/api/messages/${out.id}`]) {
    const r = await get(path, bearer);
    expect(r.statusCode, path).toBe(401);
    expect(r.json()).toEqual({ error: { code: "unauthorized", message: "Not signed in" } });
  }
});
