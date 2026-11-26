import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { schema } from "@open-factory/db";
import { MAX_FOCUS_CHARS, refOf } from "@open-factory/shared";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { AgentService, endedAgentsQuery } from "../agents/agent-service.ts";
import { CompactingError } from "../agents/errors.ts";
import { AgentEndedError } from "../agents/message-cancel.ts";
import { PolicyInputs } from "../agents/policy-inputs.ts";
import { ev, FakeDriver } from "../agents/testing/fake-driver.ts";
import { agentRecords, principalsByHandles } from "../principals/principal-store.ts";
import { WORKSPACE_GRACE_MS } from "../spawning/lifecycle.ts";
import { makeTestApp, runtimeOf } from "../test/helpers.ts";
import { principalSql, seedTestUser, UNKNOWN_REF } from "../test/principals.ts";
import { png } from "../uploads/fixtures.ts";

let t: Awaited<ReturnType<typeof makeTestApp>>;
let cookie: string;
const driver = new FakeDriver();
beforeAll(async () => {
  t = await makeTestApp({ harnessDriver: driver });
  await t.seedAgent();
  cookie = (await t.signUpUser({ handle: "or" })).cookie;
});
afterAll(() => t.close());

const req = (method: "GET" | "POST", url: string, payload?: Record<string, unknown>) =>
  t.app.inject({
    method,
    url,
    headers: { cookie },
    ...(payload ? { payload } : {}),
  });

test("requires a signed-in user", async () => {
  expect((await t.app.inject({ method: "GET", url: "/api/agents" })).statusCode).toBe(401);
});

test("auth runs before validation: signed-out bad input is 401, not 400", async () => {
  const post = await t.app.inject({
    method: "POST",
    url: "/api/messages",
    payload: { to: ["dev"], body: 42 },
  });
  expect(post.statusCode).toBe(401);
  expect(post.json().error.code).toBe("unauthorized");
  const get = await t.app.inject({
    method: "GET",
    url: `/api/agents/${await t.refOf("dev")}/events?limit=abc`,
  });
  expect(get.statusCode).toBe(401);
  expect(get.json().error.code).toBe("unauthorized");
});

test("list and detail", async () => {
  const list = await req("GET", "/api/agents");
  expect(list.json()).toEqual({
    agents: [
      expect.objectContaining({
        ref: await t.refOf("dev"),
        handle: "dev",
        status: "hibernated",
        runtime: "local",
      }),
    ],
    more: false,
    running: { count: 0 },
  });
  expect((await req("GET", `/api/agents/${await t.refOf("dev")}`)).json()).toEqual({
    agent: expect.objectContaining({ ref: await t.refOf("dev"), handle: "dev" }),
    queue: [],
    lastSeq: 0,
  });
  expect((await req("GET", `/api/agents/${UNKNOWN_REF}`)).json()).toEqual({
    error: { code: "agent_not_found", message: "No agent at this ref" },
  });
});

test("GET /api/agents/:ref returns the agent with its ref and handle", async () => {
  const ref = await t.refOf("dev");
  const res = await req("GET", `/api/agents/${ref}`);
  expect(res.statusCode).toBe(200);
  expect(res.json().agent).toMatchObject({ ref, handle: "dev" });
});

test("a handle is not an address: GET /api/agents/dev is 404", async () => {
  const res = await req("GET", "/api/agents/dev");
  expect(res.statusCode).toBe(404);
  expect(res.json().error).toEqual({ code: "agent_not_found", message: "No agent at this ref" });
});

test.each([
  ["a well-formed ref nobody holds", UNKNOWN_REF],
  ["something that isn't a ref at all", "..%2F..%2Fetc"],
])("%s is 404", async (_name, ref) => {
  const res = await req("GET", `/api/agents/${ref}/events`);
  expect(res.statusCode).toBe(404);
  expect(res.json().error).toEqual({ code: "agent_not_found", message: "No agent at this ref" });
});

test("an uppercase ref resolves to the same agent", async () => {
  const ref = await t.refOf("dev");
  const res = await req("GET", `/api/agents/${ref.toUpperCase()}`);
  expect(res.statusCode).toBe(200);
  expect(res.json().agent.ref).toBe(ref);
});

test("POST /api/messages takes refs", async () => {
  const t2 = await makeTestApp({ harnessDriver: new FakeDriver() });
  try {
    await t2.seedAgent();
    const { cookie: c2 } = await t2.signUpUser({ handle: "or-ref" });
    const ref = await t2.refOf("dev");
    const res = await t2.app.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: c2 },
      payload: { to: [ref], body: "by ref", urgent: false },
    });
    expect(res.statusCode).toBe(202);
    const [result] = res.json().results;
    expect(result.status).not.toBe("refused");
    expect(result.item).toMatchObject({ kind: "message", body: "by ref" });
    expect(await t2.sql`select to_id from messages where id = ${result.item.id}`).toEqual([
      { to_id: (await t2.sql`select id from principals where ref = ${ref}`)[0]?.id },
    ]);
  } finally {
    await t2.close();
  }
});

test("send, then read events back; interrupt 409 while idle, 202 with an open turn", async () => {
  const sent = await req("POST", "/api/messages", { to: ["dev"], body: "hello", urgent: false });
  expect(sent.statusCode).toBe(202);
  expect(sent.json().results[0].item).toMatchObject({
    kind: "message",
    body: "hello",
    from: "@or",
    fromKind: "human",
  });
  driver.last.emit(ev.session(), ev.turn(), ev.text("hi"), ev.usage(), ev.end());
  const rt = await runtimeOf(t.app, "dev");
  await rt?.settled();
  const page = (await req("GET", `/api/agents/${await t.refOf("dev")}/events`)).json();
  expect(page.events.map((e: { event: { type: string } }) => e.event.type)).toEqual([
    "process_started",
    "message_in",
    "session_started",
    "turn_started",
    "assistant_text",
    "usage",
    "turn_end",
  ]);
  expect(page.hasMore).toEqual({ before: false, after: false });
  expect(
    (await req("GET", `/api/agents/${await t.refOf("dev")}/events?around=3&limit=3`))
      .json()
      .events.map((e: { seq: number }) => e.seq),
  ).toEqual([2, 3, 4]);
  expect(
    (await req("GET", `/api/agents/${await t.refOf("dev")}/events?around=999`)).statusCode,
  ).toBe(404);
  const idle = await req("POST", `/api/agents/${await t.refOf("dev")}/interrupt`);
  expect(idle.statusCode).toBe(409);
  expect(idle.json().error.code).toBe("no_open_turn");
  driver.last.emit(ev.turn());
  await rt?.settled();
  expect((await req("POST", `/api/agents/${await t.refOf("dev")}/interrupt`)).statusCode).toBe(202);
});

