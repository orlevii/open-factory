import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { FakeDriver } from "../agents/testing/fake-driver.ts";
import { makeTestApp, runtimeOf } from "../test/helpers.ts";

// I1 §6.6: POST /api/messages, a human's message to one to ten agents.

let s: Awaited<ReturnType<typeof makeTestApp>>;
let or: string;
let agentIds: Record<string, string>;
const drv = new FakeDriver();
beforeAll(async () => {
  s = await makeTestApp({ harnessDriver: drv });
  agentIds = {
    dev: (await s.seedAgent({ handle: "dev" })).id,
    ops: (await s.seedAgent({ handle: "ops" })).id,
    old: (await s.seedAgent({ handle: "old" })).id,
  };
  await s.sql`update agents set reports_to = ${agentIds.dev ?? null}, kind = 'ephemeral', terminated_at = now(), terminated_by = null where id = (select id from principals where handle = 'old')`;
  or = (await s.signUpUser({ handle: "or" })).cookie;
});
afterAll(() => s.close());

const post = (payload: object, cookie: string | null = or) =>
  s.app.inject({
    method: "POST",
    url: "/api/messages",
    ...(cookie ? { headers: { cookie } } : {}),
    payload,
  });
/** The refs the web sends: an agent's, or a person's looked up by handle. */
const refOf = async (handle: string) =>
  String((await s.sql`select ref from principals where handle = ${handle}`)[0]?.ref);
const rowsOf = (body: string) =>
  s.sql`select to_id, recipient_ids from messages where body = ${body} and kind = 'message' order by to_id`;

test("two agent recipients make two rows, one per agent, with both recipients", async () => {
  const res = await post({ to: [s.seededRef("dev"), s.seededRef("ops")], body: "both" });
  expect(res.statusCode).toBe(202);
  expect(res.json().results).toEqual([
    expect.objectContaining({
      to: expect.stringMatching(/^<@[0-9a-z]{8}\|dev>$/),
      status: "queued",
      id: expect.any(String),
      item: expect.objectContaining({ body: "both" }),
    }),
    expect.objectContaining({
      to: expect.stringMatching(/^<@[0-9a-z]{8}\|ops>$/),
      status: "queued",
      id: expect.any(String),
      item: expect.objectContaining({ body: "both" }),
    }),
  ]);
  const rows = await rowsOf("both");
  expect(rows.map((r) => r.to_id).sort()).toEqual([agentIds.dev, agentIds.ops].sort());
  for (const r of rows) expect(r.recipient_ids).toEqual([agentIds.dev, agentIds.ops]);
});

test("a human recipient is refused", async () => {
  await s.signUpUser({ handle: "sam" });
  const res = await post({ to: [await refOf("sam")], body: "to a person" });
  expect(res.statusCode).toBe(202);
  expect(res.json().results).toEqual([
    {
      to: expect.stringMatching(/^<@[0-9a-z]{8}\|sam>$/),
      status: "refused",
      reason: "@sam is a person; you can message agents only.",
      code: "human",
    },
  ]);
  expect(await rowsOf("to a person")).toEqual([]);
});

test("the human REST send refuses a person and an archived agent, each as its own result", async () => {
  const one = (ref: string) => post({ to: [ref], body: "only agents" });
  const r = await one(await refOf("or"));
  expect(r.statusCode).toBe(202);
  expect(r.json().results).toEqual([
    expect.objectContaining({
      to: expect.stringMatching(/^<@[0-9a-z]{8}\|or>$/),
      status: "refused",
      code: "human",
    }),
  ]);
  await s.seedAgent({ handle: "shelved" });
  await s.app.agents.archive(await s.refOf("shelved"), {
    kind: "human",
    ref: "k7x2m9qd",
    handle: "or",
  });
  expect((await one(await refOf("shelved"))).json().results).toEqual([
    {
      to: expect.stringMatching(/^<@[0-9a-z]{8}\|shelved>$/),
      status: "refused",
      reason: "@shelved is archived and can't receive messages.",
      code: "archived",
    },
  ]);
  expect(await rowsOf("only agents")).toEqual([]);
});

test.each([
  ["a handle", "dev"],
  ["a mention", "<@zzzzzzzz|dev>"],
  ["a ref nobody holds", "zzzzzzzz"],
])("%s as a recipient is a 400 on `to` and nothing is sent", async (_name, to) => {
  const res = await post({ to: [s.seededRef("ops"), to], body: "bad recipient" });
  expect(res.statusCode).toBe(400);
  expect(res.json().error.fields).toEqual({ to: "No agent at this ref" });
  expect(await rowsOf("bad recipient")).toEqual([]);
});

test("attachments with two recipients are 422", async () => {
  const res = await post({
    to: [s.seededRef("dev"), s.seededRef("ops")],
    body: "files",
    attachments: ["u1"],
  });
  expect(res.statusCode).toBe(422);
  expect(res.json().error.code).toBe("invalid_attachment");
  expect(await rowsOf("files")).toEqual([]);
});

test("one refused recipient beside sent ones is a 202 with mixed results", async () => {
  const res = await post({ to: [s.seededRef("dev"), s.seededRef("old")], body: "mixed" });
  expect(res.statusCode).toBe(202);
  expect(res.json().results).toEqual([
    expect.objectContaining({
      to: expect.stringMatching(/^<@[0-9a-z]{8}\|dev>$/),
      status: "queued",
    }),
    expect.objectContaining({
      to: expect.stringMatching(/^<@[0-9a-z]{8}\|old>$/),
      status: "refused",
      reason: expect.any(String),
      code: "terminated",
    }),
  ]);
  const rows = await rowsOf("mixed");
  expect(rows).toHaveLength(1);
  expect(rows[0]?.recipient_ids).toEqual([agentIds.dev]);
});

