import { randomUUID } from "node:crypto";
import { schema } from "@open-factory/db";
import type { ServerMessage } from "@open-factory/shared";
import { tagOf } from "@open-factory/shared/tags";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Tx } from "../agents/event-store.ts";
import { ev, FakeDriver } from "../agents/testing/fake-driver.ts";
import { callTool } from "../mcp/testing/mcp-client.ts";
import { createPrincipal } from "../principals/principal-store.ts";
import { agentRowOf, makeTestApp, runtimeOf, signUp } from "../test/helpers.ts";
import { testRef } from "../test/principals.ts";
import { LoopGuard } from "./loop-guard.ts";
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
  const lead = await h.seedAgent({ handle: "lead" });
  for (const handle of ["ada", "bob"]) {
    const r = await h.seedAgent({ handle });
    await h.sql`update agents set reports_to = ${lead.id} where id = ${r.id}`;
  }
});
afterEach(() => h.close());

const guardOf = () =>
  new LoopGuard({
    settings: h.app.factorySettings,
    store: h.app.store,
    bus: h.app.bus,
    runtimes: h.app.runtimes,
    log: h.app.log,
    clock: () => new Date(),
    newId: randomUUID,
  });
const proc = (handle: string) => driver.startsOf(handle).at(-1);
const settle = async (...handles: string[]) => {
  for (const s of handles) await (await runtimeOf(h.app, s))?.settled();
};
/** Starts `handle` with a human message and returns its live token. */
async function startIdle(handle: string) {
  const { cookie } = await signUp(h.app, { handle: `h${handle}` });
  const res = await h.app.inject({
    method: "POST",
    url: `/api/messages`,
    headers: { cookie },
    payload: { to: [h.seededRef(handle)], body: "hi" },
  });
  const p = proc(handle);
  if (!p) throw new Error(`${handle} not started: ${res.statusCode} ${res.body}`);
  p.emit(...ev.fullTurn(`sess-${handle}`));
  await settle(handle);
  return p.spec.env.OPEN_FACTORY_AGENT_TOKEN as string;
}
/** Results name principals by tag; most tests read them by `@handle` (one test below asserts the tag shape). */
const TAG_TEXT = /<@[0-9a-z]{8}\|([a-z0-9-]+)>/g;
const plain = <T>(x: T): T => JSON.parse(JSON.stringify(x).replace(TAG_TEXT, "@$1"));
const sendPlain = async (...a: Parameters<typeof h.app.router.send>) =>
  plain(await h.app.router.send(...a));
const rawText = (r: { content: { text: string }[] }) => r.content[0]?.text ?? "";
const text = (r: { content: { text: string }[] }) =>
  (r.content[0]?.text ?? "").replace(TAG_TEXT, "@$1");
const pendingOf = (handle: string) =>
  h.sql`select m.id, m.state from messages m join agents a on a.id = m.to_id where a.id = (select id from principals where handle = ${handle}) and m.kind = 'message' order by m.created_at`;

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
  expect(proc("bob")?.sent[0]?.[0]).toMatchObject({
    from: expect.stringMatching(/^<@[0-9a-z]{8}\|ada>$/),
    kind: "message",
    body: "ping",
  });
  const b = await agentRowOf(h.app, "bob");
  const started = (await h.app.store.after(b?.id ?? "", 0, 100)).map((e) => e.event);
  expect(started).toContainEqual(
    expect.objectContaining({ type: "process_started", reason: "agent_message" }),
  );
  expect(
    (await h.sql`select from_tool_use_id from messages where id = ${out.id}`)[0]?.from_tool_use_id,
  ).toBe("toolu_01ABC");
});

test("an agent id smuggled in the tool arguments is ignored: the caller is the token's agent", async () => {
  const tokA = await startIdle("ada");
  const lead = await agentRowOf(h.app, "lead");
  const r = await callTool(url, tokA, "send_message", {
    to: ["bob"],
    body: "who am I",
    agentId: lead?.id,
    from: "lead",
  });
  const out = JSON.parse(text(r)).results[0];
  const a = await agentRowOf(h.app, "ada");
  expect((await h.sql`select from_id from messages where id = ${out.id}`)[0]).toEqual({
    from_id: a?.id,
  });
});