test("interrupt during a compaction is 409 compacting", async () => {
  const rt = await runtimeOf(t.app, "dev");
  if (!rt) throw new Error("no runtime");
  const spy = vi.spyOn(rt, "interrupt").mockRejectedValueOnce(new CompactingError());
  const res = await req("POST", `/api/agents/${await t.refOf("dev")}/interrupt`);
  spy.mockRestore();
  expect(res.statusCode).toBe(409);
  expect(res.json().error).toEqual({ code: "compacting", message: "A compaction is running" });
});

test("history query edge cases", async () => {
  const both = await req("GET", `/api/agents/${await t.refOf("dev")}/events?before=3&around=3`);
  expect(both.statusCode).toBe(400);
  expect(both.json().error.code).toBe("validation_error");
  const last = (await req("GET", `/api/agents/${await t.refOf("dev")}`)).json().lastSeq as number;
  const far = (
    await req("GET", `/api/agents/${await t.refOf("dev")}/events?before=${last + 1000}&limit=2`)
  ).json();
  expect(far.events.map((e: { seq: number }) => e.seq)).toEqual([last - 1, last]);
  expect(far.hasMore).toEqual({ before: true, after: false });
  expect(
    (await req("GET", `/api/agents/${await t.refOf("dev")}/events?limit=501`)).statusCode,
  ).toBe(400);
  expect(
    (await req("GET", `/api/agents/${await t.refOf("dev")}/events?before=3&limit=2`)).json().events,
  ).toHaveLength(2);
});

test("compact is accepted and queued; a focus over the limit is 400 and queues nothing", async () => {
  const c = await req("POST", `/api/agents/${await t.refOf("dev")}/compact`, {
    focus: "keep the API",
  });
  expect(c.statusCode).toBe(202);
  expect(c.json().item).toMatchObject({ kind: "compact", focus: "keep the API" });
  expect((await req("POST", `/api/agents/${await t.refOf("dev")}/compact`, {})).statusCode).toBe(
    202,
  );
  const queued = async () =>
    ((await req("GET", `/api/agents/${await t.refOf("dev")}`)).json().queue as unknown[]).length;
  const before = await queued();
  const tooLong = await req("POST", `/api/agents/${await t.refOf("dev")}/compact`, {
    focus: "x".repeat(MAX_FOCUS_CHARS + 1),
  });
  expect(tooLong.statusCode).toBe(400);
  expect(tooLong.json().error.code).toBe("validation_error");
  expect(await queued()).toBe(before);
});

test("an archived agent refuses messages (as a result), compact and interrupt (409 agent_archived)", async () => {
  const t2 = await makeTestApp({ harnessDriver: new FakeDriver() });
  try {
    await t2.seedAgent();
    await t2.sql`update agents set archived_at = now() where id = (select id from principals where handle = 'dev')`;
    const c2 = (await t2.signUpUser({ handle: "or3" })).cookie;
    const sent = await t2.app.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: c2 },
      payload: { to: ["dev"], body: "hi", urgent: false },
    });
    expect(sent.json().results).toEqual([
      {
        to: expect.stringMatching(/^<@[0-9a-z]{8}\|dev>$/),
        status: "refused",
        reason: "@dev is archived and can't receive messages.",
        code: "archived",
      },
    ]);
    for (const [url, payload] of [
      [`/api/agents/${await t2.refOf("dev")}/compact`, {}],
      [`/api/agents/${await t2.refOf("dev")}/interrupt`, undefined],
    ] as const) {
      const res = await t2.app.inject({
        method: "POST",
        url,
        headers: { cookie: c2 },
        ...(payload ? { payload } : {}),
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe("agent_archived");
    }
    const stored = await t2.sql`select count(*)::int as n from messages`;
    expect(stored[0]?.n).toBe(0);
  } finally {
    await t2.close();
  }
});

