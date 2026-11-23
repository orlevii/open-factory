import { randomUUID } from "node:crypto";
import { schema } from "@open-factory/db";
import type { ServerMessage } from "@open-factory/shared";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Tx } from "../agents/event-store.ts";
import { ev, FakeDriver } from "../agents/testing/fake-driver.ts";
import { callTool } from "../mcp/testing/mcp-client.ts";
import { claimTestHandle } from "../test/handles.ts";
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
    url: `/api/messages`,
    headers: { cookie },
    payload: { to: [slug], body: "hi" },
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
  const r = await callTool(
    url,
    tokA,
    "send_message",
    { to: ["@bob"], body: "ping" },
    "toolu_01ABC",
  );
  expect(r.isError).toBeFalsy();
  const out = JSON.parse(text(r)).results[0];
  expect(out).toMatchObject({
    to: "@bob",
    kind: "agent",
    status: "queued",
    recipient_status: "hibernated",
  });
  await settle("bob");
  expect(proc("bob")?.sent[0]?.[0]).toMatchObject({ from: "@ada", kind: "message", body: "ping" });
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
    const r = await callTool(url, tokA, "send_message", { to: [to], body: "x" });
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
  expect(await pendingOf("bob")).toEqual([]);
});

test("an agent id smuggled in the tool arguments is ignored: the caller is the token's agent", async () => {
  const tokA = await startIdle("ada");
  const lead = await h.app.store.agentBySlug("lead");
  const r = await callTool(url, tokA, "send_message", {
    to: ["bob"],
    body: "who am I",
    agentId: lead?.id,
    from: "lead",
  });
  const out = JSON.parse(text(r)).results[0];
  const a = await h.app.store.agentBySlug("ada");
  expect((await h.sql`select from_agent_id from messages where id = ${out.id}`)[0]).toEqual({
    from_agent_id: a?.id,
  });
});

