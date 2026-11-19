import type { ServerMessage } from "@open-factory/shared";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ev, FakeDriver } from "../agents/testing/fake-driver.ts";
import { callTool } from "../mcp/testing/mcp-client.ts";
import { makeTestApp, signUp } from "../test/helpers.ts";
import { Router } from "./router.ts";

let h: Awaited<ReturnType<typeof makeTestApp>>;
let driver: FakeDriver;
let url: string;
const frames: ServerMessage[] = [];
beforeEach(async () => {
  driver = new FakeDriver();
  h = await makeTestApp({ harnessDriver: driver, env: { FACTORY_AGENT_PORT: "0" } });
  url = `http://127.0.0.1:${h.app.agentListener.port}`;
  frames.length = 0;
  h.app.bus.subscribeAll((m) => frames.push(m));
  const lead = await h.seedAgent({ slug: "lead" });
  for (const slug of ["ada", "bob"]) {
    const r = await h.seedAgent({ slug });
    await h.sql`update agents set reports_to = ${lead.id} where id = ${r.id}`;
  }
});
afterEach(() => h.close());

const proc = (slug: string) => driver.starts.filter((p) => p.spec.slug === slug).at(-1);
const settle = async (...slugs: string[]) => {
  for (const s of slugs) await (await h.app.runtimes.bySlug(s))?.settled();
};
/** Starts `slug` with a human message and returns its live token. */
async function startIdle(slug: string) {
  const { cookie } = await signUp(h.app, { handle: `h${slug}` });
  const res = await h.app.inject({
    method: "POST",
    url: `/api/agents/${slug}/messages`,
    headers: { cookie },
    payload: { body: "hi" },
  });
  const p = proc(slug);
  if (!p) throw new Error(`${slug} not started: ${res.statusCode} ${res.body}`);
  p.emit(...ev.fullTurn(`sess-${slug}`));
  await settle(slug);
  return p.spec.env.OPEN_FACTORY_AGENT_TOKEN as string;
}
const text = (r: { content: { text: string }[] }) => r.content[0]?.text ?? "";
const pendingOf = (slug: string) =>
  h.sql`select m.id, m.state from messages m join agents a on a.id = m.to_agent_id where a.slug = ${slug} and m.kind = 'message' order by m.created_at`;

test("AC 1: send_message to a hibernated agent wakes it with agent_message; the result names its status; the tool-use id is stored", async () => {
  const tokA = await startIdle("ada");
  const r = await callTool(url, tokA, "send_message", { to: "@bob", body: "ping" }, "toolu_01ABC");
  expect(r.isError).toBeFalsy();
  const out = JSON.parse(text(r));
  expect(out).toMatchObject({ to: "bob", status: "hibernated" });
  await settle("bob");
  expect(proc("bob")?.sent[0]?.[0]).toMatchObject({ from: "ada", kind: "message", body: "ping" });
  const b = await h.app.store.agentBySlug("bob");
  const started = (await h.app.store.after(b?.id ?? "", 0, 100)).map((e) => e.event);
  expect(started).toContainEqual(
    expect.objectContaining({ type: "process_started", reason: "agent_message" }),
  );
  expect(
    (await h.sql`select from_tool_use_id from messages where id = ${out.id}`)[0]?.from_tool_use_id,
  ).toBe("toolu_01ABC");
});

test("rejections are tool errors with one sentence", async () => {
  const tokA = await startIdle("ada");
  const err = async (to: string) => {
    const r = await callTool(url, tokA, "send_message", { to, body: "x" });
    expect(r.isError).toBe(true);
    return text(r);
  };
  expect(await err("nobody")).toBe(
    "No agent or user named 'nobody'. Call list_peers to see who you can message.",
  );
  expect(await err("ada")).toBe("You can't message yourself.");
  expect(await err("@me")).toBe("'me' is reserved and can't receive messages.");
  await h.app.agents.archive("bob");
  expect(await err("bob")).toBe("@bob is archived and can't receive messages.");
  // A name both an agent and a user hold (only a race can make one) is refused, never guessed.
  await h.sql`insert into users (id, name, email, handle) values ('dup', 'Dup', 'dup@x.io', 'lead')`;
  expect(await err("lead")).toBe(
    "'lead' matches both an agent and a user; ask a human to rename one.",
  );
  expect(await pendingOf("bob")).toEqual([]);
});

