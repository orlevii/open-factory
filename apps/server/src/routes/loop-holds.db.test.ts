import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { makeTestApp, signUp } from "../test/helpers.ts";

const N = 2;
let h: Awaited<ReturnType<typeof makeTestApp>>;
let cookie: string;
let holdId: string;

beforeEach(async () => {
  h = await makeTestApp();
  const me = await signUp(h.app, { handle: "or" });
  cookie = me.cookie;
  await h.app.factorySettings.update({ loopGuardMessages: N }, me.user.id);
  await h.seedAgent({ slug: "ada" });
  await h.seedAgent({ slug: "bob" });
});
afterEach(() => h.close());

const idOf = async (slug: string) => (await h.app.store.agentBySlug(slug))?.id ?? "";
const send = async (from: string, to: string) =>
  (await h.app.router.send({ agentId: await idOf(from) }, [`@${to}`], "ping", false)).results[0];
/** Ada sends N, bob N + 1, then ada's next send trips the guard both ways. */
async function warmUp() {
  for (let i = 0; i < N; i++) {
    await send("ada", "bob");
    await send("bob", "ada");
  }
  await send("bob", "ada");
}
/** A hold with `1 + extra` held rows (the tripping one plus later ones, both directions). */
async function openHold(extra = 2) {
  await warmUp();
  const tripping = await send("ada", "bob");
  expect(tripping).toMatchObject({ status: "held" });
  for (let i = 0; i < extra; i++) await send(i % 2 ? "bob" : "ada", i % 2 ? "ada" : "bob");
  [{ id: holdId }] = (await h.sql`select id from loop_holds`) as unknown as [{ id: string }];
}
const resume = (id: string, headers: Record<string, string> = { cookie }) =>
  h.app.inject({ method: "POST", url: `/api/loop-holds/${id}/resume`, headers });
async function entry() {
  const page = (
    await h.app.inject({ method: "GET", url: "/api/inbox", headers: { cookie } })
  ).json();
  return page.items.find((i: { notice?: string }) => i.notice === "loop_held");
}
const heldCount = async () =>
  (
    (
      await h.sql`select count(*)::int as n from messages where loop_hold_id = ${holdId} and state = 'loop_held'`
    )[0] as { n: number }
  ).n;

describe("the inbox entry's loopHold", () => {
  test("before Resume: waiting counts the held rows, nothing sent on, both agents live, nobody resumed", async () => {
    await openHold(2);
    expect((await entry()).loopHold).toEqual({
      id: holdId,
      agents: [
        { slug: expect.stringMatching(/^(ada|bob)$/), status: "live" },
        { slug: expect.stringMatching(/^(ada|bob)$/), status: "live" },
      ],
      waiting: 3,
      sentOn: 0,
      resumedAt: null,
      resumedBy: null,
    });
  });

  test("after Resume: sentOn is the rows sent on, waiting 0, resumedBy the handle with @; a fresh read says the same", async () => {
    await openHold(2);
    await resume(holdId);
    const first = (await entry()).loopHold;
    const again = (await entry()).loopHold;
    expect(first).toMatchObject({ waiting: 0, sentOn: 3, resumedBy: "@or" });
    expect(first.resumedAt).toEqual(expect.any(String));
    expect(again).toEqual(first);
  });

  test("an archived or terminated agent shows its status", async () => {
    await openHold(0);
    const [a, b] = (await entry()).loopHold.agents as [{ slug: string }, { slug: string }];
    await h.sql`update agents set archived_at = now() where slug = ${a.slug}`;
    await h.sql`update agents set kind = 'ephemeral', reports_to = ${await idOf(a.slug)}, reports_to_user = null, terminated_at = now(), terminated_by = '@or' where slug = ${b.slug}`;
    const { agents } = (await entry()).loopHold;
    expect(agents).toEqual([
      { slug: a.slug, status: "archived" },
      { slug: b.slug, status: "terminated" },
    ]);
  });

  test("a hold whose rows were all rejected shows nothing waiting and resumes with sentOn 0", async () => {
    await openHold(1);
    await h.sql`update messages set state = 'rejected' where loop_hold_id = ${holdId}`;
    expect((await entry()).loopHold).toMatchObject({ waiting: 0, sentOn: 0 });
    const res = await resume(holdId);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ sentOn: 0 });
  });
});