test("an errored recipient: accepted and pending, no attempt, the note says so", async () => {
  await h.sql`update agents set status = 'errored', error_kind = 'crash', last_error = 'boom' where id = (select id from principals where handle = 'bob')`;
  const tokA = await startIdle("ada");
  const out = JSON.parse(
    text(await callTool(url, tokA, "send_message", { to: ["bob"], body: "are you ok" })),
  ).results[0];
  expect(out).toMatchObject({
    to: "@bob",
    kind: "agent",
    status: "pending",
    note: "@bob is errored; your message will be delivered after it is restarted (restart_agent, or a human).",
  });
  await settle("bob");
  expect(proc("bob")).toBeUndefined();
  expect((await pendingOf("bob")).map((r) => r.state)).toEqual(["pending"]);
  expect(
    (
      await h.sql`select attempting from agents where id = (select id from principals where handle = 'bob')`
    )[0]?.attempting,
  ).toBe(false);
});

test("AC 3: an urgent message from an agent interrupts a working recipient", async () => {
  const tokA = await startIdle("ada");
  await startIdle("lead");
  proc("lead")?.emit(ev.turn());
  await settle("lead");
  await callTool(url, tokA, "send_message", { to: ["lead"], body: "stop!", urgent: true });
  await settle("lead");
  expect(proc("lead")?.controls).toContainEqual({ kind: "control", cmd: "interrupt" });
  const lead = await agentRowOf(h.app, "lead");
  const events = (await h.app.store.after(lead?.id ?? "", 0, 200)).map((e) => e.event);
  const [ada] = await h.sql`select ref from principals where handle = 'ada'`;
  expect(events).toContainEqual({ type: "control", cmd: "interrupt", by: `<@${ada?.ref}>` });
});

test("a row loaded by init() and handed over again is written once and still wakes the agent", async () => {
  const b = await agentRowOf(h.app, "bob");
  const a = await agentRowOf(h.app, "ada");
  if (!a || !b) throw new Error("seed");
  const row = await h.app.store.createMessage({
    from: { agentId: a.id },
    toAgentId: b.id,
    recipientIds: [b.id],
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
    loopGuard: guardOf(),
  });
  const a = await agentRowOf(h.app, "ada");
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
    loopGuard: guardOf(),
  });
  router.bootDone();
  router.close();
  const a = await agentRowOf(h.app, "ada");
  const lead = await agentRowOf(h.app, "lead");
  if (!a || !lead) throw new Error("seed");
  const delivered = vi.spyOn(h.app.runtimes, "deliver");
  const held = vi.spyOn(h.app.runtimes, "receive");
  const r = plain(await router.send({ agentId: a.id }, ["bob"], "during shutdown", false));
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
    await h.sql`select state from messages where to_id = ${lead.id} and kind = 'member_update'`,
  ).toEqual([{ state: "pending" }]);
});

test("an errored fact and its reported flag commit together: a failed flag write leaves no inbox item to re-report", async () => {
  await signUp(h.app, { handle: "or" });
  const lead = await agentRowOf(h.app, "lead");
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
  const a = await agentRowOf(h.app, "ada");
  const b = await agentRowOf(h.app, "bob");
  if (!a || !b) throw new Error("seed");
  const row = await h.app.store.createMessage({
    from: { agentId: a.id },
    toAgentId: b.id,
    recipientIds: [b.id],
    body: "late",
    urgent: false,
  });
  await h.app.agents.archive(await h.refOf("bob"), {
    kind: "human",
    ref: "k7x2m9qd",
    handle: "or",
  });
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
    payload: { to: [h.seededRef("bob")], body: "x" },
  });
  expect(send.statusCode).toBe(401);
  const list = await h.app.inject({ method: "GET", url: "/api/agents", headers: auth });
  expect(list.statusCode).toBe(401);
  const me = await h.app.inject({ method: "GET", url: "/api/me", headers: auth });
  expect(me.statusCode).toBe(401);
  expect(await pendingOf("bob")).toEqual([]);
});

