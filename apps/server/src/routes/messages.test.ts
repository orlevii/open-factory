import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { FakeDriver } from "../agents/testing/fake-driver.ts";
import { makeTestApp } from "../test/helpers.ts";

// I1 §6.6: POST /api/messages, a human's message to one to ten agents.

let s: Awaited<ReturnType<typeof makeTestApp>>;
let or: string;
let agentIds: Record<string, string>;
const drv = new FakeDriver();
beforeAll(async () => {
  s = await makeTestApp({ harnessDriver: drv });
  agentIds = {
    dev: (await s.seedAgent({ slug: "dev" })).id,
    ops: (await s.seedAgent({ slug: "ops" })).id,
    old: (await s.seedAgent({ slug: "old" })).id,
  };
  await s.sql`update agents set reports_to = ${agentIds.dev ?? null}, kind = 'ephemeral', terminated_at = now(), terminated_by = '@factory' where slug = 'old'`;
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
const rowsOf = (body: string) =>
  s.sql`select to_agent_id, recipients from messages where body = ${body} and kind = 'message' order by to_agent_id`;

test("two agent recipients make two rows, one per agent, with both recipients", async () => {
  const res = await post({ to: ["dev", "ops"], body: "both" });
  expect(res.statusCode).toBe(202);
  expect(res.json().results).toEqual([
    expect.objectContaining({
      to: "@dev",
      status: "queued",
      id: expect.any(String),
      item: expect.objectContaining({ body: "both" }),
    }),
    expect.objectContaining({
      to: "@ops",
      status: "queued",
      id: expect.any(String),
      item: expect.objectContaining({ body: "both" }),
    }),
  ]);
  const rows = await rowsOf("both");
  expect(rows.map((r) => r.to_agent_id).sort()).toEqual([agentIds.dev, agentIds.ops].sort());
  for (const r of rows) expect(r.recipients).toEqual(["@dev", "@ops"]);
});

test("a human recipient is refused", async () => {
  await s.signUpUser({ handle: "sam" });
  const res = await post({ to: ["sam"], body: "to a person" });
  expect(res.statusCode).toBe(202);
  expect(res.json().results).toEqual([
    {
      to: "@sam",
      status: "refused",
      reason: "@sam is a person; you can message agents only.",
      code: "human",
    },
  ]);
  expect(await rowsOf("to a person")).toEqual([]);
});

test("the human REST send resolves only agents: each refused target is its own result", async () => {
  const one = (slug: string) => post({ to: [slug], body: "only agents" });
  for (const slug of ["or", "nobody", "humans", "factory"]) {
    const r = await one(slug);
    expect(r.statusCode).toBe(202);
    expect(r.json().results).toEqual([
      expect.objectContaining({ to: `@${slug}`, status: "refused", reason: expect.any(String) }),
    ]);
  }
  await s.seedAgent({ slug: "shelved" });
  await s.app.agents.archive("shelved", { kind: "human", handle: "or" });
  expect((await one("shelved")).json().results).toEqual([
    {
      to: "@shelved",
      status: "refused",
      reason: "@shelved is archived and can't receive messages.",
      code: "archived",
    },
  ]);
  expect(await rowsOf("only agents")).toEqual([]);
});

test("attachments with two recipients are 422", async () => {
  const res = await post({ to: ["dev", "ops"], body: "files", attachments: ["u1"] });
  expect(res.statusCode).toBe(422);
  expect(res.json().error.code).toBe("invalid_attachment");
  expect(await rowsOf("files")).toEqual([]);
});

test("one refused recipient beside sent ones is a 202 with mixed results", async () => {
  const res = await post({ to: ["dev", "old", "nobody"], body: "mixed" });
  expect(res.statusCode).toBe(202);
  expect(res.json().results).toEqual([
    expect.objectContaining({ to: "@dev", status: "queued" }),
    expect.objectContaining({
      to: "@old",
      status: "refused",
      reason: expect.any(String),
      code: "terminated",
    }),
    expect.objectContaining({
      to: "@nobody",
      status: "refused",
      reason: expect.any(String),
      code: "not_found",
    }),
  ]);
  const rows = await rowsOf("mixed");
  expect(rows).toHaveLength(1);
  expect(rows[0]?.recipients).toEqual(["@dev"]);
});

test("a hand-off that throws for one recipient is that recipient's start_failed, not the call's", async () => {
  const real = s.app.runtimes.deliver.bind(s.app.runtimes);
  const spy = vi.spyOn(s.app.runtimes, "deliver").mockImplementation(async (row, ...rest) => {
    if (row.toAgentId === agentIds.dev) throw new Error("boom");
    return real(row, ...rest);
  });
  try {
    const res = await post({ to: ["dev", "ops"], body: "partial-fail" });
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
    await t2.seedAgent({ slug: "bad", config: { template: { secrets: ["GH_TOKEN"] } } });
    await t2.seedAgent({ slug: "fine" });
    const cookie = (await t2.signUpUser({ handle: "or2" })).cookie;
    const res = await t2.app.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie },
      payload: { to: ["bad", "fine"], body: "partly" },
    });
    expect(res.statusCode).toBe(202);
    const [bad, fine] = res.json().results;
    const reason = "Secret GH_TOKEN isn't set. Add it in Settings → Secrets.";
    expect(bad).toEqual({ to: "@bad", status: "start_failed", id: expect.any(String), reason });
    expect(fine).toMatchObject({ to: "@fine", status: "queued" });
    expect(
      (await t2.sql`select state from messages where id = ${bad.id}`).map((r) => r.state),
    ).toEqual(["pending"]);
    // The agent is errored with the fix text, and the message stays queued for when it recovers.
    const detail = (
      await t2.app.inject({ method: "GET", url: "/api/agents/bad", headers: { cookie } })
    ).json();
    expect(detail.queue.map((q: { body: string }) => q.body)).toEqual(["partly"]);
    expect(detail.agent).toMatchObject({ status: "errored", lastError: reason });
  } finally {
    await t2.close();
  }
});