test("an agent id smuggled in the tool arguments is ignored: the caller is the token's agent", async () => {
  const tokA = await startIdle("ada");
  const lead = await h.app.store.agentBySlug("lead");
  const r = await callTool(url, tokA, "send_message", {
    to: "bob",
    body: "who am I",
    agentId: lead?.id,
    from: "lead",
  });
  const out = JSON.parse(text(r));
  const a = await h.app.store.agentBySlug("ada");
  expect((await h.sql`select from_agent_id from messages where id = ${out.id}`)[0]).toEqual({
    from_agent_id: a?.id,
  });
});

test("an errored recipient: accepted and pending, no attempt, the note says so", async () => {
  await h.sql`update agents set status = 'errored', error_kind = 'crash', last_error = 'boom' where slug = 'bob'`;
  const tokA = await startIdle("ada");
  const out = JSON.parse(
    text(await callTool(url, tokA, "send_message", { to: "bob", body: "are you ok" })),
  );
  expect(out).toMatchObject({
    status: "errored",
    note: "@bob is errored; your message will be delivered when a human restarts it.",
  });
  await settle("bob");
  expect(proc("bob")).toBeUndefined();
  expect((await pendingOf("bob")).map((r) => r.state)).toEqual(["pending"]);
  expect((await h.sql`select attempting from agents where slug = 'bob'`)[0]?.attempting).toBe(
    false,
  );
});

test("AC 3: an urgent message from an agent interrupts a working recipient", async () => {
  const tokA = await startIdle("ada");
  await startIdle("lead");
  proc("lead")?.emit(ev.turn());
  await settle("lead");
  await callTool(url, tokA, "send_message", { to: "lead", body: "stop!", urgent: true });
  await settle("lead");
  expect(proc("lead")?.controls).toContainEqual({ kind: "control", cmd: "interrupt" });
  const lead = await h.app.store.agentBySlug("lead");
  const events = (await h.app.store.after(lead?.id ?? "", 0, 200)).map((e) => e.event);
  expect(events).toContainEqual({ type: "control", cmd: "interrupt", by: "@ada" });
});

test("AC 5: @humans → one inbox item per existing user, delivered at once, and an inbox_changed frame", async () => {
  await signUp(h.app, { handle: "or" });
  await signUp(h.app, { handle: "sam" });
  const tokA = await startIdle("ada"); // signs up a third user, "hada"
  const out = JSON.parse(
    text(await callTool(url, tokA, "send_message", { to: "@humans", body: "need a decision" })),
  );
  expect(out).toMatchObject({ to: "@humans", status: "inbox" });
  const items = await h.sql`select user_id from inbox_items where message_id = ${out.id}`;
  expect(items).toHaveLength(3);
  expect((await h.sql`select state from messages where id = ${out.id}`)[0]?.state).toBe(
    "delivered",
  );
  expect(frames).toContainEqual({ type: "inbox_changed" });
  const one = JSON.parse(
    text(await callTool(url, tokA, "send_message", { to: "or", body: "just you" })),
  );
  expect(one).toMatchObject({ to: "@or", status: "inbox" });
  expect(await h.sql`select user_id from inbox_items where message_id = ${one.id}`).toHaveLength(1);
});

test("a row loaded by init() and handed over again is written once and still wakes the agent", async () => {
  const b = await h.app.store.agentBySlug("bob");
  const a = await h.app.store.agentBySlug("ada");
  if (!a || !b) throw new Error("seed");
  const row = await h.app.store.createMessage({
    from: { agentId: a.id },
    toAgentId: b.id,
    body: "once",
    urgent: false,
  });
  await h.app.runtimes.deliver(row, "agent"); // b isn't loaded: load → init() sees the row, deliver sees it again
  await settle("bob");
  const sent = proc("bob")?.sent.flat() ?? [];
  expect(sent.filter((m) => m.ids?.includes(row.id) || m.id === row.id)).toHaveLength(1);
});