test("agent management routes: create, patch, reset-persona, archive, unarchive, list filter, bad handles", async () => {
  const t2 = await makeTestApp({ harnessDriver: new FakeDriver() });
  try {
    const c2 = (await t2.signUpUser({ handle: "or4" })).cookie;
    const call = (method: "GET" | "POST" | "PATCH", url: string, payload?: object) =>
      t2.app.inject({ method, url, headers: { cookie: c2 }, ...(payload ? { payload } : {}) });
    const tdir = path.join(t2.factoryHome, "templates/lead");
    mkdirSync(tdir, { recursive: true });
    writeFileSync(
      path.join(tdir, "template.yaml"),
      "name: lead\ndisplay_name: Lead\nruntime: local\n",
    );
    writeFileSync(path.join(tdir, "AGENTS.md"), "# Lead\n");
    const credId = randomUUID();
    await t2.db.insert(schema.credentials).values({
      id: credId,
      name: "work",
      kind: "oauth_token",
      valueEnc: t2.app.vault.seal("tok", `credentials:${credId}`),
    });
    const or4 = await t2.refOf("or4");
    const body = {
      template: "lead",
      handle: "boss",
      displayName: "Boss",
      description: "",
      reportsTo: or4,
      credential: "work",
    };

    const created = await call("POST", "/api/agents", body);
    expect(created.statusCode).toBe(201);
    expect(created.json().agent).toMatchObject({
      ref: await t2.refOf("boss"),
      handle: "boss",
      credential: "work",
      reportsTo: { kind: "human", ref: expect.any(String), handle: "or4" },
    });
    // The manager is required, and has to be the ref of an agent or a person who exists: a 400 on the field, nothing created.
    for (const reportsTo of [null, "", "ghost", UNKNOWN_REF]) {
      const refused = await call("POST", "/api/agents", { ...body, handle: "nobody", reportsTo });
      expect(refused.statusCode).toBe(400);
      expect(refused.json().error.fields).toHaveProperty("reportsTo");
    }
    expect((await call("GET", `/api/agents/${UNKNOWN_REF}`)).statusCode).toBe(404);
    // A disabled person and a spawned agent are not managers either: 400 on the field.
    await seedTestUser(t2.db, "off");
    await t2.sql`update users set disabled_at = now() where id = (select id from principals where handle = 'off')`;
    await t2.sql.unsafe(principalSql("boss-kid1-id", "agent", "boss-kid1"));
    await t2.sql`insert into agents (id, display_name, template, config, runtime, credential_id, kind, reports_to)
      select 'boss-kid1-id', 'Kid', template, config, runtime, credential_id, 'ephemeral', id
      from agents where id = (select id from principals where handle = 'boss')`;
    for (const reportsTo of [await t2.refOf("off"), await t2.refOf("boss-kid1")]) {
      const refused = await call("POST", "/api/agents", { ...body, handle: "nobody", reportsTo });
      expect(refused.statusCode).toBe(400);
      expect(refused.json().error.fields).toHaveProperty("reportsTo");
      const patch = await call("PATCH", `/api/agents/${await t2.refOf("boss")}`, { reportsTo });
      expect(patch.statusCode).toBe(400);
      expect(patch.json().error.fields).toHaveProperty("reportsTo");
    }
    expect(
      (
        await call("PATCH", `/api/agents/${await t2.refOf("boss")}`, {
          reportsTo: await t2.refOf("boss"),
        })
      ).statusCode,
    ).toBe(400);
    await t2.sql`delete from agents where id = 'boss-kid1-id'`;
    // An uppercase ref is fine on an edit too.
    const moved = await call("PATCH", `/api/agents/${await t2.refOf("boss")}`, {
      reportsTo: or4.toUpperCase(),
    });
    expect(moved.json().agent.reportsTo).toEqual({
      kind: "human",
      ref: expect.any(String),
      handle: "or4",
    });
    const bad = await call("POST", "/api/agents", { ...body, handle: "Bad Handle" });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.fields).toHaveProperty("handle");
    expect((await call("POST", "/api/agents", body)).json().error.code).toBe("handle_taken");

    const patched = await call("PATCH", `/api/agents/${await t2.refOf("boss")}`, {
      description: "the boss",
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().agent.description).toBe("the boss");
    for (const extra of [{ template: "lead" }, { handle: "other" }]) {
      const rejected = await call("PATCH", `/api/agents/${await t2.refOf("boss")}`, {
        description: "x",
        ...extra,
      });
      expect(rejected.statusCode).toBe(400);
      expect(rejected.json().error.code).toBe("validation_error");
    }
    const [bossRow] =
      await t2.sql`select id from agents where id = (select id from principals where handle = 'boss')`;
    const bossDir = path.join(t2.factoryHome, "agents", refOf(String(bossRow?.id)));
    writeFileSync(path.join(bossDir, "AGENTS.md"), "edited");
    const rp = await call("POST", `/api/agents/${await t2.refOf("boss")}/reset-persona`);
    expect(rp.statusCode).toBe(200);
    expect(rp.json()).toMatchObject({ applied: "now", backupDir: expect.any(String) });
    expect(readFileSync(path.join(bossDir, "AGENTS.md"), "utf8")).toBe("# Lead\n");

    expect((await call("POST", `/api/agents/${await t2.refOf("boss")}/archive`)).statusCode).toBe(
      200,
    );
    expect(
      (await call("GET", "/api/agents?ended=only"))
        .json()
        .agents.map((a: { handle: string }) => a.handle),
    ).toEqual(["boss"]);
    expect((await call("GET", "/api/agents")).json().agents).toEqual([]);
    // The renamed parameter is a clear 400, not a silently different list.
    expect((await call("GET", "/api/agents?archived=only")).statusCode).toBe(400);
    expect(
      (await call("POST", `/api/agents/${await t2.refOf("boss")}/unarchive`)).json().agent
        .archivedAt,
    ).toBeNull();

    for (const [m, url] of [
      ["GET", "/api/agents/..%2F..%2Fetc"],
      ["GET", "/api/agents/..%2F..%2Fetc/events"],
      ["PATCH", "/api/agents/..%2F..%2Fetc"],
      ["POST", "/api/agents/..%2F..%2Fetc/reset-persona"],
      ["POST", "/api/agents/..%2F..%2Fetc/archive"],
      ["POST", "/api/agents/..%2F..%2Fetc/unarchive"],
      ["POST", "/api/agents/..%2F..%2Fetc/compact"],
      ["POST", "/api/agents/..%2F..%2Fetc/interrupt"],
    ] as const) {
      const res = await call(
        m,
        url,
        m === "PATCH" ? { description: "x" } : m === "POST" ? {} : undefined,
      );
      expect(res.statusCode, `${m} ${url}`).toBe(404);
      expect(res.json().error.code).toBe("agent_not_found");
    }
    const granted = await call("POST", "/api/agents", { ...body, handle: "gov", manageOrg: true });
    expect(granted.statusCode).toBe(201);
    expect(granted.json().agent).toMatchObject({ handle: "gov", manageOrg: true });
    const [govRow] = await agentRecords(t2.db).where(eq(schema.principals.handle, "gov"));
    expect(govRow?.manageOrg).toBe(true);
  } finally {
    await t2.close();
  }
});

