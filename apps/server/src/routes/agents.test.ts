import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { schema } from "@open-factory/db";
import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { AgentService, endedAgentsQuery } from "../agents/agent-service.ts";
import { CompactingError } from "../agents/errors.ts";
import { AgentEndedError } from "../agents/message-cancel.ts";
import { ev, FakeDriver } from "../agents/testing/fake-driver.ts";
import { WORKSPACE_GRACE_MS } from "../spawning/lifecycle.ts";
import { makeTestApp } from "../test/helpers.ts";

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
    url: "/api/agents/dev/messages",
    payload: { body: 42 },
  });
  expect(post.statusCode).toBe(401);
  expect(post.json().error.code).toBe("unauthorized");
  const get = await t.app.inject({ method: "GET", url: "/api/agents/dev/events?limit=abc" });
  expect(get.statusCode).toBe(401);
  expect(get.json().error.code).toBe("unauthorized");
});

test("list and detail", async () => {
  const list = await req("GET", "/api/agents");
  expect(list.json()).toEqual({
    agents: [expect.objectContaining({ slug: "dev", status: "hibernated", runtime: "local" })],
    more: false,
    running: { count: 0, max: 8 },
  });
  expect((await req("GET", "/api/agents/dev")).json()).toEqual({
    agent: expect.objectContaining({ slug: "dev" }),
    queue: [],
    lastSeq: 0,
  });
  expect((await req("GET", "/api/agents/nope")).json()).toEqual({
    error: { code: "agent_not_found", message: "No agent named nope" },
  });
});

test("send, then read events back; interrupt 409 while idle, 202 with an open turn", async () => {
  const sent = await req("POST", "/api/agents/dev/messages", { body: "hello", urgent: false });
  expect(sent.statusCode).toBe(202);
  expect(sent.json().item).toMatchObject({ kind: "message", body: "hello", from: "@or" });
  driver.last.emit(ev.session(), ev.turn(), ev.text("hi"), ev.usage(), ev.end());
  const rt = await t.app.runtimes.bySlug("dev");
  await rt?.settled();
  const page = (await req("GET", "/api/agents/dev/events")).json();
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
    (await req("GET", "/api/agents/dev/events?around=3&limit=3"))
      .json()
      .events.map((e: { seq: number }) => e.seq),
  ).toEqual([2, 3, 4]);
  expect((await req("GET", "/api/agents/dev/events?around=999")).statusCode).toBe(404);
  const idle = await req("POST", "/api/agents/dev/interrupt");
  expect(idle.statusCode).toBe(409);
  expect(idle.json().error.code).toBe("no_open_turn");
  driver.last.emit(ev.turn());
  await rt?.settled();
  expect((await req("POST", "/api/agents/dev/interrupt")).statusCode).toBe(202);
});

test("interrupt during a compaction is 409 compacting", async () => {
  const rt = await t.app.runtimes.bySlug("dev");
  if (!rt) throw new Error("no runtime");
  const spy = vi.spyOn(rt, "interrupt").mockRejectedValueOnce(new CompactingError());
  const res = await req("POST", "/api/agents/dev/interrupt");
  spy.mockRestore();
  expect(res.statusCode).toBe(409);
  expect(res.json().error).toEqual({ code: "compacting", message: "A compaction is running" });
});

test("history query edge cases", async () => {
  const both = await req("GET", "/api/agents/dev/events?before=3&around=3");
  expect(both.statusCode).toBe(400);
  expect(both.json().error.code).toBe("validation_error");
  const last = (await req("GET", "/api/agents/dev")).json().lastSeq as number;
  const far = (await req("GET", `/api/agents/dev/events?before=${last + 1000}&limit=2`)).json();
  expect(far.events.map((e: { seq: number }) => e.seq)).toEqual([last - 1, last]);
  expect(far.hasMore).toEqual({ before: true, after: false });
  expect((await req("GET", "/api/agents/dev/events?limit=501")).statusCode).toBe(400);
  expect((await req("GET", "/api/agents/dev/events?before=3&limit=2")).json().events).toHaveLength(
    2,
  );
});