test("AC 4: list_peers returns relations, scope all, and the humans every time", async () => {
  await signUp(h.app, { handle: "or", name: "Or" });
  const ops = await h.seedAgent({ handle: "ops" }); // top-level, a peer of lead
  const tokA = await startIdle("ada");
  const near = JSON.parse(rawText(await callTool(url, tokA, "list_peers", {})));
  const agentsOf = (r: { peers: { kind: string; handle: string; relation?: string }[] }) =>
    r.peers.filter((x) => x.kind === "agent");
  expect(agentsOf(near).map((x) => [x.handle, x.relation])).toEqual([
    ["@lead", "manager"],
    ["@bob", "peer"],
  ]);
  expect(near.peers).toContainEqual({
    handle: "@or",
    tag: expect.stringMatching(/^<@[0-9a-z]{8}\|or>$/),
    kind: "human",
    name: "Or",
  });
  expect(JSON.stringify(near)).not.toContain("@example.com"); // never emails
  const all = JSON.parse(rawText(await callTool(url, tokA, "list_peers", { scope: "all" })));
  expect(all.peers).toContainEqual(
    expect.objectContaining({ handle: `@${ops.handle}`, relation: "other" }),
  );
  expect(all.peers.find((x: { handle: string }) => x.handle === "@ada")).toBeUndefined();
});

test("Router.forward: a report's text and facts go to its manager agent as member_updates", async () => {
  const a = await agentRowOf(h.app, "ada");
  const lead = await agentRowOf(h.app, "lead");
  if (!a || !lead) throw new Error("seed");
  await h.app.router.forward({ agentId: a.id, body: "progress" });
  await h.app.router.forward({ agentId: a.id, fact: "denied", body: "Bash was denied for @ada." });
  await h.app.router.forward({ agentId: a.id, fact: "errored", body: "@ada is errored." });
  const rows =
    await h.sql`select kind, from_id, subject_agent_id, notice, body, state from messages where to_id = ${lead.id} order by created_at`;
  expect(rows.map((r) => [r.kind, r.from_id === a.id, r.notice, r.body, r.state])).toEqual([
    ["member_update", true, null, "progress", "pending"],
    ["member_update", false, "denied", "Bash was denied for @ada.", "pending"],
    ["member_update", false, "errored", "@ada is errored.", "pending"],
  ]);
  // A manager agent's report never reaches a human's inbox, errored or not.
  expect(await h.sql`select 1 from inbox_items`).toHaveLength(0);
});

test("Router.forward: a human manager gets their report's text and facts in their own inbox only, and an errored episode as one notice for them alone", async () => {
  const or = await signUp(h.app, { handle: "or" });
  const sam = await signUp(h.app, { handle: "sam" });
  const lead = await agentRowOf(h.app, "lead");
  if (!lead) throw new Error("seed");
  await h.sql`update agents set reports_to = ${or.user.id} where id = ${lead.id}`;
  const seen = { or: [] as ServerMessage[], sam: [] as ServerMessage[] };
  h.app.bus.subscribeUser(or.user.id, (m) => seen.or.push(m));
  h.app.bus.subscribeUser(sam.user.id, (m) => seen.sam.push(m));
  const inboxOf = (userId: string) =>
    h.sql`select i.kind as inbox_kind, m.kind, m.notice, m.from_id, m.subject_agent_id, m.to_id, m.to_all_humans
          from inbox_items i join messages m on m.id = i.message_id where i.user_id = ${userId} order by m.created_at`;

  await h.app.router.forward({ agentId: lead.id, body: "top-level text" });
  await h.app.router.forward({ agentId: lead.id, fact: "recovered", body: "@lead recovered." });
  expect(await inboxOf(or.user.id)).toEqual([
    {
      inbox_kind: "member_update",
      kind: "member_update",
      notice: null,
      from_id: lead.id,
      subject_agent_id: null,
      to_id: or.user.id,
      to_all_humans: false,
    },
    {
      inbox_kind: "member_update",
      kind: "member_update",
      notice: "recovered",
      from_id: null,
      subject_agent_id: lead.id,
      to_id: or.user.id,
      to_all_humans: false,
    },
  ]);
  await h.app.router.forward({
    agentId: lead.id,
    fact: "errored",
    body: "@lead is errored and needs a human.",
  });
  expect(await inboxOf(or.user.id)).toHaveLength(3);
  expect(await inboxOf(or.user.id)).toContainEqual(
    expect.objectContaining({
      inbox_kind: "message",
      kind: "system",
      notice: "agent_errored",
      subject_agent_id: lead.id,
      to_all_humans: false,
    }),
  );
  // Nobody else hears of it: not the other human, not the seeded fixture user.
  expect(await inboxOf(sam.user.id)).toEqual([]);
  expect(await h.sql`select 1 from inbox_items`).toHaveLength(3);
  expect(await h.sql`select 1 from messages where to_all_humans`).toHaveLength(0);
  expect(seen.or.filter((m) => m.type === "inbox_changed")).toHaveLength(3);
  expect(seen.sam).toEqual([]);
});