describe("S7: terminate, workspace pin, the ended list, summary fields", () => {
  let s: Awaited<ReturnType<typeof makeTestApp>>;
  let c: string;
  let bossId: string;
  beforeAll(async () => {
    s = await makeTestApp({ harnessDriver: new FakeDriver() });
    bossId = (await s.seedAgent({ handle: "boss" })).id;
    c = (await s.signUpUser({ handle: "or7" })).cookie;
  });
  afterAll(() => s.close());

  const call = (
    method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH",
    url: string,
    payload?: object,
  ) => s.app.inject({ method, url, headers: { cookie: c }, ...(payload ? { payload } : {}) });
  /** A live spawned agent of boss, with a workdir of its own. */
  const child = async (handle: string) => {
    const id = randomUUID();
    await s.sql.unsafe(principalSql(id, "agent", handle));
    await s.sql`insert into agents (id, display_name, template, config, runtime, credential_id, kind, reports_to)
      select ${id}, 'Kid', template, config, runtime, credential_id, 'ephemeral', id
      from agents where id = ${bossId}`;
    mkdirSync(path.join(s.factoryHome, "agents", handle), { recursive: true });
  };

  test("terminate: 200 with the terminated summary, idempotent; 409 not_ephemeral; 404", async () => {
    await child("boss-aa11");
    const res = await call("POST", `/api/agents/${await s.refOf("boss-aa11")}/terminate`);
    expect(res.statusCode).toBe(200);
    const a = res.json().agent;
    expect(a).toMatchObject({
      handle: "boss-aa11",
      kind: "ephemeral",
      status: "terminated",
      workspacePinned: false,
      depth: 0,
    });
    expect(a.workspaceGraceEndsAt).toBe(
      new Date(Date.parse(a.terminatedAt) + WORKSPACE_GRACE_MS).toISOString(),
    );
    expect(a.workspaceDeletedAt).toBeUndefined();
    expect(a.stuck).toBeUndefined();
    const again = await call("POST", `/api/agents/${await s.refOf("boss-aa11")}/terminate`);
    expect(again.statusCode).toBe(200);
    expect(again.json().agent.terminatedAt).toBe(a.terminatedAt);

    const persistent = await call("POST", `/api/agents/${await s.refOf("boss")}/terminate`);
    expect(persistent.statusCode).toBe(409);
    expect(persistent.json().error.code).toBe("not_ephemeral");
    expect((await call("POST", `/api/agents/${UNKNOWN_REF}/terminate`)).statusCode).toBe(404);

    // Live agents only by default; the ended list holds it, flat.
    const live = (await call("GET", "/api/agents")).json();
    expect(live.agents.map((x: { handle: string }) => x.handle)).toEqual(["boss"]);
    expect(live.more).toBe(false);
    const ended = (await call("GET", "/api/agents?ended=only")).json();
    expect(ended.agents).toEqual([
      expect.objectContaining({
        handle: "boss-aa11",
        status: "terminated",
        depth: 0,
        reportsTo: { kind: "agent", ref: expect.any(String), handle: "boss" },
      }),
    ]);
    expect(ended.more).toBe(false);
  });

  test("terminating from the UI records the human", async () => {
    await child("boss-uu01");
    const res = await call("POST", `/api/agents/${await s.refOf("boss-uu01")}/terminate`);
    expect(res.statusCode).toBe(200);
    const [or7] = [...(await principalsByHandles(s.db, ["or7"])).values()];
    expect(res.json().agent.terminatedBy).toEqual({ ref: or7?.ref, handle: "or7" });
    const [row] =
      await s.sql`select terminated_by from agents where id = (select id from principals where handle = 'boss-uu01')`;
    expect(row?.terminated_by).toBe(or7?.id);
  });

  test("the idle TTL records no terminator", async () => {
    await child("boss-uu02");
    const [row] =
      await s.sql`select id from agents where id = (select id from principals where handle = 'boss-uu02')`;
    await s.app.terminator.terminate(String(row?.id), null);
    const got = await call("GET", `/api/agents/${await s.refOf("boss-uu02")}`);
    expect(got.json().agent).toMatchObject({ status: "terminated", terminatedBy: null });
    const [after] =
      await s.sql`select terminated_by from agents where id = (select id from principals where handle = 'boss-uu02')`;
    expect(after?.terminated_by).toBeNull();
  });

  test("a terminated agent answers 409 agent_terminated to compact, interrupt, restart, reset-session", async () => {
    await child("boss-bb22");
    expect(
      (await call("POST", `/api/agents/${await s.refOf("boss-bb22")}/terminate`)).statusCode,
    ).toBe(200);
    for (const [url, payload] of [
      ["compact", {}],
      ["interrupt", undefined],
      ["restart", undefined],
      ["reset-session", undefined],
    ] as const) {
      const res = await call("POST", `/api/agents/${await s.refOf("boss-bb22")}/${url}`, payload);
      expect(res.statusCode, url).toBe(409);
      expect(res.json().error.code, url).toBe("agent_terminated");
    }
  });

  test("a spawned agent answers 409 ephemeral_agent to PATCH, reset-persona, archive, unarchive", async () => {
    await child("boss-cc33");
    for (const [m, url, payload] of [
      ["PATCH", "", { description: "x" }],
      ["POST", "/reset-persona", undefined],
      ["POST", "/archive", undefined],
      ["POST", "/unarchive", undefined],
    ] as const) {
      const res = await call(m, `/api/agents/${await s.refOf("boss-cc33")}${url}`, payload);
      expect(res.statusCode, `${m} ${url}`).toBe(409);
      expect(res.json().error.code, `${m} ${url}`).toBe("ephemeral_agent");
    }
  });

  test("workspace pin: 409 not_terminated, pin and unpin, 409 workspace_deleted", async () => {
    await child("boss-dd44");
    for (const handle of ["boss", "boss-dd44"]) {
      const res = await call("PUT", `/api/agents/${await s.refOf(handle)}/workspace-pin`);
      expect(res.statusCode, handle).toBe(409);
      expect(res.json().error.code, handle).toBe("not_terminated");
    }
    await call("POST", `/api/agents/${await s.refOf("boss-dd44")}/terminate`);
    const pinned = await call("PUT", `/api/agents/${await s.refOf("boss-dd44")}/workspace-pin`);
    expect(pinned.statusCode).toBe(200);
    expect(pinned.json().agent).toMatchObject({ workspacePinned: true });
    expect(pinned.json().agent.workspaceGraceEndsAt).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
    const unpinned = await call(
      "DELETE",
      `/api/agents/${await s.refOf("boss-dd44")}/workspace-pin`,
    );
    expect(unpinned.statusCode).toBe(200);
    expect(unpinned.json().agent).toMatchObject({ workspacePinned: false });

    await s.sql`update agents set workspace_deleted_at = now() where id = (select id from principals where handle = 'boss-dd44')`;
    for (const m of ["PUT", "DELETE"] as const) {
      const res = await call(m, `/api/agents/${await s.refOf("boss-dd44")}/workspace-pin`);
      expect(res.statusCode, m).toBe(409);
      expect(res.json().error.code, m).toBe("workspace_deleted");
    }
    const a = (await call("GET", `/api/agents/${await s.refOf("boss-dd44")}`)).json().agent;
    expect(a.workspaceDeletedAt).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
    expect(a.workspaceGraceEndsAt).toBeUndefined();
    expect((await call("PUT", `/api/agents/${UNKNOWN_REF}/workspace-pin`)).statusCode).toBe(404);
  });

  test("the pin waits for a deletion in progress (the workspace lock), then answers 409 workspace_deleted", async () => {
    await child("boss-ee55");
    await call("POST", `/api/agents/${await s.refOf("boss-ee55")}/terminate`);
    const [row] =
      await s.sql`select id from agents where id = (select id from principals where handle = 'boss-ee55')`;
    const id = row?.id as string;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let checked!: () => void;
    const reached = new Promise<void>((r) => {
      checked = r;
    });
    const order: string[] = [];
    // The check reads the pin, then waits at the gate while holding the lock: a pin that didn't take the lock would
    // commit here and still lose its workspace.
    const deletion = s.app.workspace.deleteWorkspace(
      "boss-ee55",
      async () => {
        const [r] = await s.sql`select workspace_pinned from agents where id = ${id}`;
        checked();
        await gate;
        return r?.workspace_pinned === false;
      },
      async () => {
        await s.sql`update agents set workspace_deleted_at = now() where id = ${id}`;
        order.push("deleted");
      },
    );
    await reached;
    const pin = call("PUT", `/api/agents/${await s.refOf("boss-ee55")}/workspace-pin`).then((r) => {
      order.push("pin");
      return r;
    });
    // The pin route is waiting on the lock: give it every chance to run ahead.
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    expect(order).toEqual([]);
    release();
    expect(await deletion).toBe(true);
    const res = await pin;
    expect(order).toEqual(["deleted", "pin"]);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("workspace_deleted");
    const [after] = await s.sql`select workspace_pinned from agents where id = ${id}`;
    expect(after?.workspace_pinned).toBe(false);
  });

  test("a terminated agent whose stop failed is stuck, loaded or not", async () => {
    const ffId = randomUUID();
    await s.sql.unsafe(principalSql(ffId, "agent", "boss-ff66"));
    await s.sql`insert into agents (id, display_name, template, config, runtime, credential_id, kind, reports_to,
        terminated_at, terminated_by, status, error_kind, last_error)
      select ${ffId}, 'Kid', template, config, runtime, credential_id, 'ephemeral', id,
        now(), null, 'errored', 'stop_failed', 'x'
      from agents where id = ${bossId}`;
    const listed = (await call("GET", "/api/agents?ended=only")).json().agents;
    expect(listed.find((a: { handle: string }) => a.handle === "boss-ff66")).toMatchObject({
      status: "terminated",
      stuck: true,
    });
    // The detail loads its runtime: no process, no stop under way, so still stuck.
    expect(
      (await call("GET", `/api/agents/${await s.refOf("boss-ff66")}`)).json().agent,
    ).toMatchObject({
      status: "terminated",
      stuck: true,
    });
  });
});