test("compact is accepted and queued; validation errors are 400", async () => {
  const c = await req("POST", "/api/agents/dev/compact", { focus: "keep the API" });
  expect(c.statusCode).toBe(202);
  expect(c.json().item).toMatchObject({ kind: "compact", focus: "keep the API" });
  expect((await req("POST", "/api/agents/dev/compact", {})).statusCode).toBe(202);
  expect(
    (await req("POST", "/api/agents/dev/messages", { body: "  ", urgent: false })).statusCode,
  ).toBe(400);
  expect(
    (await req("POST", "/api/agents/dev/messages", { body: "x".repeat(65_537), urgent: false }))
      .statusCode,
  ).toBe(400);
});

test("start failure is 503 with the fix text and the message stays queued", async () => {
  const t2 = await makeTestApp({ harnessDriver: new FakeDriver() });
  try {
    await t2.seedAgent({ config: { secrets: ["GH_TOKEN"] } });
    const c2 = (await t2.signUpUser({ handle: "or2" })).cookie;
    const res = await t2.app.inject({
      method: "POST",
      url: "/api/agents/dev/messages",
      headers: { cookie: c2 },
      payload: { body: "hi", urgent: false },
    });
    const message = "Secret GH_TOKEN isn't set. Add it in Settings → Secrets.";
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: { code: "agent_start_failed", message } });
    const detail = (
      await t2.app.inject({ method: "GET", url: "/api/agents/dev", headers: { cookie: c2 } })
    ).json();
    expect(detail.queue.map((q: { body: string }) => q.body)).toEqual(["hi"]);
    expect(detail.agent).toMatchObject({ status: "errored", lastError: message });
  } finally {
    await t2.close();
  }
});