test("R4 (owner): a human-managed agent's errored episode is one inbox item for its manager; a successful automatic recovery is none", async () => {
  const or = await signUp(h.app, { handle: "or" });
  await startIdle("lead"); // signs up a second user, "hlead"
  const lead = await agentRowOf(h.app, "lead");
  if (!lead) throw new Error("seed");
  await h.sql`update agents set reports_to = ${or.user.id} where id = ${lead.id}`;
  const items = async () =>
    (
      await h.sql`select i.user_id from inbox_items i join messages m on m.id = i.message_id
                  where m.notice = 'agent_errored' and m.subject_agent_id = ${lead.id} and i.user_id = ${or.user.id}`
    ).length;
  const everyones = async () =>
    (
      await h.sql`select 1 from inbox_items i join messages m on m.id = i.message_id
                  where m.notice = 'agent_errored' and m.subject_agent_id = ${lead.id}`
    ).length;
  const crashMidTurn = async () => {
    proc("lead")?.emit(ev.turn());
    proc("lead")?.exit(137);
    await settle("lead");
  };
  const nextAttempt = async (starts: number) => {
    expect(driver.startsOf("lead")).toHaveLength(starts);
    return proc("lead");
  };
  // 1. A crash whose automatic attempt succeeds: nothing reaches the manager's inbox as an errored notice.
  await crashMidTurn();
  (await nextAttempt(2))?.emit(ev.session("sess-lead"), ev.turn(), ev.usage(), ev.end());
  await settle("lead");
  expect(h.app.runtimes.statusOf(lead)).not.toBe("errored");
  expect(await items()).toBe(0);
  // 2. A crash whose automatic attempt fails: errored, one inbox item, for the manager only.
  await crashMidTurn();
  (await nextAttempt(3))?.exit(1);
  await settle("lead");
  expect(h.app.runtimes.statusOf(lead)).toBe("errored");
  expect(await items()).toBe(1);
  expect(await everyones()).toBe(1);
  // 3. A human retry fails inside the same episode: nothing new.
  const { cookie } = await signUp(h.app, { handle: "sam" });
  const retry = () =>
    h.app.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie },
      payload: { to: [h.seededRef("lead")], body: "are you there" },
    });
  await retry();
  (await nextAttempt(4))?.exit(1);
  await settle("lead");
  expect(await items()).toBe(1);
  // 4. A retry that succeeds ends the episode; the next errored episode is one more item.
  await retry();
  (await nextAttempt(5))?.emit(ev.session("sess-lead"), ev.turn(), ev.usage(), ev.end());
  await settle("lead");
  expect(h.app.runtimes.statusOf(lead)).not.toBe("errored");
  await crashMidTurn();
  (await nextAttempt(6))?.exit(1);
  await settle("lead");
  expect(await items()).toBe(2);
  expect(await everyones()).toBe(2);
});

test("a report's top-level text is persisted for its manager and handed over to its runtime", async () => {
  await startIdle("lead");
  await startIdle("ada");
  const handed = vi.spyOn(h.app.runtimes, "receive");
  proc("ada")?.emit(ev.turn(), ev.text("halfway there"), ev.usage(), ev.end());
  await settle("ada", "lead");
  const lead = await agentRowOf(h.app, "lead");
  const rows =
    await h.sql`select id, from_id, body from messages where to_id = ${lead?.id ?? ""} and kind = 'member_update'`;
  const ada = await agentRowOf(h.app, "ada");
  expect(rows).toEqual([{ id: expect.any(String), from_id: ada?.id, body: "halfway there" }]);
  expect(handed).toHaveBeenCalledTimes(1);
  expect(handed.mock.calls[0]?.[0]).toMatchObject({ id: rows[0]?.id, kind: "member_update" });
});