describe("S7: the ended list is bounded", () => {
  let s: Awaited<ReturnType<typeof makeTestApp>>;
  let c: string;
  beforeAll(async () => {
    s = await makeTestApp({ harnessDriver: new FakeDriver() });
    await s.seedAgent({ handle: "boss" });
    c = (await s.signUpUser({ handle: "or8" })).cookie;
  });
  afterAll(() => s.close());
  const get = (url: string) => s.app.inject({ method: "GET", url, headers: { cookie: c } });
  /** `n` archived agents, `old-<i>`, the higher `i` the older. */
  const archived = async (n: number, from = 0) => {
    return s.sql`with ids as (
        select gen_random_uuid()::text as id, i from generate_series(${from}::int, ${from + n - 1}::int) i
      ), p as (
        insert into principals (id, kind, handle, ref)
        select id, 'agent', 'old-' || i, substr(md5(id), 1, 8) from ids
      )
      insert into agents (id, display_name, template, config, runtime, credential_id, reports_to, archived_at)
      select ids.id, 'Old', template, config, runtime, credential_id, reports_to,
             now() - make_interval(hours => 1 + ids.i)
      from agents, ids where agents.id = (select id from principals where handle = 'boss')`;
  };

  test("newest end first, archived and terminated together; at most 200 with more", async () => {
    await archived(199);
    const newId = randomUUID();
    await s.sql.unsafe(principalSql(newId, "agent", "boss-new1"));
    await s.sql`insert into agents (id, display_name, template, config, runtime, credential_id, kind, reports_to, terminated_at, terminated_by)
      select ${newId}, 'Kid', template, config, runtime, credential_id, 'ephemeral', id, now(), null
      from agents where id = (select id from principals where handle = 'boss')`;
    let r = (await get("/api/agents?ended=only")).json();
    expect(r.agents).toHaveLength(200);
    expect(r.more).toBe(false);
    expect(r.agents[0]).toMatchObject({ handle: "boss-new1", status: "terminated", depth: 0 });
    expect(r.agents[1].handle).toBe("old-0");
    expect(r.agents[199].handle).toBe("old-198");
    await archived(1, 199);
    r = (await get("/api/agents?ended=only")).json();
    expect(r.agents).toHaveLength(200);
    expect(r.more).toBe(true);
    expect(r.agents[199].handle).toBe("old-198");
    expect(
      (await get("/api/agents")).json().agents.map((a: { handle: string }) => a.handle),
    ).toEqual(["boss"]);
  });

  test("the ended query is served by agents_ended_idx", async () => {
    const q = endedAgentsQuery(s.db).toSQL();
    const plan = await s.sql.begin(async (tx) => {
      // A near-empty table would otherwise pick a seq scan (or a bitmap scan plus a sort); with both off, a plan
      // without a Sort shows the index serves the ORDER BY too, not just the WHERE.
      await tx`set local enable_seqscan = off`;
      await tx`set local enable_bitmapscan = off`;
      return tx.unsafe(`explain ${q.sql}`, q.params as never[]);
    });
    const text = plan.map((p) => String(p["QUERY PLAN"])).join("\n");
    expect(text).toContain("Index Scan using agents_ended_idx");
    expect(text).not.toMatch(/\bSort\b/);
  });

  test("list() reads only the rows it shows, their managers and live reports", async () => {
    const queries: string[] = [];
    const db = drizzle(s.sql, { schema, logger: { logQuery: (q) => queries.push(q) } });
    const svc = new AgentService({
      db,
      templates: s.app.templates,
      workspace: s.app.workspace,
      lock: s.app.workspaceLock,
      runtimes: s.app.runtimes,
      log: s.app.log,
      router: s.app.router,
      store: s.app.store,
      bus: s.app.bus,
      configChanges: s.app.configChanges,
      localRuntimeAllowed: () => true,
      policy: new PolicyInputs({ db }),
    });
    for (const ended of ["exclude", "only"] as const) {
      queries.length = 0;
      await svc.list(ended);
      const unscoped = queries.filter(
        (q) => /from "(agents|agent_project_grants)"/.test(q) && !/ where /.test(q),
      );
      expect(unscoped, ended).toEqual([]);
    }
    queries.length = 0;
    await svc.summary(await s.refOf("old-5"));
    expect(queries.filter((q) => /from "agents"/.test(q) && !/ where /.test(q))).toEqual([]);
  });
});

