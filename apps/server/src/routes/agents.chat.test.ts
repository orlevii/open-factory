import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { ev, FakeDriver } from "../agents/testing/fake-driver.ts";
import { makeTestApp } from "../test/helpers.ts";

// I1 §6.3: GET /api/agents/:slug/chat, one human's thread with an agent, turn outcomes, and `working`.
describe("I1 §6.3: the chat thread", () => {
  let s: Awaited<ReturnType<typeof makeTestApp>>;
  const drv = new FakeDriver();
  let or: { cookie: string; id: string };
  let ann: { cookie: string; id: string };
  let agentId: string;
  let base = Date.parse("2026-03-01T10:00:00.000Z");

  beforeAll(async () => {
    s = await makeTestApp({ harnessDriver: drv });
    agentId = (await s.seedAgent({ slug: "dev" })).id;
    await s.seedAgent({ slug: "ops" });
    const o = await s.signUpUser({ handle: "orc" });
    or = { cookie: o.cookie, id: o.user.id };
    const a = await s.signUpUser({ handle: "ann" });
    ann = { cookie: a.cookie, id: a.user.id };
  });
  afterAll(() => s.close());
  beforeEach(async () => {
    await s.sql`delete from messages`;
    await s.sql`delete from turns`;
    base += 3_600_000; // each test gets its own hour: ids and times never collide
  });

  const at = (min: number) => new Date(base + min * 60_000).toISOString();
  /** A `message` row in this thread (`from` is the human or the agent). */
  async function msg(
    from: "user" | "agent",
    body: string,
    min: number,
    o: { who?: { id: string }; state?: string; turnId?: string; to?: string[] } = {},
  ) {
    const id = randomUUID();
    const who = o.who ?? or;
    await s.sql`insert into messages (id, kind, from_user_id, from_agent_id, to_agent_id, to_user_id, recipients,
        body, state, delivered_turn_id, created_at)
      values (${id}, 'message', ${from === "user" ? who.id : null}, ${from === "agent" ? agentId : null},
        ${from === "user" ? agentId : null}, ${from === "agent" ? who.id : null},
        ${o.to ?? (from === "user" ? ["@dev"] : ["@orc"])}, ${body}, ${o.state ?? "delivered"},
        ${o.turnId ?? null}, ${at(min)})`;
    return id;
  }
  async function turn(
    startMin: number,
    endMin: number,
    o: { reason?: string | null; isError?: boolean; seq?: number | null } = {},
  ) {
    const id = randomUUID();
    await s.sql`insert into turns (id, agent_id, started_at, ended_at, is_error, terminal_reason, end_event_seq)
      values (${id}, ${agentId}, ${at(startMin)}, ${at(endMin)}, ${o.isError ?? false},
        ${o.reason === undefined ? "completed" : o.reason}, ${o.seq ?? null})`;
    return id;
  }
  const get = (qs = "", who: { cookie: string } | null = or, slug = "dev") =>
    s.app.inject({
      method: "GET",
      url: `/api/agents/${slug}/chat${qs}`,
      headers: who ? { cookie: who.cookie } : {},
    });
  type Entry = { kind: string; id?: string; body?: string; key?: string; outcome?: string };
  const page = async (qs = "") => {
    const r = await get(qs);
    expect(r.statusCode).toBe(200);
    return r.json() as {
      entries: Entry[];
      nextCursor: string | null;
      newerCursor: string | null;
      working: { key: string; since: string } | null;
    };
  };
  const bodies = (p: { entries: Entry[] }) => p.entries.map((e) => e.body ?? e.outcome);

  test("both directions, oldest first, with sender, recipients and state", async () => {
    await msg("agent", "second", 2);
    await msg("user", "first", 1, { to: ["@dev", "@ops"] });
    const p = await page();
    expect(bodies(p)).toEqual(["first", "second"]);
    expect(p.entries[0]).toMatchObject({
      kind: "message",
      from: "@orc",
      fromKind: "human",
      recipients: ["@dev", "@ops"],
      state: "delivered",
      urgent: false,
    });
    expect(p.entries[1]).toMatchObject({ from: "@dev", fromKind: "agent", recipients: ["@orc"] });
    expect(p.nextCursor).toBeNull();
    expect(p.newerCursor).toBeNull();
    expect(p.working).toBeNull();
  });

  test("the newest page is oldest-first and `before` pages back", async () => {
    for (let i = 1; i <= 5; i++) await msg("user", `m${i}`, i);
    const p1 = await page("?limit=2");
    expect(bodies(p1)).toEqual(["m4", "m5"]);
    expect(p1.nextCursor).not.toBeNull();
    const p2 = await page(`?limit=2&before=${p1.nextCursor}`);
    expect(bodies(p2)).toEqual(["m2", "m3"]);
    const p3 = await page(`?limit=2&before=${p2.nextCursor}`);
    expect(bodies(p3)).toEqual(["m1"]);
    expect(p3.nextCursor).toBeNull();
  });

  test("another human's thread with the agent is excluded, and so is the agent's talk with others", async () => {
    await msg("user", "mine", 1);
    await msg("user", "hers", 2, { who: ann, to: ["@dev"] });
    await msg("agent", "to ann", 3, { who: ann });
    expect(bodies(await page())).toEqual(["mine"]);
    const r = await get("", ann);
    expect(bodies(r.json())).toEqual(["hers", "to ann"]);
  });

  test("cancelled rows are left out; a rejected row carries why", async () => {
    await msg("user", "changed my mind", 1, { state: "cancelled" });
    await msg("user", "pending one", 2, { state: "pending" });
    await msg("user", "bounced", 3, { state: "rejected" });
    const p = await page();
    expect(bodies(p)).toEqual(["pending one", "bounced"]);
    expect(p.entries[0]).toMatchObject({ state: "pending" });
    expect(p.entries[1]).toMatchObject({
      state: "rejected",
      rejectReason: "the agent isn't available",
    });
    expect(p.entries[0]).not.toHaveProperty("rejectReason");
    await s.sql`update agents set archived_at = now() where id = ${agentId}`;
    const a = await page();
    await s.sql`update agents set archived_at = null where id = ${agentId}`;
    expect(a.entries[1]).toMatchObject({ rejectReason: "the agent is archived" });
  });

  test("turn outcomes: no_reply, stopped, error, keyed by your first message in the batch, with eventSeq", async () => {
    const t1 = await turn(2, 3, { seq: 11 });
    await msg("user", "a1", 1, { turnId: t1 });
    await msg("user", "a2", 1.5, { turnId: t1 });
    const t2 = await turn(5, 6, { reason: "aborted_tools", isError: true, seq: 22 });
    await msg("user", "b", 4, { turnId: t2 });
    const t3 = await turn(8, 9, { reason: "process_stopped", seq: null });
    await msg("user", "c", 7, { turnId: t3 });
    const t4 = await turn(11, 12, { reason: "aborted_streaming" });
    await msg("user", "d", 10, { turnId: t4 });
    const t5 = await turn(14, 15, { reason: "process_exited", isError: true });
    await msg("user", "e", 13, { turnId: t5 });
    const t6 = await turn(17, 18, { reason: "factory_restarted", isError: true });
    await msg("user", "f", 16, { turnId: t6 });
    const t7 = await turn(20, 21, { reason: "completed", isError: true });
    await msg("user", "g", 19, { turnId: t7 });
    const p = await page();
    const outcomes = p.entries.filter((e) => e.kind === "turn_outcome");
    expect(outcomes.map((o) => o.outcome)).toEqual([
      "no_reply",
      "stopped",
      "stopped",
      "stopped",
      "error",
      "error",
      "error",
    ]);
    const first = outcomes[0] as unknown as { key: string; turnId: string; eventSeq: number };
    expect(first).toMatchObject({ turnId: t1, eventSeq: 11 });
    expect(first.key).toBe(p.entries.find((e) => e.body === "a1")?.id);
    expect(outcomes[2]).toMatchObject({ eventSeq: null });
    // The outcome sits at its turn's end, after the message it answers.
    expect(p.entries.slice(0, 4).map((e) => e.body ?? e.outcome)).toEqual([
      "a1",
      "a2",
      "no_reply",
      "b",
    ]);
  });

  test("a reply inside the turn suppresses the outcome; a turn that consumed none of yours has none", async () => {
    const t1 = await turn(2, 6);
    await msg("user", "ask", 1, { turnId: t1 });
    await msg("agent", "answer", 4);
    const t2 = await turn(8, 9);
    await msg("user", "ask again", 7, { turnId: t2 });
    await turn(11, 12); // a cron turn: consumed nothing
    await msg("user", "hers", 7, { who: ann, turnId: t2 }); // another human's row in the same turn
    const p = await page();
    expect(bodies(p)).toEqual(["ask", "answer", "ask again", "no_reply"]);
    expect(bodies((await get("", ann)).json())).toEqual(["hers", "no_reply"]);
  });

  test("an open turn has no outcome yet", async () => {
    const id = randomUUID();
    await s.sql`insert into turns (id, agent_id, started_at) values (${id}, ${agentId}, ${at(2)})`;
    await msg("user", "hi", 1, { turnId: id });
    expect(bodies(await page())).toEqual(["hi"]);
  });

  test("outcomes belong to the page their end time falls in", async () => {
    const t1 = await turn(2, 3);
    await msg("user", "m1", 1, { turnId: t1 });
    await msg("user", "m2", 4);
    await msg("user", "m3", 5);
    const p1 = await page("?limit=2");
    expect(bodies(p1)).toEqual(["m2", "m3"]);
    const p2 = await page(`?limit=2&before=${p1.nextCursor}`);
    expect(bodies(p2)).toEqual(["m1", "no_reply"]);
  });

  test("around=<id> returns 25 each side and a cursor to the newer entries", async () => {
    const ids: string[] = [];
    for (let i = 1; i <= 70; i++) ids.push(await msg("user", `m${i}`, i));
    const p = await page(`?around=${ids[34]}`);
    expect(p.entries).toHaveLength(51);
    expect(p.entries[0]?.body).toBe("m10");
    expect(p.entries[25]?.id).toBe(ids[34]);
    expect(p.entries.at(-1)?.body).toBe("m60");
    expect(p.nextCursor).not.toBeNull();
    expect(p.newerCursor).not.toBeNull();
    const older = await page(`?before=${p.nextCursor}&limit=50`);
    expect(older.entries.map((e) => e.body)).toEqual(
      Array.from({ length: 9 }, (_, i) => `m${i + 1}`),
    );
    const near = await page(`?around=${ids[69]}`);
    expect(near.newerCursor).toBeNull();
    expect(near.entries.at(-1)?.body).toBe("m70");
  });

  test("around a message that isn't in your thread is 404; before and around together are 400", async () => {
    const hers = await msg("user", "hers", 1, { who: ann });
    expect((await get(`?around=${hers}`)).statusCode).toBe(404);
    const mine = await msg("user", "mine", 2);
    expect((await get(`?around=${mine}&before=x`)).statusCode).toBe(400);
    expect((await get("?before=not-a-cursor")).statusCode).toBe(400);
  });

  describe("working", () => {
    test("is the runtime's fact: set from the batch write, gone once the turn closes with its outcome", async () => {
      const sent = await s.app.inject({
        method: "POST",
        url: "/api/messages",
        headers: { cookie: or.cookie },
        payload: { to: ["dev"], body: "please", urgent: false },
      });
      expect(sent.statusCode).toBeLessThan(300);
      const rt = await s.app.runtimes.bySlug("dev");
      const mid = (await s.sql`select id from messages where body = 'please'`)[0]?.id as string;
      const p = await page();
      expect(p.working).toMatchObject({ key: mid });
      expect(Number.isNaN(Date.parse(p.working?.since ?? ""))).toBe(false);
      expect((await get("", ann)).json().working).toBeNull();
      drv.last.emit(ev.session(), ev.turn(), ev.usage(), ev.end());
      await rt?.settled();
      const done = await page();
      expect(done.working).toBeNull();
      expect(done.entries.at(-1)).toMatchObject({ kind: "turn_outcome", key: mid });
    });

    test("is dropped when its key already has an outcome in the page", async () => {
      const t1 = await turn(2, 3);
      const mid = await msg("user", "ask", 1, { turnId: t1 });
      const rt = await s.app.runtimes.bySlug("dev");
      const spy = vi
        .spyOn(rt as NonNullable<typeof rt>, "workingFor")
        .mockReturnValue({ key: mid, since: at(1) });
      const p = await page();
      expect(p.working).toBeNull();
      expect(p.entries.at(-1)).toMatchObject({ kind: "turn_outcome", key: mid });
      spy.mockReturnValue({ key: "other", since: at(1) });
      expect((await page()).working).toMatchObject({ key: "other" });
      spy.mockRestore();
    });
  });

  test("a human session only: no auth and an agent token are 401; an unknown agent is 404", async () => {
    expect((await get("", null)).statusCode).toBe(401);
    const { token } = s.app.agentTokens.mint(agentId);
    const r = await s.app.inject({
      method: "GET",
      url: "/api/agents/dev/chat",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(r.statusCode).toBe(401);
    const none = await get("", or, "nobody");
    expect(none.statusCode).toBe(404);
    expect(none.json().error.code).toBe("agent_not_found");
  });
});
