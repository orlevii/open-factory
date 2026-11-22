import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import net, { type AddressInfo } from "node:net";
import path from "node:path";
import { createFakeClaude, type FakeClaude } from "@open-factory/harness/testing";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, test } from "vitest";
import WebSocket from "ws";
import { listenOrClose } from "../shutdown.ts";
import { makeTestApp, TEST_ORIGIN } from "../test/helpers.ts";

const fake = createFakeClaude({ scenario: "reply" });
let t: Awaited<ReturnType<typeof makeTestApp>>;
let cookie: string;
beforeAll(async () => {
  // no harnessDriver: the real Claude driver, pointed at the fake executable
  t = await makeTestApp({ env: { FACTORY_CLAUDE_BIN: fake.bin } });
  await t.seedAgent();
  cookie = (await t.signUpUser({ handle: "or" })).cookie;
});
afterAll(() => t.close());

// the driver probes `claude --version` first; the fake logs that as a start too
const sessionStarts = () =>
  fake.log().filter((e) => e.kind === "start" && !e.argv.includes("--version"));

const until = async (pred: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 250; i++) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("timeout");
};

test("message API → envelope on stdin → persisted events with seq → WS frames, in order", async () => {
  await t.app.listen({ port: 0, host: "127.0.0.1" });
  const port = (t.app.server.address() as AddressInfo).port;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws`, {
    headers: { cookie, origin: TEST_ORIGIN },
  });
  const seen: number[] = [];
  ws.on("message", (d) => {
    const f = JSON.parse(String(d));
    if (f.type === "session_event") seen.push(f.event.seq);
  });
  await new Promise((r) => ws.once("open", r));
  ws.send(JSON.stringify({ type: "subscribe", agent: "dev", afterSeq: 0 }));

  const res = await t.app.inject({
    method: "POST",
    url: "/api/agents/dev/messages",
    headers: { cookie },
    payload: { body: "hello", urgent: false },
  });
  expect(res.statusCode).toBe(202);
  await until(
    async () =>
      (await t.app.inject({ method: "GET", url: "/api/agents/dev", headers: { cookie } })).json()
        .agent.status === "idle",
  );

  const stdin = fake.log().filter((e) => e.kind === "stdin" && JSON.parse(e.line).type === "user");
  expect(stdin).toHaveLength(1);
  expect(JSON.parse(stdin[0]?.kind === "stdin" ? stdin[0].line : "{}").message.content).toMatch(
    /^<factory-message from="@or" kind="message" urgent="false" id="[0-9a-f-]+">\nhello\n<\/factory-message>$/,
  );
  const start = sessionStarts()[0];
  expect(start?.kind === "start" && start.env.DATABASE_URL).toBeUndefined();
  expect(start?.kind === "start" && start.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("test-token");
  expect(start?.kind === "start" && start.env.CLAUDE_CONFIG_DIR).toBe(
    path.join(t.factoryHome, "agents", "dev", ".claude-config"),
  );

  const page = (
    await t.app.inject({ method: "GET", url: "/api/agents/dev/events", headers: { cookie } })
  ).json();
  const types = page.events.map((e: { event: { type: string } }) => e.event.type);
  expect(types).toEqual([
    "process_started",
    "message_in",
    "session_started",
    "mcp_unavailable", // the fake Claude lists no factory MCP server
    "turn_started",
    "assistant_text",
    "usage",
    "turn_end",
  ]);
  await until(() => seen.length === 8);
  expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  ws.close();
});

test("server restart: graceful stop, then the next message resumes the same session", async () => {
  const before = (
    await t.app.inject({ method: "GET", url: "/api/agents/dev/events", headers: { cookie } })
  ).json();
  const sessionId = before.events.find(
    (e: { event: { type: string } }) => e.event.type === "session_started",
  ).event.sessionId;
  await t.app.close(); // runtimes.stopAll(): close stdin → fake exits 0
  expect(
    fake
      .log()
      .filter((e) => e.kind === "exit")
      .at(-1),
  ).toMatchObject({ code: 0 });

  const next = await t.reopen({ env: { FACTORY_CLAUDE_BIN: fake.bin } });
  // the session cookie is still valid: sessions live in the same DB and the secret is the same
  const res = await next.app.inject({
    method: "POST",
    url: "/api/agents/dev/messages",
    headers: { cookie },
    payload: { body: "again", urgent: false },
  });
  expect(res.statusCode).toBe(202);
  await until(() => sessionStarts().length === 2);
  const start = sessionStarts().at(-1);
  expect(start?.kind === "start" && start.argv).toEqual(
    expect.arrayContaining(["--resume", sessionId]),
  );
});

// ---------- restarts (spec §5.7, §6.6): never two processes for one session ----------

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const startsOf = (f: FakeClaude) =>
  f.log().flatMap((e) => (e.kind === "start" && !e.argv.includes("--version") ? [e] : []));
const statusOf = async (app: FastifyInstance, c: string) =>
  (await app.inject({ method: "GET", url: "/api/agents/dev", headers: { cookie: c } })).json().agent
    .status;
const post = (app: FastifyInstance, c: string, body: string) =>
  app.inject({
    method: "POST",
    url: "/api/agents/dev/messages",
    headers: { cookie: c },
    payload: { body, urgent: false },
  });

test("assembled: app.close() with a live agent, reopen(): exactly one claude process per agent", async () => {
  const f = createFakeClaude({ scenario: "reply" });
  const env = { FACTORY_CLAUDE_BIN: f.bin };
  const w = await makeTestApp({ env });
  try {
    await w.seedAgent();
    const c = (await w.signUpUser({ handle: "or" })).cookie;
    expect((await post(w.app, c, "hello")).statusCode).toBe(202);
    await until(async () => (await statusOf(w.app, c)) === "idle");
    const first = startsOf(f)[0]?.pid ?? 0;
    expect(alive(first)).toBe(true);
    await w.app.close();
    expect(alive(first)).toBe(false);

    const next = await w.reopen({ env });
    expect(startsOf(f)).toHaveLength(1); // nothing pending: the boot woke nobody
    expect((await post(next.app, c, "again")).statusCode).toBe(202);
    await until(async () => (await statusOf(next.app, c)) === "idle");
    const pids = startsOf(f).map((s) => s.pid);
    expect(pids).toHaveLength(2);
    expect(pids.filter(alive)).toEqual([pids[1]]);
  } finally {
    await w.close();
  }
}, 20_000);

test("assembled: a server that died mid-turn: the next boot reaps the leftover claude and resumes once", async () => {
  const f = createFakeClaude({ scenario: "reply" });
  const env = { FACTORY_CLAUDE_BIN: f.bin };
  const w = await makeTestApp({ env });
  const leftover = spawn(f.bin, ["-p"], { stdio: ["pipe", "ignore", "ignore"] });
  try {
    const agent = await w.seedAgent();
    const c = (await w.signUpUser({ handle: "or" })).cookie;
    await w.app.close();
    // What a server killed mid-turn leaves: its Claude still running, journaled, and an open turn.
    await until(() => startsOf(f).length === 1);
    const pid = leftover.pid ?? 0;
    const start = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LC_ALL: "C" },
    })
      .toString()
      .trim()
      .replace(/\s+/g, " ");
    const journal = { claude: { pid, start }, tasks: [], crons: [], takenAt: "" };
    await w.sql`update agents set runtime_journal = ${JSON.stringify(journal)}::jsonb where id = ${agent.id}`;
    await w.sql`insert into turns (id, agent_id, started_at) values (${randomUUID()}, ${agent.id}, now())`;

    const next = await w.reopen({ env });
    // Reaped before the server listens; the resume is a new process, the only one.
    expect(alive(pid)).toBe(false);
    await until(async () => (await statusOf(next.app, c)) === "idle");
    const pids = startsOf(f).map((s) => s.pid);
    expect(pids).toHaveLength(2);
    expect(pids.filter(alive)).toEqual([pids[1]]);
    const page = (
      await next.app.inject({
        method: "GET",
        url: "/api/agents/dev/events",
        headers: { cookie: c },
      })
    ).json();
    const types = page.events.map((e: { event: { type: string } }) => e.event.type);
    expect(types.slice(0, 2)).toEqual(["reconciled", "process_started"]);
    expect(page.events[0].event).toEqual({
      type: "reconciled",
      killedProcesses: 1,
      stoppedContainer: false,
    });
    expect(page.events[1].event.reason).toBe("boot_resume");
  } finally {
    leftover.kill("SIGKILL");
    await w.close();
  }
}, 20_000);

test("assembled: graceful shutdown mid-turn → next boot delivers the factory_restarted notice once", async () => {
  const f = createFakeClaude({
    scenario: {
      onUser: [
        { emit: { fixture: "interrupt-then-message", lines: [1, 3] } },
        { longTool: 30_000 },
      ],
    },
  });
  const env = { FACTORY_CLAUDE_BIN: f.bin };
  const w = await makeTestApp({ env });
  try {
    await w.seedAgent();
    const c = (await w.signUpUser({ handle: "or" })).cookie;
    expect((await post(w.app, c, "long job")).statusCode).toBe(202);
    await until(
      async () =>
        (
          await w.app.inject({ method: "GET", url: "/api/agents/dev", headers: { cookie: c } })
        ).json().agent.turnOpen === true,
    );
    // Close stdin, 3 s of grace, SIGTERM: the turn is cut short by the shutdown.
    await w.app.close();
    const notices = () =>
      w.sql`select state from messages where notice = 'factory_restarted' order by created_at`;
    expect(await notices()).toEqual([{ state: "pending" }]);

    // The next boot resumes the session with a fake that answers.
    createFakeClaude({ scenario: "reply", dir: f.dir });
    const next = await w.reopen({ env });
    await until(async () => (await statusOf(next.app, c)) === "idle");
    const resumed = startsOf(f).at(-1);
    expect(resumed?.argv).toContain("--resume");
    const written = f
      .log()
      .flatMap((e) =>
        e.kind === "stdin" && JSON.parse(e.line).type === "user"
          ? [JSON.parse(e.line).message.content as string]
          : [],
      );
    const restartedNotices = written.filter((l) =>
      l.includes("The factory restarted while you were working."),
    );
    expect(restartedNotices).toHaveLength(1);
    expect(restartedNotices[0]).toMatch(/^<factory-message from="@factory" kind="system"/);
    expect(await notices()).toEqual([{ state: "delivered" }]);
    expect((await w.sql`select attempting from agents where slug = 'dev'`)[0]?.attempting).toBe(
      false,
    );

    // Delivered once: a further restart has nothing to resume.
    await next.app.close();
    const third = await w.reopen({ env: { FACTORY_CLAUDE_BIN: f.bin } });
    expect(await statusOf(third.app, c)).toBe("hibernated");
    expect(startsOf(f)).toHaveLength(2);
  } finally {
    await w.close();
  }
}, 30_000);

test("assembled: a listen that fails after the boot woke an agent closes the app; no claude process is left", async () => {
  const f = createFakeClaude({ scenario: "reply" });
  const env = { FACTORY_CLAUDE_BIN: f.bin };
  const w = await makeTestApp({ env });
  const taken = net.createServer();
  await new Promise<void>((r) => taken.listen(0, "127.0.0.1", r));
  const port = (taken.address() as AddressInfo).port;
  try {
    const agent = await w.seedAgent();
    const { user } = await w.signUpUser({ handle: "or" });
    await w.app.close();
    await w.sql`insert into messages (id, from_user_id, to_agent_id, body, urgent)
                values (${randomUUID()}, ${user.id}, ${agent.id}, 'waiting', false)`;
    const next = await w.reopen({ env });
    await until(() => startsOf(f).length === 1); // the boot woke it before any listen
    const pid = startsOf(f)[0]?.pid ?? 0;
    const log: string[] = [];
    await expect(
      listenOrClose(
        () => next.app.listen({ port, host: "127.0.0.1" }),
        () => next.app.close(),
        (m) => log.push(m),
      ),
    ).rejects.toMatchObject({ code: "EADDRINUSE" });
    expect(alive(pid)).toBe(false);
    expect(log).toEqual([]);
  } finally {
    await new Promise((r) => taken.close(r));
    await w.close();
  }
}, 20_000);