test("an archived agent refuses messages, compact and interrupt with 409 agent_archived", async () => {
  const t2 = await makeTestApp({ harnessDriver: new FakeDriver() });
  try {
    await t2.seedAgent();
    await t2.sql`update agents set archived_at = now() where slug = 'dev'`;
    const c2 = (await t2.signUpUser({ handle: "or3" })).cookie;
    for (const [url, payload] of [
      ["/api/agents/dev/messages", { body: "hi", urgent: false }],
      ["/api/agents/dev/compact", {}],
      ["/api/agents/dev/interrupt", undefined],
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

test("agent management routes: create, patch, resync, archive, unarchive, list filter, bad slugs", async () => {
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
    const body = {
      template: "lead",
      slug: "boss",
      displayName: "Boss",
      description: "",
      reportsTo: null,
      credential: "work",
    };

    const created = await call("POST", "/api/agents", body);
    expect(created.statusCode).toBe(201);
    expect(created.json().agent).toMatchObject({ slug: "boss", credential: "work" });
    const bad = await call("POST", "/api/agents", { ...body, slug: "Bad Slug" });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.fields).toHaveProperty("slug");
    expect((await call("POST", "/api/agents", body)).json().error.code).toBe("slug_taken");

    const patched = await call("PATCH", "/api/agents/boss", { description: "the boss" });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().agent.description).toBe("the boss");
    for (const extra of [{ template: "lead" }, { slug: "other" }]) {
      const rejected = await call("PATCH", "/api/agents/boss", { description: "x", ...extra });
      expect(rejected.statusCode).toBe(400);
      expect(rejected.json().error.code).toBe("validation_error");
    }
    const rs = await call("POST", "/api/agents/boss/resync");
    expect(rs.statusCode).toBe(200);
    expect(rs.json().agent.slug).toBe("boss");

    expect((await call("POST", "/api/agents/boss/archive")).statusCode).toBe(200);
    expect((await call("POST", "/api/agents/boss/resync")).json().error.code).toBe(
      "agent_archived",
    );
    expect(
      (await call("GET", "/api/agents?ended=only"))
        .json()
        .agents.map((a: { slug: string }) => a.slug),
    ).toEqual(["boss"]);
    expect((await call("GET", "/api/agents")).json().agents).toEqual([]);
    // The renamed parameter is a clear 400, not a silently different list.
    expect((await call("GET", "/api/agents?archived=only")).statusCode).toBe(400);
    expect((await call("POST", "/api/agents/boss/unarchive")).json().agent.archivedAt).toBeNull();

    for (const [m, url] of [
      ["GET", "/api/agents/..%2F..%2Fetc"],
      ["GET", "/api/agents/..%2F..%2Fetc/events"],
      ["PATCH", "/api/agents/..%2F..%2Fetc"],
      ["POST", "/api/agents/..%2F..%2Fetc/resync"],
      ["POST", "/api/agents/..%2F..%2Fetc/archive"],
      ["POST", "/api/agents/..%2F..%2Fetc/unarchive"],
      ["POST", "/api/agents/..%2F..%2Fetc/messages"],
      ["POST", "/api/agents/..%2F..%2Fetc/compact"],
      ["POST", "/api/agents/..%2F..%2Fetc/interrupt"],
    ] as const) {
      const res = await call(m, url, m === "GET" ? undefined : { body: "x", description: "x" });
      expect(res.statusCode, `${m} ${url}`).toBe(400);
      expect(res.json().error.code).toBe("validation_error");
    }
  } finally {
    await t2.close();
  }
});

test("a human message to a terminated agent is 409 agent_terminated and writes nothing", async () => {
  const t2 = await makeTestApp({ harnessDriver: new FakeDriver() });
  try {
    await t2.seedAgent();
    const boss = await t2.seedAgent({ slug: "boss" });
    await t2.sql`update agents set reports_to = ${boss.id} where slug = 'dev'`;
    await t2.sql`update agents set kind = 'ephemeral', terminated_at = now(), terminated_by = '@factory' where slug = 'dev'`;
    const c2 = (await t2.signUpUser({ handle: "or4" })).cookie;
    const res = await t2.app.inject({
      method: "POST",
      url: "/api/agents/dev/messages",
      headers: { cookie: c2 },
      payload: { body: "hi", urgent: false },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("agent_terminated");
    expect((await t2.sql`select count(*)::int as n from messages`)[0]?.n).toBe(0);
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
    bossId = (await s.seedAgent({ slug: "boss" })).id;
    c = (await s.signUpUser({ handle: "or7" })).cookie;
  });
  afterAll(() => s.close());

  const call = (
    method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH",
    url: string,
    payload?: object,
  ) => s.app.inject({ method, url, headers: { cookie: c }, ...(payload ? { payload } : {}) });
  /** A live spawned agent of boss, with a workdir of its own. */
  const child = async (slug: string) => {
    await s.sql`insert into agents (id, slug, display_name, template, config, runtime, credential_id, kind, reports_to)
      select ${randomUUID()}, ${slug}, 'Kid', template, config, runtime, credential_id, 'ephemeral', id
      from agents where id = ${bossId}`;
    mkdirSync(path.join(s.factoryHome, "agents", slug), { recursive: true });
  };

  test("terminate: 200 with the terminated summary, idempotent; 409 not_ephemeral; 404", async () => {
    await child("boss-aa11");
    const res = await call("POST", "/api/agents/boss-aa11/terminate");
    expect(res.statusCode).toBe(200);
    const a = res.json().agent;
    expect(a).toMatchObject({
      slug: "boss-aa11",
      kind: "ephemeral",
      status: "terminated",
      terminatedBy: "@or7",
      workspacePinned: false,
      depth: 0,
    });
    expect(a.workspaceGraceEndsAt).toBe(
      new Date(Date.parse(a.terminatedAt) + WORKSPACE_GRACE_MS).toISOString(),
    );
    expect(a.workspaceDeletedAt).toBeUndefined();
    expect(a.stuck).toBeUndefined();
    const again = await call("POST", "/api/agents/boss-aa11/terminate");
    expect(again.statusCode).toBe(200);
    expect(again.json().agent.terminatedAt).toBe(a.terminatedAt);

    const persistent = await call("POST", "/api/agents/boss/terminate");
    expect(persistent.statusCode).toBe(409);
    expect(persistent.json().error.code).toBe("not_ephemeral");
    expect((await call("POST", "/api/agents/nope/terminate")).statusCode).toBe(404);

    // Live agents only by default; the ended list holds it, flat.
    const live = (await call("GET", "/api/agents")).json();
    expect(live.agents.map((x: { slug: string }) => x.slug)).toEqual(["boss"]);
    expect(live.more).toBe(false);
    const ended = (await call("GET", "/api/agents?ended=only")).json();
    expect(ended.agents).toEqual([
      expect.objectContaining({
        slug: "boss-aa11",
        status: "terminated",
        depth: 0,
        reportsTo: "boss",
      }),
    ]);
    expect(ended.more).toBe(false);
  });

  test("a terminated agent answers 409 agent_terminated to message, compact, interrupt, restart, reset-session", async () => {
    await child("boss-bb22");
    expect((await call("POST", "/api/agents/boss-bb22/terminate")).statusCode).toBe(200);
    for (const [url, payload] of [
      ["messages", { body: "hi", urgent: false }],
      ["compact", {}],
      ["interrupt", undefined],
      ["restart", undefined],
      ["reset-session", undefined],
    ] as const) {
      const res = await call("POST", `/api/agents/boss-bb22/${url}`, payload);
      expect(res.statusCode, url).toBe(409);
      expect(res.json().error.code, url).toBe("agent_terminated");
    }
  });

  test("a spawned agent answers 409 ephemeral_agent to PATCH, resync, archive, unarchive", async () => {
    await child("boss-cc33");
    for (const [m, url, payload] of [
      ["PATCH", "", { description: "x" }],
      ["POST", "/resync", undefined],
      ["POST", "/archive", undefined],
      ["POST", "/unarchive", undefined],
    ] as const) {
      const res = await call(m, `/api/agents/boss-cc33${url}`, payload);
      expect(res.statusCode, `${m} ${url}`).toBe(409);
      expect(res.json().error.code, `${m} ${url}`).toBe("ephemeral_agent");
    }
  });

  test("workspace pin: 409 not_terminated, pin and unpin, 409 workspace_deleted", async () => {
    await child("boss-dd44");
    for (const slug of ["boss", "boss-dd44"]) {
      const res = await call("PUT", `/api/agents/${slug}/workspace-pin`);
      expect(res.statusCode, slug).toBe(409);
      expect(res.json().error.code, slug).toBe("not_terminated");
    }
    await call("POST", "/api/agents/boss-dd44/terminate");
    const pinned = await call("PUT", "/api/agents/boss-dd44/workspace-pin");
    expect(pinned.statusCode).toBe(200);
    expect(pinned.json().agent).toMatchObject({ workspacePinned: true });
    expect(pinned.json().agent.workspaceGraceEndsAt).toBeDefined();
    const unpinned = await call("DELETE", "/api/agents/boss-dd44/workspace-pin");
    expect(unpinned.statusCode).toBe(200);
    expect(unpinned.json().agent).toMatchObject({ workspacePinned: false });

    await s.sql`update agents set workspace_deleted_at = now() where slug = 'boss-dd44'`;
    for (const m of ["PUT", "DELETE"] as const) {
      const res = await call(m, "/api/agents/boss-dd44/workspace-pin");
      expect(res.statusCode, m).toBe(409);
      expect(res.json().error.code, m).toBe("workspace_deleted");
    }
    const a = (await call("GET", "/api/agents/boss-dd44")).json().agent;
    expect(a.workspaceDeletedAt).toBeDefined();
    expect(a.workspaceGraceEndsAt).toBeUndefined();
    expect((await call("PUT", "/api/agents/nope/workspace-pin")).statusCode).toBe(404);
  });

  test("the pin waits for a deletion in progress (the workspace lock), then answers 409 workspace_deleted", async () => {
    await child("boss-ee55");
    await call("POST", "/api/agents/boss-ee55/terminate");
    const [row] = await s.sql`select id from agents where slug = 'boss-ee55'`;
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
    const pin = call("PUT", "/api/agents/boss-ee55/workspace-pin").then((r) => {
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
    await s.sql`insert into agents (id, slug, display_name, template, config, runtime, credential_id, kind, reports_to,
        terminated_at, terminated_by, status, error_kind, last_error)
      select ${randomUUID()}, 'boss-ff66', 'Kid', template, config, runtime, credential_id, 'ephemeral', id,
        now(), '@or7', 'errored', 'stop_failed', 'x'
      from agents where id = ${bossId}`;
    const listed = (await call("GET", "/api/agents?ended=only")).json().agents;
    expect(listed.find((a: { slug: string }) => a.slug === "boss-ff66")).toMatchObject({
      status: "terminated",
      stuck: true,
    });
    // The detail loads its runtime: no process, no stop under way, so still stuck.
    expect((await call("GET", "/api/agents/boss-ff66")).json().agent).toMatchObject({
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
    await s.seedAgent({ slug: "boss" });
    c = (await s.signUpUser({ handle: "or8" })).cookie;
  });
  afterAll(() => s.close());
  const get = (url: string) => s.app.inject({ method: "GET", url, headers: { cookie: c } });
  /** `n` archived agents, `old-<i>`, the higher `i` the older. */
  const archived = (n: number, from = 0) =>
    s.sql`insert into agents (id, slug, display_name, template, config, runtime, credential_id, archived_at)
      select gen_random_uuid(), 'old-' || i, 'Old', template, config, runtime, credential_id,
             now() - make_interval(hours => 1 + i)
      from agents, generate_series(${from}::int, ${from + n - 1}::int) i where slug = 'boss'`;

  test("newest end first, archived and terminated together; at most 200 with more", async () => {
    await archived(199);
    await s.sql`insert into agents (id, slug, display_name, template, config, runtime, credential_id, kind, reports_to, terminated_at, terminated_by)
      select gen_random_uuid(), 'boss-new1', 'Kid', template, config, runtime, credential_id, 'ephemeral', id, now(), '@factory'
      from agents where slug = 'boss'`;
    let r = (await get("/api/agents?ended=only")).json();
    expect(r.agents).toHaveLength(200);
    expect(r.more).toBe(false);
    expect(r.agents[0]).toMatchObject({ slug: "boss-new1", status: "terminated", depth: 0 });
    expect(r.agents[1].slug).toBe("old-0");
    expect(r.agents[199].slug).toBe("old-198");
    await archived(1, 199);
    r = (await get("/api/agents?ended=only")).json();
    expect(r.agents).toHaveLength(200);
    expect(r.more).toBe(true);
    expect(r.agents[199].slug).toBe("old-198");
    expect((await get("/api/agents")).json().agents.map((a: { slug: string }) => a.slug)).toEqual([
      "boss",
    ]);
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
    await svc.summary("old-5");
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
  const settled = async () => (await s.app.runtimes.bySlug("dev"))?.settled();

  /** A message sent while a Stop's hold is on: queued, unwritten. */
  async function held(body: string): Promise<string> {
    if (!drv.starts.length) {
      await call(or, "POST", "/api/agents/dev/messages", { body: "work", urgent: false });
      drv.last.emit(ev.session(), ev.turn());
      await settled();
      expect((await call(or, "POST", "/api/agents/dev/interrupt")).statusCode).toBe(202);
    }
    const res = await call(or, "POST", "/api/agents/dev/messages", { body, urgent: false });
    expect(res.json().item).toMatchObject({ body, waitReason: "stopping" });
    return res.json().item.id;
  }

  test("the sender cancels (200 with the item); another user gets 403; the lookup reports cancelled", async () => {
    const id = await held("hold me");
    const other = await call(sam, "DELETE", `/api/agents/dev/queue/${id}`);
    expect(other.statusCode).toBe(403);
    expect(other.json().error.code).toBe("not_sender");
    const res = await call(or, "DELETE", `/api/agents/dev/queue/${id}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      item: expect.objectContaining({ id, body: "hold me", from: "@or6" }),
    });
    const again = await call(or, "DELETE", `/api/agents/dev/queue/${id}`);
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe("already_delivered");
    expect((await call(or, "GET", `/api/messages/${id}`)).json()).toMatchObject({
      id,
      state: "cancelled",
    });
    expect((await call(or, "GET", "/api/agents/dev")).json().queue).toEqual([]);
  });

  test("restore is 204 and puts it back; another user's restore is 403; unknown agent is 404", async () => {
    const id = await held("undo me");
    expect((await call(or, "DELETE", `/api/agents/dev/queue/${id}`)).statusCode).toBe(200);
    const other = await call(sam, "POST", `/api/agents/dev/queue/${id}/restore`);
    expect(other.statusCode).toBe(403);
    expect(other.json().error.code).toBe("not_sender");
    const res = await call(or, "POST", `/api/agents/dev/queue/${id}/restore`);
    expect(res.statusCode).toBe(204);
    expect((await call(or, "GET", "/api/agents/dev")).json().queue).toEqual([
      expect.objectContaining({ id, body: "undo me" }),
    ]);
    expect((await call(or, "GET", `/api/messages/${id}`)).json().state).toBe("pending");
    expect((await call(or, "DELETE", `/api/agents/nope/queue/${id}`)).statusCode).toBe(404);
    // Cleanup for the next test: cancel it again.
    expect((await call(or, "DELETE", `/api/agents/dev/queue/${id}`)).statusCode).toBe(200);
  });

  test("restore on an ended agent is 409 agent_ended", async () => {
    const rt = await s.app.runtimes.bySlug("dev");
    if (!rt) throw new Error("no runtime");
    const spy = vi.spyOn(rt, "restoreQueued").mockRejectedValueOnce(new AgentEndedError("dev"));
    const res = await call(or, "POST", "/api/agents/dev/queue/x/restore");
    spy.mockRestore();
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("agent_ended");
  });

  test("both routes log an audit line with the user, the agent and the message", async () => {
    const id = await held("audit me");
    const info = vi.spyOn(s.app.log, "info");
    try {
      await call(sam, "DELETE", `/api/agents/dev/queue/${id}`);
      await call(or, "DELETE", `/api/agents/dev/queue/${id}`);
      await call(or, "POST", `/api/agents/dev/queue/${id}/restore`);
      const lines = info.mock.calls.map(([obj, msg]) => [obj, msg]);
      expect(lines).toContainEqual([
        { user: sam.id, agent: "dev", messageId: id, refused: "not_sender" },
        "queued message cancel refused",
      ]);
      expect(lines).toContainEqual([
        { user: or.id, agent: "dev", messageId: id },
        "queued message cancel",
      ]);
      expect(lines).toContainEqual([
        { user: or.id, agent: "dev", messageId: id },
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
      url: "/api/agents/dev/messages",
      headers: { cookie },
      payload: { urgent: false, ...payload },
    });
  const rows = async (cid: string) =>
    s.sql`select id, from_user_id from messages where client_message_id = ${cid}`;
  const sends = () => drv.starts.flatMap((p) => p.writes.filter((w) => w.kind === "send"));
  const settled = async () => (await s.app.runtimes.bySlug("dev"))?.settled();

  test("the same id twice: one row, the same 202 body, echoed on the item", async () => {
    const cid = randomUUID();
    const first = await post(or, { body: "once", clientMessageId: cid });
    expect(first.statusCode).toBe(202);
    expect(first.json().item).toMatchObject({ body: "once", clientMessageId: cid });
    const before = sends().length;
    const second = await post(or, { body: "once", clientMessageId: cid });
    expect(second.statusCode).toBe(202);
    expect(second.json()).toEqual(first.json());
    expect(await rows(cid)).toHaveLength(1);
    expect(sends()).toHaveLength(before); // nothing queued or delivered again
  });

  test("the same id much later (written, its turn over) still answers the original 202, no new row", async () => {
    const cid = randomUUID();
    const first = await post(or, { body: "later", clientMessageId: cid });
    drv.last.emit(ev.session(), ev.turn(), ev.usage(), ev.end());
    await settled();
    const before = sends().length;
    const again = await post(or, { body: "a retry with other text", clientMessageId: cid });
    expect(again.statusCode).toBe(202);
    expect(again.json().item).toEqual(first.json().item);
    expect(await rows(cid)).toHaveLength(1);
    expect(sends()).toHaveLength(before);
  });

  test("the same id from a different sender is a new row", async () => {
    const cid = randomUUID();
    const a = await post(or, { body: "mine", clientMessageId: cid });
    const b = await post(sam, { body: "theirs", clientMessageId: cid });
    expect(b.statusCode).toBe(202);
    expect(b.json().item.id).not.toBe(a.json().item.id);
    expect(b.json().item).toMatchObject({ body: "theirs", from: "@sam8", clientMessageId: cid });
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