describe("POST /api/loop-holds/:id/resume", () => {
  test("flips every held row to pending, hands them over in created_at order, returns sentOn and stamps the hold", async () => {
    await openHold(2);
    const order = (
      await h.sql`select id from messages where loop_hold_id = ${holdId} and state = 'loop_held' order by created_at, id`
    ).map((r) => r.id);
    const delivered = vi.spyOn(h.app.runtimes, "deliver").mockResolvedValue(undefined);
    const res = await resume(holdId);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ sentOn: 3 });
    expect(await heldCount()).toBe(0);
    const states =
      await h.sql`select distinct state from messages where loop_hold_id = ${holdId} and kind <> 'system'`;
    expect(states.map((r) => r.state)).toEqual(["pending"]);
    const [hold] =
      await h.sql`select h.resumed_at, u.handle from loop_holds h join principals u on u.id = h.resumed_by`;
    expect(hold?.handle).toBe("or");
    expect(hold?.resumed_at).toBeTruthy();
    await vi.waitFor(() => expect(delivered).toHaveBeenCalledTimes(3));
    expect(delivered.mock.calls.map(([row]) => row.id)).toEqual(order);
    expect(
      delivered.mock.calls.every(
        ([, sender, reason]) => sender === "agent" && reason === "agent_message",
      ),
    ).toBe(true);
  });

  test("rows are handed over as they would have been sent: task comments as task_message, scheduled rows as scheduled", async () => {
    await openHold(0);
    const delivered = vi.spyOn(h.app.runtimes, "deliver").mockResolvedValue(undefined);
    await resume(holdId);
    await vi.waitFor(() => expect(delivered).toHaveBeenCalledTimes(1));
    const row = delivered.mock.calls[0]?.[0];
    if (!row) throw new Error("no row was handed over");
    delivered.mockClear();
    // The kind check constraint ties task and schedule columns to their kinds, so hand over kind-swapped copies.
    h.app.router.handOffResumed([
      { ...row, id: "c", kind: "task_comment" },
      { ...row, id: "s", kind: "scheduled" },
      row,
    ]);
    await vi.waitFor(() => expect(delivered).toHaveBeenCalledTimes(3));
    expect(delivered.mock.calls.map(([r, sender, reason]) => [r.id, sender, reason])).toEqual([
      ["c", "agent", "task_message"],
      ["s", "agent", "scheduled"],
      [row.id, "agent", "agent_message"],
    ]);
  });

  test("a delivery failure leaves the row pending and the Resume succeeds", async () => {
    await openHold(0);
    const delivered = vi.spyOn(h.app.runtimes, "deliver").mockRejectedValue(new Error("boom"));
    const res = await resume(holdId);
    expect(res.statusCode).toBe(200);
    await vi.waitFor(() => expect(delivered).toHaveBeenCalled());
    const states =
      await h.sql`select distinct state from messages where loop_hold_id = ${holdId} and kind <> 'system'`;
    expect(states.map((r) => r.state)).toEqual(["pending"]);
  });

  test("a second Resume is a 409 naming who and when; an unknown id is a 404; no session is a 401", async () => {
    await openHold(0);
    const first = await resume(holdId);
    const second = await resume(holdId);
    expect(second.statusCode).toBe(409);
    const [{ resumed_at }] = (await h.sql`select resumed_at from loop_holds`) as unknown as [
      { resumed_at: Date },
    ];
    expect(second.json().error).toMatchObject({
      resumedBy: "@or",
      resumedAt: new Date(resumed_at).toISOString(),
    });
    expect(first.statusCode).toBe(200);
    expect((await resume("nope")).statusCode).toBe(404);
    expect((await resume(holdId, {})).statusCode).toBe(401);
    // An agent's bearer token is not a session.
    expect((await resume(holdId, { authorization: "Bearer not-a-session" })).statusCode).toBe(401);
  });

  test("the window restarts at the Resume: N more each way go through before the pair trips again", async () => {
    await openHold(0);
    await resume(holdId);
    await warmUp();
    expect(await send("ada", "bob")).toMatchObject({ status: "held" });
    const holds = await h.sql`select id from loop_holds where resumed_at is null`;
    expect(holds).toHaveLength(1);
  });

  test("a send past its check but not yet committed when Resume starts is flipped too: Resume waits on the pair lock", async () => {
    await openHold(0);
    const ids =
      (await h.sql`select agent_a, agent_b from loop_holds where id = ${holdId}`) as unknown as [
        { agent_a: string; agent_b: string },
      ];
    const { agent_a: a, agent_b: b } = ids[0] as { agent_a: string; agent_b: string };
    let passedCheck!: () => void;
    const checked = new Promise<void>((r) => (passedCheck = r));
    let release!: () => void;
    const paused = new Promise<void>((r) => (release = r));
    // The send's transaction by hand on a second connection: lock, check (hold open), pause, insert, commit.
    const send2 = h.sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtextextended(${`loop:${a}:${b}`}, 0))`;
      const open = await tx`select id from loop_holds where id = ${holdId} and resumed_at is null`;
      expect(open).toHaveLength(1);
      passedCheck();
      await paused;
      await tx`insert into messages select * from jsonb_populate_record(null::messages,
        (select to_jsonb(m) || jsonb_build_object('id', 'race-row', 'created_at', now()) from messages m
         where m.loop_hold_id = ${holdId} and m.state = 'loop_held' limit 1))`;
    });
    await checked;
    let done = false;
    const resuming = resume(holdId).then((r) => {
      done = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(done).toBe(false);
    release();
    await send2;
    const res = await resuming;
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ sentOn: 2 });
    expect(await heldCount()).toBe(0);
    const [row] = await h.sql`select state from messages where id = 'race-row'`;
    expect(row?.state).toBe("pending");
  });
});