describe("U3 §6.4: cancel and restore a held message", () => {
  let s: Awaited<ReturnType<typeof makeTestApp>>;
  const drv = new FakeDriver();
  let or: { cookie: string; id: string };
  let sam: { cookie: string; id: string };
  beforeAll(async () => {
    s = await makeTestApp({ harnessDriver: drv });
    await s.seedAgent();
    const a = await s.signUpUser({ handle: "or6" });
    const b = await s.signUpUser({ handle: "sam6" });
    or = { cookie: a.cookie, id: a.user.id };
    sam = { cookie: b.cookie, id: b.user.id };
  });
  afterAll(() => s.close());

  const call = (
    who: { cookie: string },
    method: "GET" | "POST" | "DELETE",
    url: string,
    payload?: object,
  ) =>
    s.app.inject({ method, url, headers: { cookie: who.cookie }, ...(payload ? { payload } : {}) });
  const settled = async () => (await runtimeOf(s.app, "dev"))?.settled();

  /** A message sent while a Stop's hold is on: queued, unwritten. */
  async function held(body: string): Promise<string> {
    if (!drv.starts.length) {
      await call(or, "POST", "/api/messages", { to: ["dev"], body: "work", urgent: false });
      drv.last.emit(ev.session(), ev.turn());
      await settled();
      expect(
        (await call(or, "POST", `/api/agents/${await s.refOf("dev")}/interrupt`)).statusCode,
      ).toBe(202);
    }
    const res = await call(or, "POST", "/api/messages", { to: ["dev"], body, urgent: false });
    expect(res.json().results[0].item).toMatchObject({ body, waitReason: "stopping" });
    return res.json().results[0].item.id;
  }

  test("the sender cancels (200 with the item); another user gets 403; the lookup reports cancelled", async () => {
    const id = await held("hold me");
    const other = await call(sam, "DELETE", `/api/agents/${await s.refOf("dev")}/queue/${id}`);
    expect(other.statusCode).toBe(403);
    expect(other.json().error.code).toBe("not_sender");
    const res = await call(or, "DELETE", `/api/agents/${await s.refOf("dev")}/queue/${id}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      item: expect.objectContaining({ id, body: "hold me", from: "@or6" }),
    });
    // A second DELETE (another tab, a retry) is idempotent: 200 with the same item, never "already delivered".
    const again = await call(or, "DELETE", `/api/agents/${await s.refOf("dev")}/queue/${id}`);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual({ item: expect.objectContaining({ id, body: "hold me" }) });
    expect((await call(or, "GET", `/api/messages/${id}`)).json()).toMatchObject({
      id,
      state: "cancelled",
    });
    expect((await call(or, "GET", `/api/agents/${await s.refOf("dev")}`)).json().queue).toEqual([]);
  });

  test("restore is 204 and puts it back; another user's restore is 403; unknown agent is 404", async () => {
    const id = await held("undo me");
    expect(
      (await call(or, "DELETE", `/api/agents/${await s.refOf("dev")}/queue/${id}`)).statusCode,
    ).toBe(200);
    const other = await call(
      sam,
      "POST",
      `/api/agents/${await s.refOf("dev")}/queue/${id}/restore`,
    );
    expect(other.statusCode).toBe(403);
    expect(other.json().error.code).toBe("not_sender");
    const res = await call(or, "POST", `/api/agents/${await s.refOf("dev")}/queue/${id}/restore`);
    expect(res.statusCode).toBe(204);
    expect((await call(or, "GET", `/api/agents/${await s.refOf("dev")}`)).json().queue).toEqual([
      expect.objectContaining({ id, body: "undo me" }),
    ]);
    expect((await call(or, "GET", `/api/messages/${id}`)).json().state).toBe("pending");
    expect((await call(or, "DELETE", `/api/agents/${UNKNOWN_REF}/queue/${id}`)).statusCode).toBe(
      404,
    );
    // Cleanup for the next test: cancel it again.
    expect(
      (await call(or, "DELETE", `/api/agents/${await s.refOf("dev")}/queue/${id}`)).statusCode,
    ).toBe(200);
  });

  test("restore on an ended agent is 409 agent_ended", async () => {
    const rt = await runtimeOf(s.app, "dev");
    if (!rt) throw new Error("no runtime");
    const spy = vi.spyOn(rt, "restoreQueued").mockRejectedValueOnce(new AgentEndedError("dev"));
    const res = await call(or, "POST", `/api/agents/${await s.refOf("dev")}/queue/x/restore`);
    spy.mockRestore();
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("agent_ended");
  });

  test("both routes log an audit line with the user, the agent and the message", async () => {
    const id = await held("audit me");
    const info = vi.spyOn(s.app.log, "info");
    try {
      await call(sam, "DELETE", `/api/agents/${await s.refOf("dev")}/queue/${id}`);
      await call(or, "DELETE", `/api/agents/${await s.refOf("dev")}/queue/${id}`);
      await call(or, "POST", `/api/agents/${await s.refOf("dev")}/queue/${id}/restore`);
      const lines = info.mock.calls.map(([obj, msg]) => [obj, msg]);
      expect(lines).toContainEqual([
        { user: sam.id, agent: s.seededRef("dev"), messageId: id, refused: "not_sender" },
        "queued message cancel refused",
      ]);
      expect(lines).toContainEqual([
        { user: or.id, agent: s.seededRef("dev"), messageId: id },
        "queued message cancel",
      ]);
      expect(lines).toContainEqual([
        { user: or.id, agent: s.seededRef("dev"), messageId: id },
        "queued message restore",
      ]);
    } finally {
      info.mockRestore();
    }
  });
});

describe("U3 §13.2: clientMessageId dedupe on POST /messages", () => {
  let s: Awaited<ReturnType<typeof makeTestApp>>;
  const drv = new FakeDriver();
  let or: string;
  let sam: string;
  beforeAll(async () => {
    s = await makeTestApp({ harnessDriver: drv });
    await s.seedAgent();
    or = (await s.signUpUser({ handle: "or8" })).cookie;
    sam = (await s.signUpUser({ handle: "sam8" })).cookie;
  });
  afterAll(() => s.close());

  const post = (cookie: string, payload: object) =>
    s.app.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie },
      payload: { to: ["dev"], urgent: false, ...payload },
    });
  const rows = async (cid: string) =>
    s.sql`select id, from_id from messages where client_message_id = ${cid}`;
  const sends = () => drv.starts.flatMap((p) => p.writes.filter((w) => w.kind === "send"));
  const settled = async () => (await runtimeOf(s.app, "dev"))?.settled();

  test("the same id twice: one row per recipient, the same 202 body, echoed on the item", async () => {
    const cid = randomUUID();
    const first = await post(or, { body: "once", clientMessageId: cid });
    expect(first.statusCode).toBe(202);
    expect(first.json().results[0].item).toMatchObject({ body: "once", clientMessageId: cid });
    const before = sends().length;
    const second = await post(or, { body: "once", clientMessageId: cid });
    expect(second.statusCode).toBe(202);
    expect(second.json()).toEqual(first.json());
    expect(await rows(cid)).toHaveLength(1);
    expect(sends()).toHaveLength(before); // nothing queued or delivered again
  });

  test("the same id twice to two recipients: one row each, the same 202 body, nothing written twice", async () => {
    // Its own app: a second agent's process would become the driver's last one.
    const t2 = await makeTestApp({ harnessDriver: new FakeDriver() });
    try {
      await t2.seedAgent();
      await t2.seedAgent({ handle: "ops" });
      const c2 = (await t2.signUpUser({ handle: "or9" })).cookie;
      const send = () =>
        t2.app.inject({
          method: "POST",
          url: "/api/messages",
          headers: { cookie: c2 },
          payload: { to: ["dev", "ops"], body: "twice", clientMessageId: cid },
        });
      const cid = randomUUID();
      const first = await send();
      expect(first.json().results).toHaveLength(2);
      const again = await send();
      expect(again.statusCode).toBe(202);
      expect(again.json()).toEqual(first.json());
      expect(
        await t2.sql`select to_id from messages where client_message_id = ${cid}`,
      ).toHaveLength(2);
    } finally {
      await t2.close();
    }
  });

  test("the same id much later (written, its turn over) still answers the original 202, no new row", async () => {
    const cid = randomUUID();
    const first = await post(or, { body: "later", clientMessageId: cid });
    drv.last.emit(ev.session(), ev.turn(), ev.usage(), ev.end());
    await settled();
    const before = sends().length;
    const again = await post(or, { body: "a retry with other text", clientMessageId: cid });
    expect(again.statusCode).toBe(202);
    expect(again.json().results[0].item).toEqual(first.json().results[0].item);
    expect(await rows(cid)).toHaveLength(1);
    expect(sends()).toHaveLength(before);
  });

  test("the same id from a different sender is a new row", async () => {
    const cid = randomUUID();
    const a = await post(or, { body: "mine", clientMessageId: cid });
    const b = await post(sam, { body: "theirs", clientMessageId: cid });
    expect(b.statusCode).toBe(202);
    expect(b.json().results[0].item.id).not.toBe(a.json().results[0].item.id);
    expect(b.json().results[0].item).toMatchObject({
      body: "theirs",
      from: "@sam8",
      clientMessageId: cid,
    });
    expect(await rows(cid)).toHaveLength(2);
  });

  test("concurrency: two simultaneous POSTs with the same id make one row and one delivery", async () => {
    await settled();
    const cid = randomUUID();
    const before = sends().length;
    const [x, y] = await Promise.all([
      post(or, { body: "race", clientMessageId: cid }),
      post(or, { body: "race", clientMessageId: cid }),
    ]);
    await settled();
    expect([x.statusCode, y.statusCode]).toEqual([202, 202]);
    expect(x.json()).toEqual(y.json());
    expect(await rows(cid)).toHaveLength(1);
    const written = sends()
      .slice(before)
      .flatMap((w) => (w.kind === "send" ? w.messages : []))
      .filter((m) => m.clientMessageId === cid);
    expect(written).toHaveLength(1);
  });

  test("without an id nothing is deduped", async () => {
    await post(or, { body: "plain" });
    await post(or, { body: "plain" });
    const n = await s.sql`select count(*)::int as n from messages where body = 'plain'`;
    expect(n[0]?.n).toBe(2);
  });
});

describe("U3 §13.3: stored commands and GET /api/agents/:ref/commands", () => {
  let s: Awaited<ReturnType<typeof makeTestApp>>;
  const drv = new FakeDriver();
  let cookie: string;
  beforeAll(async () => {
    s = await makeTestApp({ harnessDriver: drv });
    // A template skill is a host skill folder, which a start links into the workdir.
    const skill = path.join(s.hostSkillsDir, "research");
    mkdirSync(skill, { recursive: true });
    writeFileSync(path.join(skill, "SKILL.md"), "---\nname: research\ndescription: x\n---\n");
    await s.seedAgent({ config: { template: { skills: ["research"] } } });
    cookie = (await s.signUpUser({ handle: "or13" })).cookie;
  });
  afterAll(() => s.close());
  const get = (signedIn = true) =>
    s.app.inject({
      method: "GET",
      url: `/api/agents/${s.seededRef("dev")}/commands`,
      ...(signedIn ? { headers: { cookie } } : {}),
    });
  const list = [
    { name: "research", description: "Research a topic (project)", argumentHint: "[topic]" },
    { name: "model", description: "Set the AI model", argumentHint: "<model>", builtin: true },
    {
      name: "usage",
      description: "Show session cost",
      argumentHint: "",
      builtin: true,
      aliases: ["cost", "stats"],
    },
    { name: "batch", description: "Plan a large change", argumentHint: "", builtin: true },
  ];

  test("signed out is 401; an unknown agent is 404", async () => {
    expect((await get(false)).statusCode).toBe(401);
    const res = await s.app.inject({
      method: "GET",
      url: `/api/agents/${UNKNOWN_REF}/commands`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("agent_not_found");
  });

  test("before the first start: the template's skills, source template", async () => {
    const res = await get();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ source: "template", at: null, stale: false });
    const commands = res.json().commands as { name: string; denied?: string }[];
    expect(commands.map((c) => c.name)).toContain("context");
    expect(commands.find((c) => c.name === "research")).toEqual({
      name: "research",
      description: "",
      argumentHint: "",
    });
    expect(commands.find((c) => c.name === "clear")?.denied).toMatch(/isn't available/);
  });

  test("after a start: the session's allowed list, stored apart from the agent row", async () => {
    drv.commandList = list;
    const sent = await s.app.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie },
      payload: { to: ["dev"], body: "hi", urgent: false },
    });
    expect(sent.statusCode).toBe(202);
    await expect.poll(async () => (await get()).json().source, { timeout: 5000 }).toBe("session");
    const body = (await get()).json();
    expect(body.commands.map((c: { name: string }) => c.name)).toEqual([
      "research",
      "model",
      "usage",
      "batch",
    ]);
    expect(body.stale).toBe(false);
    expect(Number.isNaN(Date.parse(body.at))).toBe(false);
    const [row] = await s.db.select().from(schema.agentCommands);
    expect(row).toMatchObject({ commands: list, claudeCodeVersion: "2.1.327" });
    // Never on agent reads: not a column of agents, never in a summary.
    expect(Object.keys(schema.agents)).not.toContain("commands");
    const detail = await s.app.inject({
      method: "GET",
      url: `/api/agents/${await s.refOf("dev")}`,
      headers: { cookie },
    });
    expect(Object.keys(detail.json().agent)).not.toContain("commands");
    expect(detail.body).not.toContain("Research a topic");
    const all = await s.app.inject({ method: "GET", url: "/api/agents", headers: { cookie } });
    expect(all.body).not.toContain("Research a topic");
  });

  test("the stored list keeps only well-formed entries, at most 500, and a plain version", async () => {
    const [agent] = await s.db.select().from(schema.agents);
    if (!agent) throw new Error("no agent");
    const many = Array.from({ length: 520 }, (_, i) => ({
      name: `s${i}`,
      description: "",
      argumentHint: "",
    }));
    const bad = { name: "x\nmodel", description: "", argumentHint: "" };
    const r = await s.app.store.saveCommands(agent.id, [bad, ...many], "v".repeat(65));
    expect(r.dropped).toBe(21);
    const row = await s.app.store.agentCommands(agent.id);
    expect(row?.commands).toHaveLength(500);
    expect(row?.commands[0]?.name).toBe("s0");
    expect(row?.claudeCodeVersion).toBeNull();
    // Put the session's list back for the next test.
    await s.app.store.saveCommands(agent.id, list, "2.1.327");
  });

  test("stale when the template's skills changed after the list was stored", async () => {
    const [agent] = await s.db.select().from(schema.agents);
    if (!agent) throw new Error("no agent");
    await s.db
      .update(schema.agents)
      .set({ config: { template: { skills: ["research", "triage"] } } });
    const body = (await get()).json();
    expect(body).toMatchObject({ source: "session", stale: true });
    // The session's list stays what the menu shows until the next start.
    expect(body.commands.map((c: { name: string }) => c.name)).toEqual([
      "research",
      "model",
      "usage",
      "batch",
    ]);
  });
});

describe("U3 §13.5: attachments on POST /messages", () => {
  let s: Awaited<ReturnType<typeof makeTestApp>>;
  const drv = new FakeDriver();
  let or: string;
  let sam: string;
  beforeAll(async () => {
    s = await makeTestApp({ harnessDriver: drv });
    await s.seedAgent({ handle: "dev" });
    await s.seedAgent({ handle: "ops" });
    or = (await s.signUpUser({ handle: "or9" })).cookie;
    sam = (await s.signUpUser({ handle: "sam9" })).cookie;
  });
  afterAll(() => s.close());

  const upload = async (handle: string, data: Buffer, name: string, cookie = or) => {
    const res = await s.app.inject({
      method: "POST",
      url: `/api/agents/${await s.refOf(handle)}/uploads`,
      headers: {
        cookie,
        "content-type": "application/octet-stream",
        "x-upload-name": encodeURIComponent(name),
      },
      payload: data,
    });
    expect(res.statusCode).toBe(201);
    return res.json().uploadId as string;
  };
  const post = (payload: object, cookie = or, handle = "dev") =>
    s.app.inject({
      method: "POST",
      url: `/api/messages`,
      headers: { cookie },
      payload: { to: [handle], urgent: false, ...payload },
    });
  const uploadRow = async (id: string) =>
    (await s.db.select().from(schema.uploads)).find((r) => r.id === id);
  const settled = async () => (await runtimeOf(s.app, "dev"))?.settled();

  test("each file adds one [attached: …] line, sets message_id, and the envelope carries the list", async () => {
    const img = await upload("dev", png(64, 32), "screen shot.png");
    const txt = await upload("dev", Buffer.from("log line\n"), "run.log");
    const res = await post({ body: "look at these", attachments: [img, txt] });
    expect(res.statusCode).toBe(202);
    const messageId = res.json().results[0].item.id as string;
    const imgRow = await uploadRow(img);
    const txtRow = await uploadRow(txt);
    expect(imgRow?.messageId).toBe(messageId);
    expect(txtRow?.messageId).toBe(messageId);
    const [msg] = await s.sql`select body, attachments from messages where id = ${messageId}`;
    expect(msg?.body).toBe(
      `look at these\n\n[attached: ${imgRow?.storedPath}]\n[attached: ${txtRow?.storedPath}]`,
    );
    const attachments = [
      {
        uploadId: img,
        name: "screen shot.png",
        kind: "image",
        bytes: imgRow?.bytes,
        width: 64,
        height: 32,
      },
      { uploadId: txt, name: "run.log", kind: "text", bytes: txtRow?.bytes },
    ];
    expect(msg?.attachments).toEqual(attachments);

    // The process gets the envelope with the UI list; the model's text is the body with the lines.
    const sent = drv.last.sent.flat().find((m) => m.id === messageId);
    expect(sent?.attachments).toEqual(attachments);
    expect(sent?.body).toContain(`[attached: ${imgRow?.storedPath}]`);
    // §22 (R3): the path is relative to the cwd the fake process was started with, and names the uploaded file.
    const rel = /\[attached: ([^\]]+)\]/.exec(sent?.body ?? "")?.[1] ?? "";
    expect(path.isAbsolute(rel)).toBe(false);
    const abs = path.resolve(drv.last.spec.cwd, rel);
    expect(readFileSync(abs)).toEqual(png(64, 32));
    expect(statSync(abs).mode & 0o004).toBe(0o004);

    // The stored message_in event carries the list for the UI.
    drv.last.emit(ev.session(), ev.turn(), ev.usage(), ev.end());
    await settled();
    const page = (
      await s.app.inject({
        method: "GET",
        url: `/api/agents/${await s.refOf("dev")}/events`,
        headers: { cookie: or },
      })
    ).json();
    const msgIn = page.events
      .map((e: { event: { type: string; messages?: { id: string }[] } }) => e.event)
      .find(
        (e: { type: string; messages?: { id: string }[] }) =>
          e.type === "message_in" && e.messages?.some((m) => m.id === messageId),
      );
    expect(msgIn.messages.find((m: { id: string }) => m.id === messageId).attachments).toEqual(
      attachments,
    );
  });

  test("the clientMessageId dedupe runs first: a retry with now-used attachments gets the original 202", async () => {
    const a = await upload("dev", Buffer.from("a\n"), "a.txt");
    const cid = randomUUID();
    const first = await post({ body: "once", clientMessageId: cid, attachments: [a] });
    expect(first.statusCode).toBe(202);
    const again = await post({ body: "once", clientMessageId: cid, attachments: [a] });
    expect(again.statusCode).toBe(202);
    expect(again.json()).toEqual(first.json());
  });

  test("an upload of another agent, another sender, already used or unknown is 422, and nothing is sent", async () => {
    const forOps = await upload("ops", Buffer.from("x\n"), "ops.txt");
    const samUpload = await upload("dev", Buffer.from("y\n"), "sam.txt", sam);
    const used = await upload("dev", Buffer.from("z\n"), "used.txt");
    expect((await post({ body: "first", attachments: [used] })).statusCode).toBe(202);
    const fresh = await upload("dev", Buffer.from("w\n"), "fresh.txt");
    // Finding D15: a repeated id has its own copy.
    const twice = await post({ body: "twice", attachments: [fresh, fresh] });
    expect(twice.statusCode).toBe(422);
    expect(twice.json().error).toEqual({
      code: "invalid_attachment",
      message: "The same file is attached twice.",
    });
    for (const bad of [[forOps], [samUpload], [used], ["no-such-upload"], [fresh, fresh]]) {
      const before = await s.sql`select count(*)::int as n from messages`;
      const res = await post({ body: "with a bad file", attachments: bad });
      expect(res.statusCode, JSON.stringify(bad)).toBe(422);
      expect(res.json().error.code).toBe("invalid_attachment");
      const after = await s.sql`select count(*)::int as n from messages`;
      expect(after[0]?.n).toBe(before[0]?.n);
    }
    // Nothing was claimed by the refused sends.
    expect((await uploadRow(fresh))?.messageId).toBeNull();
    expect((await uploadRow(forOps))?.messageId).toBeNull();
    expect((await uploadRow(samUpload))?.messageId).toBeNull();
  });

  test("two concurrent sends with the same upload: one 202, one 422, one message row", async () => {
    const a = await upload("dev", Buffer.from("race\n"), "race.txt");
    const before = await s.sql`select count(*)::int as n from messages`;
    const [x, y] = await Promise.all([
      post({ body: "first", attachments: [a] }),
      post({ body: "second", attachments: [a] }),
    ]);
    expect([x.statusCode, y.statusCode].sort()).toEqual([202, 422]);
    const after = await s.sql`select count(*)::int as n from messages`;
    expect((after[0]?.n ?? 0) - (before[0]?.n ?? 0)).toBe(1);
    const winner = x.statusCode === 202 ? x : y;
    expect((await uploadRow(a))?.messageId).toBe(winner.json().results[0].item.id);
  });

  test("the attached lines count in the 64 KB limit", async () => {
    const a = await upload("dev", Buffer.from("q\n"), "q.txt");
    const res = await post({ body: "x".repeat(64 * 1024 - 20), attachments: [a] });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatchObject({
      code: "validation_error",
      message: "Message is larger than 64 KB",
    });
    expect((await uploadRow(a))?.messageId).toBeNull();
    // Without the file the same body fits.
    expect((await post({ body: "x".repeat(64 * 1024 - 20) })).statusCode).toBe(202);
  });

  test("at most 10 attachments", async () => {
    const res = await post({
      body: "many",
      attachments: Array.from({ length: 11 }, (_, i) => `u${i}`),
    });
    expect(res.statusCode).toBe(400);
  });
});
