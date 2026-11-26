import path from "node:path";
import { createFakeClaude } from "@open-factory/harness/testing";
import { afterAll, beforeAll, expect, test } from "vitest";
import { makeTestApp } from "../test/helpers.ts";
import { testRef } from "../test/principals.ts";

const fake = createFakeClaude({ scenario: "reply" });
let t: Awaited<ReturnType<typeof makeTestApp>>;
let cookie: string;
beforeAll(async () => {
  // No harnessDriver: the real Claude driver, pointed at the fake executable.
  t = await makeTestApp({ env: { FACTORY_CLAUDE_BIN: fake.bin } });
  cookie = (await t.signUpUser({ handle: "or" })).cookie;
});
afterAll(() => t.close());

const sessionStarts = () =>
  fake.log().flatMap((e) => (e.kind === "start" && !e.argv.includes("--version") ? [e] : []));
const until = (pred: () => boolean | Promise<boolean>) =>
  new Promise<void>((resolve, reject) => {
    let n = 0;
    const tick = async () => {
      if (await pred()) return resolve();
      if (++n > 250) return reject(new Error("timeout"));
      setTimeout(tick, 20);
    };
    void tick();
  });

test("an agent renamed between two starts keeps its workdir and resumes its session", async () => {
  const agent = await t.seedAgent({ slug: "dev" });
  const ref = testRef(agent.id);
  const send = (to: string, body: string) =>
    t.app.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie },
      payload: { to: [to], body, urgent: false },
    });
  const idle = async () =>
    (await t.app.inject({ method: "GET", url: `/api/agents/${ref}`, headers: { cookie } })).json()
      .agent.status === "idle";

  expect((await send("dev", "hello")).statusCode).toBe(202);
  await until(async () => sessionStarts().length === 1 && (await idle()));
  const events = (
    await t.app.inject({ method: "GET", url: `/api/agents/${ref}/events`, headers: { cookie } })
  ).json().events as { event: { type: string; sessionId?: string } }[];
  const sessionId = events.find((e) => e.event.type === "session_started")?.event.sessionId;
  expect(sessionId).toBeTruthy();

  // A rename is a change to the principal's handle only; the agent's row keeps the old slug until the rename endpoint.
  await t.sql`update principals set handle = 'dev-renamed' where id = ${agent.id}`;
  await t.app.close(); // a graceful stop: the next message starts a new process
  const next = await t.reopen({ env: { FACTORY_CLAUDE_BIN: fake.bin } });
  expect(
    (
      await next.app.inject({
        method: "POST",
        url: "/api/messages",
        headers: { cookie },
        payload: { to: ["dev-renamed"], body: "again", urgent: false },
      })
    ).statusCode,
  ).toBe(202);
  await until(() => sessionStarts().length === 2);

  const [first, second] = sessionStarts();
  const workdir = path.join(t.factoryHome, "agents", ref);
  expect(first?.env.CLAUDE_CONFIG_DIR).toBe(path.join(workdir, ".claude-config"));
  // The same folder, so the cwd-derived session path is the one that holds the session.
  expect(second?.env.CLAUDE_CONFIG_DIR).toBe(first?.env.CLAUDE_CONFIG_DIR);
  expect(second?.argv).toEqual(expect.arrayContaining(["--resume", sessionId as string]));
  // The git identity: the handle at start, and an email that survives a rename.
  expect(first?.env.GIT_AUTHOR_NAME).toBe("dev");
  expect(second?.env.GIT_AUTHOR_NAME).toBe("dev-renamed");
  expect([first?.env.GIT_AUTHOR_EMAIL, second?.env.GIT_AUTHOR_EMAIL]).toEqual([
    `${ref}@open-factory.local`,
    `${ref}@open-factory.local`,
  ]);
});