test("a hand-off that throws for one recipient is that recipient's start_failed, not the call's", async () => {
  const real = s.app.runtimes.deliver.bind(s.app.runtimes);
  const spy = vi.spyOn(s.app.runtimes, "deliver").mockImplementation(async (row, ...rest) => {
    if (row.toId === agentIds.dev) throw new Error("boom");
    return real(row, ...rest);
  });
  try {
    const res = await post({ to: [s.seededRef("dev"), s.seededRef("ops")], body: "partial-fail" });
    expect(res.statusCode).toBe(202);
    expect(res.json().results.map((x: { status: string }) => x.status)).toEqual([
      "start_failed",
      "queued",
    ]);
    expect(await rowsOf("partial-fail")).toHaveLength(2);
  } finally {
    spy.mockRestore();
  }
});

test("start_failed keeps that recipient's row pending", async () => {
  const t2 = await makeTestApp({ harnessDriver: new FakeDriver() });
  try {
    await t2.seedAgent({ handle: "bad", config: { template: { secrets: ["GH_TOKEN"] } } });
    await t2.seedAgent({ handle: "fine" });
    const cookie = (await t2.signUpUser({ handle: "or2" })).cookie;
    const res = await t2.app.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie },
      payload: { to: [t2.seededRef("bad"), t2.seededRef("fine")], body: "partly" },
    });
    expect(res.statusCode).toBe(202);
    const [bad, fine] = res.json().results;
    const reason = "Secret GH_TOKEN isn't set. Add it in Settings → Secrets.";
    expect(bad).toEqual({
      to: expect.stringMatching(/^<@[0-9a-z]{8}\|bad>$/),
      status: "start_failed",
      id: expect.any(String),
      reason,
    });
    expect(fine).toMatchObject({
      to: expect.stringMatching(/^<@[0-9a-z]{8}\|fine>$/),
      status: "queued",
    });
    expect(
      (await t2.sql`select state from messages where id = ${bad.id}`).map((r) => r.state),
    ).toEqual(["pending"]);
    // The agent is errored with the fix text, and the message stays queued for when it recovers.
    const detail = (
      await t2.app.inject({
        method: "GET",
        url: `/api/agents/${await t2.refOf("bad")}`,
        headers: { cookie },
      })
    ).json();
    expect(detail.queue.map((q: { body: string }) => q.body)).toEqual(["partly"]);
    expect(detail.agent).toMatchObject({ status: "errored", lastError: reason });
  } finally {
    await t2.close();
  }
});

test("a retry with the same clientMessageId publishes no chat_changed", async () => {
  const [u] =
    await s.sql`select id from users where id = (select id from principals where handle = 'or')`;
  const frames: string[] = [];
  const off = s.app.bus.subscribeUser(u?.id as string, (m) => frames.push(m.type));
  const clientMessageId = randomUUID();
  await post({ to: [s.seededRef("ops")], body: "quiet retry", clientMessageId });
  await (await runtimeOf(s.app, "ops"))?.settled();
  const first = frames.filter((t) => t === "chat_changed").length;
  expect(first).toBeGreaterThan(0);
  await post({ to: [s.seededRef("ops")], body: "quiet retry", clientMessageId });
  await (await runtimeOf(s.app, "ops"))?.settled();
  expect(frames.filter((t) => t === "chat_changed")).toHaveLength(first);
  off();
});

test("a human session only: no auth and an agent token are 401", async () => {
  expect((await post({ to: [s.seededRef("dev")], body: "x" }, null)).statusCode).toBe(401);
  const { token } = s.app.agentTokens.mint(agentIds.dev as string);
  const res = await s.app.inject({
    method: "POST",
    url: "/api/messages",
    headers: { authorization: `Bearer ${token}` },
    payload: { to: [s.seededRef("dev")], body: "x" },
  });
  expect(res.statusCode).toBe(401);
});

test("validation: an empty or over-64-KB body, no recipients and eleven recipients are 400", async () => {
  expect((await post({ to: [s.seededRef("dev")], body: "  " })).statusCode).toBe(400);
  expect((await post({ to: [s.seededRef("dev")], body: "x".repeat(65_537) })).statusCode).toBe(400);
  expect((await post({ to: [], body: "x" })).statusCode).toBe(400);
  expect(
    (await post({ to: Array.from({ length: 11 }, (_, i) => `a${i}`), body: "x" })).statusCode,
  ).toBe(400);
});

test("a message with a mention reaches only its recipients", async () => {
  const [ops] = await s.sql`select ref from principals where handle = 'ops'`;
  const res = await post({ to: [s.seededRef("dev")], body: `ask <@${ops?.ref}> later` });
  expect(res.statusCode).toBe(202);
  const rows =
    await s.sql`select to_id, body from messages where kind = 'message' and body like 'ask <@%' `;
  expect(rows).toEqual([{ to_id: agentIds.dev, body: `ask <@${ops?.ref}> later` }]);
});

test("a body with an unknown ref is 400 and writes nothing", async () => {
  const res = await post({ to: [s.seededRef("dev")], body: "ask <@zzzzzzzz> later" });
  expect(res.statusCode).toBe(400);
  expect(res.json().error).toMatchObject({
    code: "unknown_mention",
    fields: { body: "This mention doesn't match anyone" },
  });
  expect(await s.sql`select id from messages where body like '%zzzzzzzz%'`).toEqual([]);
});