test("hand-offs wait for bootDone", async () => {
  const router = new Router({
    db: h.db,
    store: h.app.store,
    runtimes: h.app.runtimes,
    bus: h.app.bus,
    log: h.app.log,
    neighborhood: h.app.neighborhood,
  });
  const a = await h.app.store.agentBySlug("ada");
  const create = h.app.store.createMessage.bind(h.app.store);
  let committed!: () => void;
  const commit = new Promise<void>((r) => {
    committed = r;
  });
  vi.spyOn(h.app.store, "createMessage").mockImplementation(async (...args) => {
    const row = await create(...args);
    committed();
    return row;
  });
  const handed = vi.spyOn(h.app.runtimes, "deliver");
  const sending = router.send({ agentId: a?.id ?? "" }, "bob", "after boot", false);
  // The row is committed; once every microtask after it has run, the hand-off is still waiting on the gate.
  await commit;
  await new Promise((r) => setImmediate(r));
  expect(handed).not.toHaveBeenCalled();
  expect(proc("bob")).toBeUndefined();
  router.bootDone();
  await sending;
  await settle("bob");
  expect(handed).toHaveBeenCalledTimes(1);
  expect(proc("bob")?.sent[0]?.[0]?.body).toBe("after boot");
});

test("archive between resolve and hand-off marks the row rejected", async () => {
  const a = await h.app.store.agentBySlug("ada");
  const b = await h.app.store.agentBySlug("bob");
  if (!a || !b) throw new Error("seed");
  const row = await h.app.store.createMessage({
    from: { agentId: a.id },
    toAgentId: b.id,
    body: "late",
    urgent: false,
  });
  await h.app.agents.archive("bob");
  await h.app.runtimes.deliver(row, "agent");
  await settle("bob");
  expect((await h.sql`select state from messages where id = ${row.id}`)[0]?.state).toBe("rejected");
  expect(proc("bob")).toBeUndefined();
});

test("AC 6: a valid agent token on a REST route is 401", async () => {
  const tokA = await startIdle("ada");
  const auth = { authorization: `Bearer ${tokA}` };
  const send = await h.app.inject({
    method: "POST",
    url: "/api/agents/bob/messages",
    headers: auth,
    payload: { body: "x" },
  });
  expect(send.statusCode).toBe(401);
  const list = await h.app.inject({ method: "GET", url: "/api/agents", headers: auth });
  expect(list.statusCode).toBe(401);
  const me = await h.app.inject({ method: "GET", url: "/api/me", headers: auth });
  expect(me.statusCode).toBe(401);
  expect(await pendingOf("bob")).toEqual([]);
});

test("the human REST send resolves only agents: a user or an unknown name is 404, a reserved one 400; archived is 409", async () => {
  const { cookie } = await signUp(h.app, { handle: "orla" });
  const post = (slug: string) =>
    h.app.inject({
      method: "POST",
      url: `/api/agents/${slug}/messages`,
      headers: { cookie },
      payload: { body: "x" },
    });
  for (const slug of ["orla", "nobody"]) {
    const r = await post(slug);
    expect(r.statusCode).toBe(404);
    expect(r.json().error.code).toBe("agent_not_found");
  }
  // `humans` and the other reserved names never reach the Router: the slug parameter refuses them (S4).
  for (const slug of ["humans", "factory"]) expect((await post(slug)).statusCode).toBe(400);
  await h.app.agents.archive("bob");
  const r = await post("bob");
  expect(r.statusCode).toBe(409);
  expect(r.json().error.code).toBe("agent_archived");
  expect(await pendingOf("bob")).toEqual([]);
  expect(await h.sql`select id from inbox_items`).toEqual([]);
});