test("an errored recipient: accepted and pending, no attempt, the note says so", async () => {
  await h.sql`update agents set status = 'errored', error_kind = 'crash', last_error = 'boom' where slug = 'bob'`;
  const tokA = await startIdle("ada");
  const out = JSON.parse(
    text(await callTool(url, tokA, "send_message", { to: ["bob"], body: "are you ok" })),
  ).results[0];
  expect(out).toMatchObject({
    to: "@bob",
    kind: "agent",
    status: "pending",
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
  await callTool(url, tokA, "send_message", { to: ["lead"], body: "stop!", urgent: true });
  await settle("lead");
  expect(proc("lead")?.controls).toContainEqual({ kind: "control", cmd: "interrupt" });
  const lead = await h.app.store.agentBySlug("lead");
  const events = (await h.app.store.after(lead?.id ?? "", 0, 200)).map((e) => e.event);
  expect(events).toContainEqual({ type: "control", cmd: "interrupt", by: "@ada" });
});

test("AC 5: a message to a person is one inbox item for them, delivered at once, with inbox_changed to them only", async () => {
  await signUp(h.app, { handle: "or" });
  await signUp(h.app, { handle: "sam" });
  const tokA = await startIdle("ada"); // signs up a third user, "hada"
  const one = JSON.parse(
    text(await callTool(url, tokA, "send_message", { to: ["or"], body: "just you" })),
  ).results[0];
  expect(one).toMatchObject({ to: "@or", kind: "human", status: "inbox" });
  expect(await h.sql`select user_id from inbox_items where message_id = ${one.id}`).toHaveLength(1);
  expect((await h.sql`select state from messages where id = ${one.id}`)[0]?.state).toBe(
    "delivered",
  );
});

test("`@humans` isn't a handle: refused with guidance, nothing is written", async () => {
  await signUp(h.app, { handle: "or" });
  const tokA = await startIdle("ada");
  const r = await callTool(url, tokA, "send_message", { to: ["@humans"], body: "need a decision" });
  expect(r.isError).toBe(true);
  expect(text(r)).toBe(
    "`@humans` isn't a handle. Message people by handle; list_peers lists them.",
  );
  expect(await h.sql`select id from inbox_items`).toEqual([]);
});

test("a row loaded by init() and handed over again is written once and still wakes the agent", async () => {
  const b = await h.app.store.agentBySlug("bob");
  const a = await h.app.store.agentBySlug("ada");
  if (!a || !b) throw new Error("seed");
  const row = await h.app.store.createMessage({
    from: { agentId: a.id },
    toAgentId: b.id,
    recipients: ["@test"],
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
  const sending = router.send({ agentId: a?.id ?? "" }, ["bob"], "after boot", false);
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

test("after close() no hand-off runs: rows committed during shutdown stay pending for the next boot", async () => {
  const router = new Router({
    db: h.db,
    store: h.app.store,
    runtimes: h.app.runtimes,
    bus: h.app.bus,
    log: h.app.log,
    neighborhood: h.app.neighborhood,
  });
  router.bootDone();
  router.close();
  const a = await h.app.store.agentBySlug("ada");
  const lead = await h.app.store.agentBySlug("lead");
  if (!a || !lead) throw new Error("seed");
  const delivered = vi.spyOn(h.app.runtimes, "deliver");
  const held = vi.spyOn(h.app.runtimes, "deliverHeld");
  const r = await router.send({ agentId: a.id }, ["bob"], "during shutdown", false);
  expect(r.results).toMatchObject([{ to: "@bob", status: "queued" }]);
  await router.forward({ agentId: a.id, body: "halfway" });
  await router.peerEvents(a.id, { kind: "joined" }, { managerId: null, peerIds: [] });
  // Let any `booted.then` hand-off run.
  await new Promise((r) => setImmediate(r));
  expect(delivered).not.toHaveBeenCalled();
  expect(held).not.toHaveBeenCalled();
  expect(proc("bob")).toBeUndefined();
  expect((await pendingOf("bob")).map((x) => x.state)).toEqual(["pending"]);
  expect(
    await h.sql`select state from messages where to_agent_id = ${lead.id} and kind = 'member_update'`,
  ).toEqual([{ state: "pending" }]);
});

test("an errored fact and its reported flag commit together: a failed flag write leaves no inbox item to re-report", async () => {
  await signUp(h.app, { handle: "or" });
  const lead = await h.app.store.agentBySlug("lead");
  if (!lead) throw new Error("seed");
  vi.spyOn(h.app.store, "setErroredReported").mockRejectedValueOnce(new Error("db blip"));
  const frames0 = frames.length;
  await expect(
    h.app.router.forward({ agentId: lead.id, fact: "errored", body: "@lead errored." }),
  ).rejects.toThrow("db blip");
  expect(
    await h.sql`select 1 from messages where notice = 'agent_errored' and subject_agent_id = ${lead.id}`,
  ).toHaveLength(0);
  expect(await h.sql`select 1 from inbox_items`).toHaveLength(0);
  expect(frames.slice(frames0).filter((f) => f.type === "inbox_changed")).toHaveLength(0);
  // The retry (the same episode, still unreported) reports it once.
  await h.app.router.forward({ agentId: lead.id, fact: "errored", body: "@lead errored." });
  expect(await h.sql`select 1 from inbox_items`).toHaveLength(1);
  expect((await h.sql`select errored_reported from agents where id = ${lead.id}`)[0]).toEqual({
    errored_reported: true,
  });
});

test("archive between resolve and hand-off marks the row rejected", async () => {
  const a = await h.app.store.agentBySlug("ada");
  const b = await h.app.store.agentBySlug("bob");
  if (!a || !b) throw new Error("seed");
  const row = await h.app.store.createMessage({
    from: { agentId: a.id },
    toAgentId: b.id,
    recipients: ["@test"],
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
    url: "/api/messages",
    headers: auth,
    payload: { to: ["bob"], body: "x" },
  });
  expect(send.statusCode).toBe(401);
  const list = await h.app.inject({ method: "GET", url: "/api/agents", headers: auth });
  expect(list.statusCode).toBe(401);
  const me = await h.app.inject({ method: "GET", url: "/api/me", headers: auth });
  expect(me.statusCode).toBe(401);
  expect(await pendingOf("bob")).toEqual([]);
});

test("the human REST send resolves only agents: each refused target is its own result", async () => {
  const { cookie } = await signUp(h.app, { handle: "orla" });
  const post = (slug: string) =>
    h.app.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie },
      payload: { to: [slug], body: "x" },
    });
  for (const slug of ["orla", "nobody", "humans", "factory"]) {
    const r = await post(slug);
    expect(r.statusCode).toBe(202);
    expect(r.json().results).toEqual([
      expect.objectContaining({ to: `@${slug}`, status: "refused", reason: expect.any(String) }),
    ]);
  }
  await h.app.agents.archive("bob");
  const r = await post("bob");
  expect(r.json().results).toEqual([
    { to: "@bob", status: "refused", reason: "@bob is archived and can't receive messages." },
  ]);
  expect(await pendingOf("bob")).toEqual([]);
  expect(await h.sql`select id from inbox_items`).toEqual([]);
});

test("AC 4: list_peers returns relations, scope all, and the humans every time", async () => {
  await signUp(h.app, { handle: "or", name: "Or" });
  const ops = await h.seedAgent({ slug: "ops" }); // top-level, a peer of lead
  const tokA = await startIdle("ada");
  const near = JSON.parse(text(await callTool(url, tokA, "list_peers", {})));
  const agentsOf = (r: { peers: { kind: string; handle: string; relation?: string }[] }) =>
    r.peers.filter((x) => x.kind === "agent");
  expect(agentsOf(near).map((x) => [x.handle, x.relation])).toEqual([
    ["@lead", "manager"],
    ["@bob", "peer"],
  ]);
  expect(near.peers).toContainEqual({ handle: "@or", kind: "human", name: "Or" });
  expect(JSON.stringify(near)).not.toContain("@example.com"); // never emails
  const all = JSON.parse(text(await callTool(url, tokA, "list_peers", { scope: "all" })));
  expect(all.peers).toContainEqual(
    expect.objectContaining({ handle: `@${ops.slug}`, relation: "other" }),
  );
  expect(all.peers.find((x: { handle: string }) => x.handle === "@ada")).toBeUndefined();
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
      url: "/api/messages",
      headers: { cookie },
      payload: { to: ["lead"], body: "are you there" },
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
  const r = await callTool(url, tokA, "send_message", { to: ["bob"], body: "still here" });
  expect(r.isError).toBeFalsy();
  expect(JSON.parse(text(r)).results[0]).toMatchObject({
    to: "@bob",
    status: "queued",
    recipient_status: "hibernated",
  });
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

test("R4 (owner): a restart that cuts short a human retry inside a reported episode adds no inbox item", async () => {
  await signUp(h.app, { handle: "or" });
  await startIdle("lead"); // a second user, "hlead"
  const lead = await h.app.store.agentBySlug("lead");
  if (!lead) throw new Error("seed");
  proc("lead")?.emit(ev.turn());
  proc("lead")?.exit(137);
  await settle("lead");
  proc("lead")?.exit(1); // the automatic attempt fails: the episode is reported
  await settle("lead");
  const errored = () =>
    h.sql`select 1 from messages where notice = 'agent_errored' and subject_agent_id = ${lead.id}`;
  expect(await errored()).toHaveLength(1);
  expect((await h.sql`select errored_reported from agents where id = ${lead.id}`)[0]).toEqual({
    errored_reported: true,
  });
  // A human retry was under way when the factory stopped: boot finds it cut short.
  await h.sql`update agents set attempting = true where id = ${lead.id}`;
  await h.app.close();
  await h.reopen({ harnessDriver: new FakeDriver(), env: { FACTORY_AGENT_PORT: "0" } });
  expect(await errored()).toHaveLength(1);
  expect(await h.sql`select 1 from inbox_items`).toHaveLength(2);
});

test("errored_reported clears with the error, so the next episode is reported", async () => {
  await startIdle("lead");
  const lead = await h.app.store.agentBySlug("lead");
  if (!lead) throw new Error("seed");
  proc("lead")?.emit(ev.turn());
  proc("lead")?.exit(137);
  await settle("lead");
  proc("lead")?.exit(1);
  await settle("lead");
  const { cookie } = await signUp(h.app, { handle: "sam" });
  await h.app.inject({
    method: "POST",
    url: "/api/messages",
    headers: { cookie },
    payload: { to: ["lead"], body: "retry" },
  });
  proc("lead")?.emit(ev.session("sess-lead"), ev.turn(), ev.usage(), ev.end());
  await settle("lead");
  expect((await h.sql`select errored_reported from agents where id = ${lead.id}`)[0]).toEqual({
    errored_reported: false,
  });
});

test("a message to a terminated agent is refused; a terminated sender can't send and writes nothing", async () => {
  const ada = await h.app.store.agentBySlug("ada");
  await h.sql`update agents set kind = 'ephemeral', terminated_at = now(), terminated_by = '@factory' where slug = 'bob'`;
  const toGone = await h.app.router.send({ agentId: ada?.id ?? "" }, ["bob"], "x", false);
  expect(toGone.results).toEqual([
    {
      to: "@bob",
      status: "refused",
      code: "terminated",
      reason: "@bob was terminated and can't receive messages.",
    },
  ]);
  await h.sql`update agents set kind = 'persistent', terminated_at = null, terminated_by = null where slug = 'bob'`;
  await h.sql`update agents set kind = 'ephemeral', terminated_at = now(), terminated_by = '@factory' where slug = 'ada'`;
  const fromEnded = await h.app.router.send({ agentId: ada?.id ?? "" }, ["bob"], "x", false);
  expect(fromEnded.results).toMatchObject([
    {
      status: "refused",
      code: "terminated",
      reason: "You can't send messages: you were terminated.",
    },
  ]);
  expect(await pendingOf("bob")).toEqual([]);
  expect(await h.sql`select id from inbox_items`).toEqual([]);
  // The refusal names each recipient once, as `@handle`, like the other paths.
  const repeated = await h.app.router.send(
    { agentId: ada?.id ?? "" },
    ["bob", "@bob", " @carol "],
    "x",
    false,
  );
  expect(repeated.results.map((r) => r.to)).toEqual(["@bob", "@carol"]);
});

/** A spawned child of `lead` inserted inside `tx` (it shares lead's credential). */
async function insertKid(tx: Tx, slug: string, o: { terminated?: boolean } = {}) {
  const lead = await h.app.store.agentBySlug("lead");
  if (!lead) throw new Error("no lead");
  await claimTestHandle(tx, slug, "agent");
  const [row] = await tx
    .insert(schema.agents)
    .values({
      id: randomUUID(),
      slug,
      displayName: "Kid",
      description: "",
      template: lead.template,
      config: lead.config,
      runtime: "local",
      credentialId: lead.credentialId,
      kind: "ephemeral",
      reportsTo: lead.id,
      ...(o.terminated ? { terminatedAt: new Date(), terminatedBy: "@factory" } : {}),
    })
    .returning();
  if (!row) throw new Error("insert failed");
  return row;
}
const heldRows = () =>
  h.sql`select a.slug as "to", m.kind, m.notice, m.body from messages m join agents a on a.id = m.to_agent_id
        where m.kind in ('peer_joined','peer_left') order by a.slug`;
const idOf = async (slug: string) => (await h.app.store.agentBySlug(slug))?.id ?? "";

test("persistPeerEvents runs in the caller's transaction: it sees a child inserted there, and its rows roll back with it", async () => {
  const rollback = new Error("rollback");
  let seen: { to: string | null; kind: string; notice: string | null; body: string }[] = [];
  await expect(
    h.db.transaction(async (tx) => {
      const kid = await insertKid(tx, "kid-ab12");
      const rows = await h.app.router.persistPeerEvents(
        tx,
        kid.id,
        { kind: "spawned" },
        { managerId: null, peerIds: [] },
      );
      seen = rows.map((r) => ({ to: r.toAgentId, kind: r.kind, notice: r.notice, body: r.body }));
      throw rollback;
    }),
  ).rejects.toBe(rollback);
  const [ada, bob, lead] = [await idOf("ada"), await idOf("bob"), await idOf("lead")];
  expect(seen).toEqual([
    { to: ada, kind: "peer_joined", notice: "peer", body: "@kid-ab12 (Kid) joined as your peer." },
    { to: bob, kind: "peer_joined", notice: "peer", body: "@kid-ab12 (Kid) joined as your peer." },
    {
      to: lead,
      kind: "peer_joined",
      notice: "report",
      body: "@kid-ab12 (Kid) joined as your report.",
    },
  ]);
  expect(await heldRows()).toEqual([]);
  expect(await h.app.store.agentBySlug("kid-ab12")).toBeUndefined();
});

test("persistPeerEvents: excludeManager skips the spawner; the rows commit with the caller and are handed off after", async () => {
  const deliverHeld = vi.spyOn(h.app.runtimes, "deliverHeld");
  const rows = await h.db.transaction(async (tx) => {
    const kid = await insertKid(tx, "kid-ab12");
    return h.app.router.persistPeerEvents(
      tx,
      kid.id,
      { kind: "spawned" },
      { managerId: null, peerIds: [] },
      { excludeManager: true },
    );
  });
  expect(deliverHeld).not.toHaveBeenCalled();
  expect((await heldRows()).map((r) => r.to)).toEqual(["ada", "bob"]);
  h.app.router.handOffHeldRows(rows);
  await vi.waitFor(() => expect(deliverHeld).toHaveBeenCalledTimes(2));
});

test("persistPeerEvents: archived and terminated recipients get nothing; the terminated body names who", async () => {
  await h.db.transaction((tx) => insertKid(tx, "gone-ab12", { terminated: true }));
  await h.sql`update agents set archived_at = now() where slug = 'bob'`;
  const [ada, bob, gone, lead] = [
    await idOf("ada"),
    await idOf("bob"),
    await idOf("gone-ab12"),
    await idOf("lead"),
  ];
  await h.db.transaction((tx) =>
    h.app.router.persistPeerEvents(
      tx,
      ada,
      { kind: "left", reason: "terminated", by: "@or" },
      { managerId: lead, peerIds: [bob, gone] },
    ),
  );
  expect(await heldRows()).toEqual([
    {
      to: "lead",
      kind: "peer_left",
      notice: "report",
      body: "@ada (Test agent) left: terminated by @or.",
    },
  ]);
});

test("Router.snapshot is S6's snapshot, read in the given transaction or the db", async () => {
  const [ada, bob, lead] = [await idOf("ada"), await idOf("bob"), await idOf("lead")];
  expect(await h.app.router.snapshot(h.db, ada)).toEqual({ managerId: lead, peerIds: [bob] });
  expect(await h.app.router.snapshot(h.db, lead)).toEqual({ managerId: null, peerIds: [] });
  const inTx = await h.db.transaction(async (tx) => {
    const kid = await insertKid(tx, "kid-ab12");
    return { snap: await h.app.router.snapshot(tx, ada), kid: kid.id };
  });
  expect(inTx.snap.managerId).toBe(lead);
  expect([...inTx.snap.peerIds].sort()).toEqual([bob, inTx.kid].sort());
});

test("deliver with a reason wakes with it: a spawned agent's first wake records process_started.reason spawned", async () => {
  const [ada, bob] = [await idOf("ada"), await idOf("bob")];
  const row = await h.app.store.createMessage({
    from: { agentId: ada },
    toAgentId: bob,
    recipients: ["@test"],
    body: "your brief",
    urgent: false,
  });
  await h.app.runtimes.deliver(row, "agent", "spawned");
  await settle("bob");
  const started = (await h.app.store.after(bob, 0, 100)).map((e) => e.event);
  expect(started).toContainEqual(
    expect.objectContaining({ type: "process_started", reason: "spawned" }),
  );
  expect(proc("bob")?.sent[0]?.[0]).toMatchObject({ from: "@ada", body: "your brief" });
});

describe("list sends: each recipient succeeds or fails alone (spec §4.4)", () => {
  const sendAs = async (slug: string, to: string[], body = "hello all") => {
    const a = await h.app.store.agentBySlug(slug);
    return h.app.router.send({ agentId: a?.id ?? "" }, to, body, false);
  };
  const rowsOf = (body: string) =>
    h.sql`select id, recipients, to_agent_id, to_user_id from messages where body = ${body} and kind = 'message' order by created_at, id`;

  test("duplicates collapse by principal: one row, one result", async () => {
    const r = await sendAs("ada", ["bob", "@bob", " bob "], "dup");
    expect(r.results).toHaveLength(1);
    expect(r.results[0]).toMatchObject({ to: "@bob", kind: "agent", status: "queued" });
    expect(await rowsOf("dup")).toHaveLength(1);
  });

  test("a self-send is refused alone; the others still get rows", async () => {
    const alone = await sendAs("ada", ["ada"], "me");
    expect(alone.results).toEqual([
      { to: "@ada", status: "refused", code: "self", reason: "You can't message yourself." },
    ]);
    const mixed = await sendAs("ada", ["ada", "bob"], "me-and-bob");
    expect(mixed.results.map((x) => x.status)).toEqual(["refused", "queued"]);
    const rows = await rowsOf("me-and-bob");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.recipients).toEqual(["@bob"]);
  });

  test("a terminated recipient is refused alone while the others get rows with the accepted list only", async () => {
    await signUp(h.app, { handle: "or" });
    await h.sql`update agents set kind = 'ephemeral', terminated_at = now(), terminated_by = '@factory' where slug = 'bob'`;
    const r = await sendAs("ada", ["or", "bob", "lead"], "partial");
    expect(r.results.map((x) => [x.to, x.status])).toEqual([
      ["@or", "inbox"],
      ["@bob", "refused"],
      ["@lead", "queued"],
    ]);
    expect(r.results[1]).toMatchObject({ code: "terminated" });
    const rows = await rowsOf("partial");
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.recipients).toEqual(["@or", "@lead"]);
    // The row order is the input order.
    expect(rows[0]?.to_user_id).not.toBeNull();
    expect(rows[1]?.to_agent_id).not.toBeNull();
  });

  test("all refused: nothing is written", async () => {
    const r = await sendAs("ada", ["ghost", "ada"], "none");
    expect(r.results.map((x) => (x.status === "refused" ? x.code : x.status))).toEqual([
      "not_found",
      "self",
    ]);
    expect(await rowsOf("none")).toEqual([]);
  });

  test("a channel and @humans are refused with their sentences", async () => {
    const r = await sendAs("ada", ["#ops", "@humans", "@me"], "x");
    expect(r.results).toEqual([
      { to: "#ops", status: "refused", code: "channel", reason: "Channels aren't supported yet." },
      {
        to: "@humans",
        status: "refused",
        code: "reserved",
        reason: "`@humans` isn't a handle. Message people by handle; list_peers lists them.",
      },
      {
        to: "@me",
        status: "refused",
        code: "reserved",
        reason: "'me' is reserved and can't receive messages.",
      },
    ]);
  });

  test("a disabled user is refused", async () => {
    await signUp(h.app, { handle: "gone" });
    await h.sql`update users set disabled_at = now() where handle = 'gone'`;
    const r = await sendAs("ada", ["gone"], "x");
    expect(r.results).toEqual([
      {
        to: "@gone",
        status: "refused",
        code: "disabled",
        reason: "@gone's account is disabled.",
      },
    ]);
  });

  test("a human sender can't address a human; agents still work", async () => {
    const { user } = await signUp(h.app, { handle: "orla" });
    await signUp(h.app, { handle: "sam" });
    const r = await h.app.router.send(
      { userId: user.id, handle: user.handle },
      ["sam", "bob"],
      "to-mixed",
      false,
    );
    expect(r.results.map((x) => x.status)).toEqual(["refused", "queued"]);
    expect(r.results[0]).toMatchObject({ code: "human" });
    expect((await rowsOf("to-mixed"))[0]?.recipients).toEqual(["@bob"]);
  });

  test("chat_changed goes to the human party of each row only", async () => {
    const or = await signUp(h.app, { handle: "or" });
    const sam = await signUp(h.app, { handle: "sam" });
    const got: Record<string, ServerMessage[]> = { or: [], sam: [] };
    h.app.bus.subscribeUser(or.user.id, (m) => got.or?.push(m));
    h.app.bus.subscribeUser(sam.user.id, (m) => got.sam?.push(m));
    await sendAs("ada", ["or"], "to-or");
    expect(got.or).toContainEqual({ type: "chat_changed", agent: "ada" });
    expect(got.sam).toEqual([]);
    got.or = [];
    await h.app.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: sam.cookie },
      payload: { to: ["bob"], body: "hi bob" },
    });
    expect(got.sam).toContainEqual({ type: "chat_changed", agent: "bob" });
    expect(got.or.filter((m) => m.type === "chat_changed")).toEqual([]);
  });

  test("one inbox item per human recipient; inbox_changed goes to those users only", async () => {
    const or = await signUp(h.app, { handle: "or" });
    const sam = await signUp(h.app, { handle: "sam" });
    const bystander = await signUp(h.app, { handle: "bystander" });
    const got: Record<string, ServerMessage[]> = { or: [], sam: [], bystander: [] };
    h.app.bus.subscribeUser(or.user.id, (m) => got.or?.push(m));
    h.app.bus.subscribeUser(sam.user.id, (m) => got.sam?.push(m));
    h.app.bus.subscribeUser(bystander.user.id, (m) => got.bystander?.push(m));
    frames.length = 0;
    const r = await sendAs("ada", ["or", "sam"], "two-humans");
    expect(r.results.map((x) => x.status)).toEqual(["inbox", "inbox"]);
    const ids = r.results.flatMap((x) => ("id" in x ? [x.id] : []));
    for (const id of ids)
      expect(await h.sql`select user_id from inbox_items where message_id = ${id}`).toHaveLength(1);
    expect(got.or).toContainEqual({ type: "inbox_changed" });
    expect(got.sam).toContainEqual({ type: "inbox_changed" });
    expect(got.bystander).toEqual([]);
    expect(frames).not.toContainEqual({ type: "inbox_changed" });
  });

  test("an errored agent recipient is pending with the note, beside a queued one", async () => {
    await h.sql`update agents set status = 'errored', error_kind = 'crash', last_error = 'boom' where slug = 'bob'`;
    const r = await sendAs("ada", ["bob", "lead"], "mixed-status");
    expect(r.results[0]).toMatchObject({
      to: "@bob",
      kind: "agent",
      status: "pending",
      note: "@bob is errored; your message will be delivered when a human restarts it.",
    });
    expect(r.results[1]).toMatchObject({ to: "@lead", status: "queued" });
  });

  test("a client-id retry returns every row's result and writes nothing twice", async () => {
    const { cookie, user } = await signUp(h.app, { handle: "orla" });
    const send = () =>
      h.app.router.send({ userId: user.id, handle: user.handle }, ["bob", "lead"], "twice", false, {
        clientMessageId: "11111111-1111-4111-8111-111111111111",
      });
    const first = await send();
    expect(first.results.map((x) => x.status)).toEqual(["queued", "queued"]);
    const again = await send();
    expect(again.results.map((x) => ("id" in x ? x.id : ""))).toEqual(
      first.results.map((x) => ("id" in x ? x.id : "")),
    );
    expect(again.results.map((x) => x.to)).toEqual(["@bob", "@lead"]);
    expect(await rowsOf("twice")).toHaveLength(2);
    void cookie;
  });

  test("attachments go to exactly one agent: with two recipients every target is refused", async () => {
    const { user } = await signUp(h.app, { handle: "orla" });
    const r = await h.app.router.send(
      { userId: user.id, handle: user.handle },
      ["bob", "lead"],
      "files",
      false,
      { attachments: ["00000000-0000-4000-8000-000000000000"] },
    );
    expect(r.results.map((x) => (x.status === "refused" ? x.code : x.status))).toEqual([
      "invalid_attachment",
      "invalid_attachment",
    ]);
    expect(await rowsOf("files")).toEqual([]);
  });

  test("attachments with a refused target: the refused one keeps its own reason", async () => {
    const { user } = await signUp(h.app, { handle: "orla" });
    const r = await h.app.router.send(
      { userId: user.id, handle: user.handle },
      ["ghost", "bob", "lead"],
      "files2",
      false,
      { attachments: ["00000000-0000-4000-8000-000000000000"] },
    );
    expect(r.results.map((x) => (x.status === "refused" ? x.code : x.status))).toEqual([
      "not_found",
      "invalid_attachment",
      "invalid_attachment",
    ]);
  });

  test("a hand-off that throws for one recipient is that recipient's start_failed, not the call's", async () => {
    const { user } = await signUp(h.app, { handle: "orla" });
    const real = h.app.runtimes.deliver.bind(h.app.runtimes);
    const spy = vi.spyOn(h.app.runtimes, "deliver").mockImplementation(async (row, ...rest) => {
      if (row.toAgentId === (await h.app.store.agentBySlug("bob"))?.id) throw new Error("boom");
      return real(row, ...rest);
    });
    try {
      const r = await h.app.router.send(
        { userId: user.id, handle: user.handle },
        ["bob", "lead"],
        "partial-fail",
        false,
      );
      expect(r.results.map((x) => x.status)).toEqual(["start_failed", "queued"]);
      expect(await rowsOf("partial-fail")).toHaveLength(2);
    } finally {
      spy.mockRestore();
    }
  });

  test("the human REST route answers 202 with one result per recipient", async () => {
    const { cookie } = await signUp(h.app, { handle: "orla" });
    const res = await h.app.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie },
      payload: { to: ["bob"], body: "shape" },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().results).toEqual([
      expect.objectContaining({
        to: "@bob",
        status: "queued",
        item: expect.objectContaining({ body: "shape" }),
      }),
    ]);
  });
});