test("a member update's re stores the sender's tag: a report's text to a human manager keeps the request it answers on the inbox row", async () => {
  const { user: manager } = await signUp(h.app, { handle: "boss" });
  const ada = await agentRowOf(h.app, "ada");
  await h.sql`update agents set reports_to = ${manager.id} where id = ${ada?.id ?? ""}`;
  const { cookie } = await signUp(h.app, { handle: "asker" });
  await h.app.inject({
    method: "POST",
    url: "/api/messages",
    headers: { cookie },
    payload: { to: [h.seededRef("ada")], body: "update the README" },
  });
  const [asked] = await h.sql<{ id: string }[]>`
    select id from messages where to_id = ${ada?.id ?? ""} and kind = 'message'`;
  proc("ada")?.emit(ev.session(), ev.turn(), ev.text("README updated"), ev.usage(), ev.end());
  await settle("ada");
  const rows = await h.sql`
    select body, re from messages where to_id = ${manager.id} and kind = 'member_update'`;
  const [asker] = await h.sql<{ ref: string }[]>`select ref from principals where handle = 'asker'`;
  expect(rows).toEqual([
    { body: "README updated", re: [{ id: asked?.id, from: `<@${asker?.ref}>` }] },
  ]);
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

test("receive: a recipient that fails to load is logged, never thrown or unhandled", async () => {
  const error = vi.spyOn(h.app.log, "error").mockImplementation(() => undefined);
  vi.spyOn(h.app.runtimes, "load").mockRejectedValue(new Error("load failed"));
  const unhandled = vi.fn();
  process.on("unhandledRejection", unhandled);
  try {
    const row = { id: "m1", toId: "ag1" } as unknown as Parameters<
      typeof h.app.runtimes.receive
    >[0];
    expect(() => h.app.runtimes.receive(row)).not.toThrow();
    await vi.waitFor(() =>
      expect(error).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: "ag1", message: "m1" }),
        "handing over a member update or peer event failed",
      ),
    );
    await new Promise((r) => setImmediate(r));
    expect(unhandled).not.toHaveBeenCalled();
  } finally {
    process.off("unhandledRejection", unhandled);
    vi.restoreAllMocks();
  }
});

test("reconcile forwards factory_restarted lost work to the manager", async () => {
  const a = await agentRowOf(h.app, "ada");
  const lead = await agentRowOf(h.app, "lead");
  if (!a || !lead) throw new Error("seed");
  await h.app.store.setRuntimeJournal(a.id, {
    tasks: [{ taskId: "t1", description: "pnpm test" }],
    crons: [],
    takenAt: new Date().toISOString(),
  });
  await h.app.close();
  await h.reopen({ harnessDriver: new FakeDriver(), env: { FACTORY_AGENT_PORT: "0" } });
  const rows =
    await h.sql`select notice, subject_agent_id, body from messages where to_id = ${lead.id} and kind = 'member_update'`;
  expect(rows).toEqual([
    {
      notice: "work_lost",
      subject_agent_id: a.id,
      body: `Background work of ${tagOf(testRef(a.id))} was stopped. Reported by ${tagOf(testRef(a.id))}:\n> pnpm test`,
    },
  ]);
});

test("R4 (owner): a restart that cuts short a human retry inside a reported episode adds no inbox item", async () => {
  await signUp(h.app, { handle: "or" });
  await startIdle("lead"); // a second user, "hlead"
  const lead = await agentRowOf(h.app, "lead");
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
  const lead = await agentRowOf(h.app, "lead");
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
    payload: { to: [h.seededRef("lead")], body: "retry" },
  });
  proc("lead")?.emit(ev.session("sess-lead"), ev.turn(), ev.usage(), ev.end());
  await settle("lead");
  expect((await h.sql`select errored_reported from agents where id = ${lead.id}`)[0]).toEqual({
    errored_reported: false,
  });
});

test("a message to a terminated agent is refused; a terminated sender can't send and writes nothing", async () => {
  const ada = await agentRowOf(h.app, "ada");
  await h.sql`update agents set kind = 'ephemeral', terminated_at = now(), terminated_by = null where id = (select id from principals where handle = 'bob')`;
  const toGone = await sendPlain({ agentId: ada?.id ?? "" }, ["bob"], "x", false);
  expect(toGone.results).toEqual([
    {
      to: "@bob",
      status: "refused",
      code: "terminated",
      reason: "@bob was terminated and can't receive messages.",
    },
  ]);
  await h.sql`update agents set kind = 'persistent', terminated_at = null, terminated_by = null where id = (select id from principals where handle = 'bob')`;
  await h.sql`update agents set kind = 'ephemeral', terminated_at = now(), terminated_by = null where id = (select id from principals where handle = 'ada')`;
  const fromEnded = await sendPlain({ agentId: ada?.id ?? "" }, ["bob"], "x", false);
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
  const repeated = await sendPlain(
    { agentId: ada?.id ?? "" },
    ["bob", "@bob", " @carol "],
    "x",
    false,
  );
  expect(repeated.results.map((r) => r.to)).toEqual(["@bob", "@carol"]);
});