test("AC 4: list_peers returns relations, scope all, and the humans every time", async () => {
  await signUp(h.app, { handle: "or", name: "Or" });
  const ops = await h.seedAgent({ slug: "ops" }); // top-level, a peer of lead
  const tokA = await startIdle("ada");
  const near = JSON.parse(text(await callTool(url, tokA, "list_peers", {})));
  expect(near.agents.map((x: { slug: string; relation: string }) => [x.slug, x.relation])).toEqual([
    ["lead", "manager"],
    ["bob", "peer"],
  ]);
  expect(near.humans).toEqual(expect.arrayContaining([{ handle: "or", name: "Or" }]));
  expect(JSON.stringify(near)).not.toContain("@example.com"); // never emails
  const all = JSON.parse(text(await callTool(url, tokA, "list_peers", { scope: "all" })));
  expect(all.agents).toContainEqual(expect.objectContaining({ slug: ops.slug, relation: "other" }));
  expect(all.agents.find((x: { slug: string }) => x.slug === "ada")).toBeUndefined();
});

test("Router.forward: a report's text goes to its manager as a held member_update; a top-level agent's errored goes to the humans once", async () => {
  await signUp(h.app, { handle: "or" });
  const a = await h.app.store.agentBySlug("ada");
  const lead = await h.app.store.agentBySlug("lead");
  if (!a || !lead) throw new Error("seed");
  await h.app.router.forward({ agentId: a.id, body: "progress" });
  await h.app.router.forward({ agentId: a.id, fact: "denied", body: "Bash was denied for @ada." });
  const rows =
    await h.sql`select kind, from_agent_id, subject_agent_id, notice, body, state from messages where to_agent_id = ${lead.id} order by created_at`;
  expect(rows).toEqual([
    {
      kind: "member_update",
      from_agent_id: a.id,
      subject_agent_id: null,
      notice: null,
      body: "progress",
      state: "pending",
    },
    {
      kind: "member_update",
      from_agent_id: null,
      subject_agent_id: a.id,
      notice: "denied",
      body: "Bash was denied for @ada.",
      state: "pending",
    },
  ]);
  await h.app.router.forward({ agentId: lead.id, body: "top-level text" }); // stays in its session
  await h.app.router.forward({ agentId: lead.id, fact: "recovered", body: "@lead recovered." }); // R4: quiet
  await h.app.router.forward({
    agentId: lead.id,
    fact: "errored",
    body: "@lead is errored and needs a human.",
  });
  const toHumans =
    await h.sql`select kind, notice, subject_agent_id, from_agent_id, state from messages where to_all_humans`;
  expect(toHumans).toEqual([
    {
      kind: "system",
      notice: "agent_errored",
      subject_agent_id: lead.id,
      from_agent_id: null,
      state: "delivered",
    },
  ]);
  expect(await h.sql`select 1 from inbox_items`).toHaveLength(1);
  expect(frames).toContainEqual({ type: "inbox_changed" });
});

test("R4 (owner): a top-level agent's errored episode is one inbox item; a successful automatic recovery is none", async () => {
  await signUp(h.app, { handle: "or" });
  await startIdle("lead"); // signs up a second user, "hlead"
  const lead = await h.app.store.agentBySlug("lead");
  if (!lead) throw new Error("seed");
  const users = 2;
  const items = async () =>
    (
      await h.sql`select i.user_id from inbox_items i join messages m on m.id = i.message_id
                  where m.notice = 'agent_errored' and m.subject_agent_id = ${lead.id}`
    ).length;
  const crashMidTurn = async () => {
    proc("lead")?.emit(ev.turn());
    proc("lead")?.exit(137);
    await settle("lead");
  };
  const nextAttempt = async (starts: number) => {
    expect(driver.starts.filter((p) => p.spec.slug === "lead")).toHaveLength(starts);
    return proc("lead");
  };
  // 1. A crash whose automatic attempt succeeds: nothing reaches the humans.
  await crashMidTurn();
  (await nextAttempt(2))?.emit(ev.session("sess-lead"), ev.turn(), ev.usage(), ev.end());
  await settle("lead");
  expect(h.app.runtimes.statusOf(lead)).not.toBe("errored");
  expect(await items()).toBe(0);
  // 2. A crash whose automatic attempt fails: errored, one inbox item per human.
  await crashMidTurn();
  (await nextAttempt(3))?.exit(1);
  await settle("lead");
  expect(h.app.runtimes.statusOf(lead)).toBe("errored");
  expect(await items()).toBe(users);
  // 3. A human retry fails inside the same episode: nothing new.
  const { cookie } = await signUp(h.app, { handle: "sam" });
  const retry = () =>
    h.app.inject({
      method: "POST",
      url: "/api/agents/lead/messages",
      headers: { cookie },
      payload: { body: "are you there" },
    });
  await retry();
  (await nextAttempt(4))?.exit(1);
  await settle("lead");
  expect(await items()).toBe(users);
  // 4. A retry that succeeds ends the episode; the next errored episode is one more item per (now three) humans.
  await retry();
  (await nextAttempt(5))?.emit(ev.session("sess-lead"), ev.turn(), ev.usage(), ev.end());
  await settle("lead");
  expect(h.app.runtimes.statusOf(lead)).not.toBe("errored");
  await crashMidTurn();
  (await nextAttempt(6))?.exit(1);
  await settle("lead");
  expect(await items()).toBe(users + 3);
  expect(
    await h.sql`select 1 from messages where notice = 'agent_errored' and subject_agent_id = ${lead.id}`,
  ).toHaveLength(2);
});

