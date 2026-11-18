import type { AddressInfo } from "node:net";
import { createFakeClaude } from "@open-factory/harness/testing";
import { afterAll, beforeAll, expect, test } from "vitest";
import WebSocket from "ws";
import { makeTestApp, TEST_ORIGIN } from "../test/helpers.ts";

const fake = createFakeClaude({ scenario: "reply" });
let t: Awaited<ReturnType<typeof makeTestApp>>;
let cookie: string;
beforeAll(async () => {
  // no harnessDriver: the real Claude driver, pointed at the fake executable
  t = await makeTestApp({ env: { FACTORY_CLAUDE_BIN: fake.bin } });
  await t.seed();
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

  const stdin = fake.log().filter((e) => e.kind === "stdin");
  expect(stdin).toHaveLength(1);
  expect(JSON.parse(stdin[0]?.kind === "stdin" ? stdin[0].line : "{}").message.content).toMatch(
    /^<factory-message from="@or" kind="message" urgent="false" id="[0-9a-f-]+">\nhello\n<\/factory-message>$/,
  );
  const start = sessionStarts()[0];
  expect(start?.kind === "start" && start.env.DATABASE_URL).toBeUndefined();
  expect(start?.kind === "start" && start.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("test-token");

  const page = (
    await t.app.inject({ method: "GET", url: "/api/agents/dev/events", headers: { cookie } })
  ).json();
  const types = page.events.map((e: { event: { type: string } }) => e.event.type);
  expect(types).toEqual([
    "process_started",
    "message_in",
    "session_started",
    "turn_started",
    "assistant_text",
    "usage",
    "turn_end",
  ]);
  await until(() => seen.length === 7);
  expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7]);
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