/** A spawned child of `lead` inserted inside `tx` (it shares lead's credential). */
async function insertKid(tx: Tx, handle: string, o: { terminated?: boolean } = {}) {
  const lead = await agentRowOf(h.app, "lead");
  if (!lead) throw new Error("no lead");
  const { id } = await createPrincipal(tx, "agent", handle);
  const [row] = await tx
    .insert(schema.agents)
    .values({
      id,
      displayName: "Kid",
      description: "",
      template: lead.template,
      config: lead.config,
      runtime: "local",
      credentialId: lead.credentialId,
      kind: "ephemeral",
      reportsTo: lead.id,
      ...(o.terminated ? { terminatedAt: new Date() } : {}),
    })
    .returning();
  if (!row) throw new Error("insert failed");
  return row;
}
const heldRows = () =>
  h.sql`select p.handle as "to", m.kind, m.notice, m.body from messages m join principals p on p.id = m.to_id
        where m.kind in ('peer_joined','peer_left') order by p.handle`;
const idOf = async (handle: string) => (await agentRowOf(h.app, handle))?.id ?? "";

test("persistPeerEvents runs in the caller's transaction: it sees a child inserted there, and its rows roll back with it", async () => {
  const rollback = new Error("rollback");
  let seen: { to: string | null; kind: string; notice: string | null; body: string }[] = [];
  let kidTag = "";
  await expect(
    h.db.transaction(async (tx) => {
      const kid = await insertKid(tx, "kid-ab12");
      kidTag = tagOf(testRef(kid.id));
      const rows = await h.app.router.persistPeerEvents(
        tx,
        kid.id,
        { kind: "spawned" },
        { managerId: null, peerIds: [] },
      );
      seen = rows.map((r) => ({ to: r.toId, kind: r.kind, notice: r.notice, body: r.body }));
      throw rollback;
    }),
  ).rejects.toBe(rollback);
  const [ada, bob, lead] = [await idOf("ada"), await idOf("bob"), await idOf("lead")];
  expect(seen).toEqual([
    { to: ada, kind: "peer_joined", notice: "peer", body: `${kidTag} (Kid) joined as your peer.` },
    { to: bob, kind: "peer_joined", notice: "peer", body: `${kidTag} (Kid) joined as your peer.` },
    {
      to: lead,
      kind: "peer_joined",
      notice: "report",
      body: `${kidTag} (Kid) joined as your report.`,
    },
  ]);
  expect(await heldRows()).toEqual([]);
  expect(await agentRowOf(h.app, "kid-ab12")).toBeUndefined();
});

test("persistPeerEvents: excludeManager skips the spawner; the rows commit with the caller and are handed off after", async () => {
  const handOver = vi.spyOn(h.app.runtimes, "receive");
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
  expect(handOver).not.toHaveBeenCalled();
  expect((await heldRows()).map((r) => r.to)).toEqual(["ada", "bob"]);
  h.app.router.handOffRows(rows);
  await vi.waitFor(() => expect(handOver).toHaveBeenCalledTimes(2));
});

const OR_TAG = "<@or000000>";

test("persistPeerEvents: archived and terminated recipients get nothing; the terminated body names who", async () => {
  await h.db.transaction((tx) => insertKid(tx, "gone-ab12", { terminated: true }));
  await h.sql`update agents set archived_at = now() where id = (select id from principals where handle = 'bob')`;
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
      { kind: "left", reason: "terminated", by: OR_TAG },
      { managerId: lead, peerIds: [bob, gone] },
    ),
  );
  expect(await heldRows()).toEqual([
    {
      to: "lead",
      kind: "peer_left",
      notice: "report",
      body: `${tagOf(testRef(ada))} (Test agent) left: terminated by ${OR_TAG}.`,
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
    recipientIds: [bob],
    body: "your brief",
    urgent: false,
  });
  await h.app.runtimes.deliver(row, "agent", "spawned");
  await settle("bob");
  const started = (await h.app.store.after(bob, 0, 100)).map((e) => e.event);
  expect(started).toContainEqual(
    expect.objectContaining({ type: "process_started", reason: "spawned" }),
  );
  expect(proc("bob")?.sent[0]?.[0]).toMatchObject({
    from: expect.stringMatching(/^<@[0-9a-z]{8}\|ada>$/),
    body: "your brief",
  });
});