test("a report's top-level text is persisted for its manager and handed over as a held row", async () => {
  await startIdle("lead");
  await startIdle("ada");
  const handed = vi.spyOn(h.app.runtimes, "deliverHeld");
  proc("ada")?.emit(ev.turn(), ev.text("halfway there"), ev.usage(), ev.end());
  await settle("ada", "lead");
  const lead = await h.app.store.agentBySlug("lead");
  const rows =
    await h.sql`select id, from_agent_id, body from messages where to_agent_id = ${lead?.id ?? ""} and kind = 'member_update'`;
  const ada = await h.app.store.agentBySlug("ada");
  expect(rows).toEqual([{ id: expect.any(String), from_agent_id: ada?.id, body: "halfway there" }]);
  expect(handed).toHaveBeenCalledTimes(1);
  expect(handed.mock.calls[0]?.[0]).toMatchObject({ id: rows[0]?.id, kind: "member_update" });
});

test("a recipient whose init fails after the commit doesn't fail the sender's call; the row stays pending", async () => {
  const tokA = await startIdle("ada");
  vi.spyOn(h.app.runtimes, "load").mockRejectedValue(new Error("init failed"));
  const r = await callTool(url, tokA, "send_message", { to: "bob", body: "still here" });
  expect(r.isError).toBeFalsy();
  expect(JSON.parse(text(r))).toMatchObject({ to: "bob", status: "hibernated" });
  expect((await pendingOf("bob")).map((x) => x.state)).toEqual(["pending"]);
});

test("deliverHeld never throws, even for a row with no agent recipient", () => {
  expect(() =>
    h.app.runtimes.deliverHeld({ id: "m1", toAgentId: null } as unknown as Parameters<
      typeof h.app.runtimes.deliverHeld
    >[0]),
  ).not.toThrow();
});

test("reconcile forwards factory_restarted lost work to the manager", async () => {
  const a = await h.app.store.agentBySlug("ada");
  const lead = await h.app.store.agentBySlug("lead");
  if (!a || !lead) throw new Error("seed");
  await h.app.store.setRuntimeJournal(a.id, {
    tasks: [{ taskId: "t1", description: "pnpm test" }],
    crons: [],
    takenAt: new Date().toISOString(),
  });
  await h.app.close();
  await h.reopen({ harnessDriver: new FakeDriver(), env: { FACTORY_AGENT_PORT: "0" } });
  const rows =
    await h.sql`select notice, subject_agent_id, body from messages where to_agent_id = ${lead.id} and kind = 'member_update'`;
  expect(rows).toEqual([
    {
      notice: "work_lost",
      subject_agent_id: a.id,
      body: "Background work of @ada was stopped. Reported by @ada:\n> pnpm test",
    },
  ]);
});