test("a retry with the same clientMessageId publishes no chat_changed", async () => {
  const [u] = await s.sql`select id from users where handle = 'or'`;
  const frames: string[] = [];
  const off = s.app.bus.subscribeUser(u?.id as string, (m) => frames.push(m.type));
  const clientMessageId = randomUUID();
  await post({ to: ["ops"], body: "quiet retry", clientMessageId });
  await (await s.app.runtimes.bySlug("ops"))?.settled();
  const first = frames.filter((t) => t === "chat_changed").length;
  expect(first).toBeGreaterThan(0);
  await post({ to: ["ops"], body: "quiet retry", clientMessageId });
  await (await s.app.runtimes.bySlug("ops"))?.settled();
  expect(frames.filter((t) => t === "chat_changed")).toHaveLength(first);
  off();
});

test("a human session only: no auth and an agent token are 401", async () => {
  expect((await post({ to: ["dev"], body: "x" }, null)).statusCode).toBe(401);
  const { token } = s.app.agentTokens.mint(agentIds.dev as string);
  const res = await s.app.inject({
    method: "POST",
    url: "/api/messages",
    headers: { authorization: `Bearer ${token}` },
    payload: { to: ["dev"], body: "x" },
  });
  expect(res.statusCode).toBe(401);
});

test("validation: an empty or over-64-KB body, no recipients and eleven recipients are 400", async () => {
  expect((await post({ to: ["dev"], body: "  " })).statusCode).toBe(400);
  expect((await post({ to: ["dev"], body: "x".repeat(65_537) })).statusCode).toBe(400);
  expect((await post({ to: [], body: "x" })).statusCode).toBe(400);
  expect(
    (await post({ to: Array.from({ length: 11 }, (_, i) => `a${i}`), body: "x" })).statusCode,
  ).toBe(400);
});