describe("list sends: each recipient succeeds or fails alone (spec §4.4)", () => {
  const sendAs = async (handle: string, to: string[], body = "hello all") => {
    const a = await agentRowOf(h.app, handle);
    return sendPlain({ agentId: a?.id ?? "" }, to, body, false);
  };
  const rowsOf = (body: string) =>
    h.sql`select id, recipient_ids, to_id from messages where body = ${body} and kind = 'message' order by created_at, id`;
  const idOf = async (handle: string) =>
    (await h.sql`select id from principals where handle = ${handle}`)[0]?.id as string;

  test("a message reaches only its to_id: two agents get two rows, each listing both recipients", async () => {
    const [bob, lead] = [await idOf("bob"), await idOf("lead")];
    const r = await sendAs("ada", ["bob", "lead"], "fan-out");
    expect(r.results.map((x) => x.status)).toEqual(["queued", "queued"]);
    const rows = await rowsOf("fan-out");
    expect(rows.map((row) => row.to_id).sort()).toEqual([bob, lead].sort());
    for (const row of rows) expect(row.recipient_ids).toEqual([bob, lead]);
  });

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
    expect(rows[0]?.recipient_ids).toEqual([await idOf("bob")]);
  });

  test("a terminated recipient is refused alone while the others get rows with the accepted list only", async () => {
    await signUp(h.app, { handle: "or" });
    await h.sql`update agents set kind = 'ephemeral', terminated_at = now(), terminated_by = null where id = (select id from principals where handle = 'bob')`;
    const r = await sendAs("ada", ["or", "bob", "lead"], "partial");
    expect(r.results.map((x) => [x.to, x.status])).toEqual([
      ["@or", "inbox"],
      ["@bob", "refused"],
      ["@lead", "queued"],
    ]);
    expect(r.results[1]).toMatchObject({ code: "terminated" });
    const rows = await rowsOf("partial");
    expect(rows).toHaveLength(2);
    for (const row of rows)
      expect(row.recipient_ids).toEqual([await idOf("or"), await idOf("lead")]);
    // The row order is the input order.
    expect(rows[0]?.to_id).not.toBeNull();
    expect(rows[1]?.to_id).not.toBeNull();
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
    expect(await h.sql`select id from inbox_items`).toEqual([]);
  });

  test("a disabled user is refused", async () => {
    await signUp(h.app, { handle: "gone" });
    await h.sql`update users set disabled_at = now() where id = (select id from principals where handle = 'gone')`;
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
    const r = await sendPlain(
      { userId: user.id, handle: user.handle },
      ["sam", "bob"],
      "to-mixed",
      false,
    );
    expect(r.results.map((x) => x.status)).toEqual(["refused", "queued"]);
    expect(r.results[0]).toMatchObject({ code: "human" });
    expect((await rowsOf("to-mixed"))[0]?.recipient_ids).toEqual([await idOf("bob")]);
  });

  test("chat_changed goes to the human party of each row only", async () => {
    const or = await signUp(h.app, { handle: "or" });
    const sam = await signUp(h.app, { handle: "sam" });
    const got: Record<string, ServerMessage[]> = { or: [], sam: [] };
    h.app.bus.subscribeUser(or.user.id, (m) => got.or?.push(m));
    h.app.bus.subscribeUser(sam.user.id, (m) => got.sam?.push(m));
    await sendAs("ada", ["or"], "to-or");
    expect(got.or).toContainEqual({ type: "chat_changed", agent: await h.refOf("ada") });
    expect(got.sam).toEqual([]);
    got.or = [];
    await h.app.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: sam.cookie },
      payload: { to: [h.seededRef("bob")], body: "hi bob" },
    });
    expect(got.sam).toContainEqual({ type: "chat_changed", agent: await h.refOf("bob") });
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
    for (const id of ids)
      expect((await h.sql`select state from messages where id = ${id}`)[0]?.state).toBe(
        "delivered",
      );
  });

  test("an errored agent recipient is pending with the note, beside a queued one", async () => {
    await h.sql`update agents set status = 'errored', error_kind = 'crash', last_error = 'boom' where id = (select id from principals where handle = 'bob')`;
    const r = await sendAs("ada", ["bob", "lead"], "mixed-status");
    expect(r.results[0]).toMatchObject({
      to: "@bob",
      kind: "agent",
      status: "pending",
      note: "@bob is errored; your message will be delivered after it is restarted (restart_agent, or a human).",
    });
    expect(r.results[1]).toMatchObject({ to: "@lead", status: "queued" });
  });

  test("a client-id retry returns every row's result and writes nothing twice", async () => {
    const { cookie, user } = await signUp(h.app, { handle: "orla" });
    const send = () =>
      sendPlain({ userId: user.id, handle: user.handle }, ["bob", "lead"], "twice", false, {
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
    const r = await sendPlain(
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
    const r = await sendPlain(
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
});

describe("loop guard on list sends", () => {
  const N = 2;
  let orCookie = "";
  beforeEach(async () => {
    const me = await signUp(h.app, { handle: "or" });
    orCookie = me.cookie;
    await h.app.factorySettings.update({ loopGuardMessages: N }, me.user.id);
    await h.seedAgent({ handle: "cy" });
  });
  const idOf = async (handle: string) => (await agentRowOf(h.app, handle))?.id ?? "";
  const send = async (from: string, to: string[]) =>
    (await sendPlain({ agentId: await idOf(from) }, to, "ping", false)).results;
  /** Each direction sends N messages and bob one more, so the next send from ada exceeds N both ways. */
  async function loopAdaBob() {
    for (let i = 0; i < N; i++) {
      await send("ada", ["@bob"]);
      await send("bob", ["@ada"]);
    }
    await send("bob", ["@ada"]);
  }

  test("the tripping row is held with the note, the human recipient of the same list still gets it, and the held row is never handed over", async () => {
    await loopAdaBob();
    const delivered = vi.spyOn(h.app.runtimes, "deliver");
    const results = await send("ada", ["@bob", "@or"]);
    expect(results).toMatchObject([
      {
        to: "@bob",
        kind: "agent",
        status: "held",
        note: "Held: you and @bob exchanged 6 messages in 1 minute with no human in between. A human must resume this pair in the Inbox; it is sent on then.",
      },
      { to: "@or", kind: "human", status: "inbox" },
    ]);
    const held = results[0];
    const [row] =
      await h.sql`select state, loop_hold_id from messages where id = ${(held as { id: string }).id}`;
    expect(row?.state).toBe("loop_held");
    expect(row?.loop_hold_id).toBeTruthy();
    expect(delivered).not.toHaveBeenCalled();
    expect(frames).toContainEqual({ type: "inbox_changed" });
  });

  test("a later send in either direction gets the later-row note", async () => {
    await loopAdaBob();
    await send("ada", ["@bob"]);
    const fromAda = (await send("ada", ["@bob"]))[0];
    const fromBob = (await send("bob", ["@ada"]))[0];
    expect(fromAda).toMatchObject({
      status: "held",
      note: "Held: messages between you and @bob are held until a human resumes them in the Inbox; it is sent on then.",
    });
    expect(fromBob).toMatchObject({
      status: "held",
      note: "Held: messages between you and @ada are held until a human resumes them in the Inbox; it is sent on then.",
    });
  });

  test("a list send holds only the recipient whose pair is held", async () => {
    await loopAdaBob();
    await send("ada", ["@bob"]);
    const results = await send("ada", ["@bob", "@cy"]);
    expect(results).toMatchObject([
      { to: "@bob", status: "held" },
      { to: "@cy", status: "queued" },
    ]);
    expect(await pendingOf("cy")).toHaveLength(1);
  });

  test("a human sender is never held, however many messages the pair exchanged", async () => {
    await loopAdaBob();
    await send("ada", ["@bob"]);
    const res = await h.app.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: orCookie },
      payload: { to: [h.seededRef("bob")], body: "from a human" },
    });
    expect(res.statusCode).toBeLessThan(300);
    const [row] = await h.sql`select state from messages where body = 'from a human'`;
    expect(row?.state).toBe("pending");
  });
});

test("send_message names each recipient by tag and an unknown name as written", async () => {
  const tokA = await startIdle("ada");
  const bob = await agentRowOf(h.app, "bob");
  const out = JSON.parse(
    rawText(await callTool(url, tokA, "send_message", { to: ["bob", "ghost"], body: "hi" })),
  ).results;
  expect(out[0].to).toBe(await h.app.store.agentTag(bob?.id ?? ""));
  // A name nobody holds stays the word it was written as.
  expect(out[1]).toMatchObject({ to: "@ghost", status: "refused" });
});
