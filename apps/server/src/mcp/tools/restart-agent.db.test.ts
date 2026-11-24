import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ev, FakeDriver } from "../../agents/testing/fake-driver.ts";
import { makeTestApp, signUp } from "../../test/helpers.ts";
import { callTool, mcpCall } from "../testing/mcp-client.ts";

// I7 §9.1: restart_agent(target, note?, force?), for persistent agents only.
let h: Awaited<ReturnType<typeof makeTestApp>>;
let drv: FakeDriver;
let url: string;
let cookie: string;
const ids: Record<string, string> = {};
const tok: Record<string, string> = {};

beforeEach(async () => {
  drv = new FakeDriver();
  // Earlier tests in a file leave processes running; the default cap of 8 would queue these starts.
  h = await makeTestApp({ harnessDriver: drv, factorySettings: { maxRunningAgents: 50 } });
  url = `http://127.0.0.1:${h.app.agentListener.port}`;
  cookie = (await signUp(h.app, { handle: "or" })).cookie;
  for (const slug of ["lead", "dev", "qa"]) {
    ids[slug] = (await h.seedAgent({ slug })).id;
    tok[slug] = h.app.agentTokens.mint(ids[slug] as string).token;
  }
  // A spawned report of lead, and dev and kid are lead's reports.
  ids.kid = (await h.seedAgent({ slug: "kid" })).id;
  tok.kid = h.app.agentTokens.mint(ids.kid as string).token;
  await h.sql`update agents set kind = 'ephemeral', reports_to = ${ids.lead as string} where slug = 'kid'`;
  await h.sql`update agents set reports_to = ${ids.lead as string} where slug = 'dev'`;
});
afterEach(() => h.close());

const text = (r: { content: { text: string }[] }) => r.content[0]?.text ?? "";
const call = async (who: string, args: object) => {
  const r = await callTool(url, tok[who] as string, "restart_agent", args);
  return {
    err: r.isError === true,
    text: text(r),
    json: r.isError ? undefined : JSON.parse(text(r)),
  };
};
const names = async (who: string) =>
  (
    (await mcpCall(url, tok[who] as string, "tools/list", {})).json.result.tools as {
      name: string;
    }[]
  ).map((t) => t.name);
const post = (url: string, payload: Record<string, unknown>) =>
  h.app.inject({ method: "POST", url, headers: { cookie }, payload });
/** The processes the driver has started for an agent, in order. */
const startsOf = (slug: string) => drv.starts.filter((p) => p.spec.agentId === ids[slug]);
/** What a process was sent, as [from, body] pairs in order. */
const delivered = (p: { sent: { from: string; body: string }[][] }) =>
  p.sent.flat().map((m) => [m.from, m.body]);
/** A report of lead that is running with a turn open (a cut restart interrupts it). */
async function runningMidTurn(slug: string) {
  await post("/api/messages", { to: [slug], body: "work", urgent: false });
  const p = startsOf(slug).at(-1);
  if (!p) throw new Error("never started");
  p.emit(ev.session(), ev.turn());
  await (await h.app.runtimes.bySlug(slug))?.settled();
  return p;
}

test("restart_agent is listed for persistent agents and not for a spawned one", async () => {
  expect(await names("lead")).toContain("restart_agent");
  expect(await names("kid")).not.toContain("restart_agent");
  const r = await mcpCall(url, tok.kid as string, "tools/call", {
    name: "restart_agent",
    arguments: { target: "dev" },
  });
  expect(r.json.error ?? r.json.result?.isError).toBeTruthy();
});

test("a direct report, spawned ones included, is restarted; a hibernated one reports not_running", async () => {
  expect(await call("lead", { target: "@dev" })).toMatchObject({
    err: false,
    json: { target: "@dev", status: "not_running" },
  });
  expect(await call("lead", { target: "kid" })).toMatchObject({
    json: { target: "@kid", status: "not_running" },
  });
});

test("a non-report is refused without manage_org, and is not restarted", async () => {
  expect(await call("lead", { target: "qa" })).toMatchObject({
    err: true,
    text: "@qa isn't one of your direct reports.",
  });
  expect(await call("dev", { target: "lead" })).toMatchObject({
    err: true,
    text: "@lead isn't one of your direct reports.",
  });
});

test("with manage_org, any live agent is accepted", async () => {
  await h.sql`update agents set manage_org = true where slug = 'lead'`;
  expect(await call("lead", { target: "qa" })).toMatchObject({
    err: false,
    json: { target: "@qa", status: "not_running" },
  });
});

test("the caller can't restart itself, even with manage_org", async () => {
  await h.sql`update agents set manage_org = true where slug = 'lead'`;
  expect(await call("lead", { target: "@lead" })).toMatchObject({
    err: true,
    text: "Your config changes apply when you're idle; you can't restart yourself.",
  });
});

test.each([
  [
    "archived",
    "update agents set archived_at = now() where slug = 'dev'",
    "@dev is archived and can't receive messages.",
  ],
])("an %s report gets the messaging sentence and is not restarted", async (_, sql, sentence) => {
  await h.sql.unsafe(sql);
  expect(await call("lead", { target: "dev" })).toMatchObject({ err: true, text: sentence });
  expect(startsOf("dev")).toHaveLength(0);
});

// Only an ephemeral agent can be terminated (a schema rule), so a terminated report is a spawned one.
test("a terminated report gets the messaging sentence and is not restarted", async () => {
  await h.sql`update agents set terminated_at = now() where slug = 'kid'`;
  expect(await call("lead", { target: "kid" })).toMatchObject({
    err: true,
    text: "@kid was terminated and can't receive messages.",
  });
  expect(startsOf("kid")).toHaveLength(0);
});

test("a cut restart delivers the note from the caller after the restart notice", async () => {
  const p = await runningMidTurn("dev");
  expect(await call("lead", { target: "dev", note: "Rerun the tests." })).toMatchObject({
    json: { target: "@dev", status: "restarting" },
  });
  p.emit(ev.end()); // the turn ends: the stop begins and the exit makes the attempt
  await (await h.app.runtimes.bySlug("dev"))?.settled();
  const next = startsOf("dev").at(-1);
  expect(next).not.toBe(p);
  const got = delivered(next as (typeof drv.starts)[number]);
  expect(got).toEqual([
    ["@factory", expect.stringContaining("Restarted by @lead")],
    ["@lead", "Rerun the tests."],
  ]);
});

test("a refused restart (background work and no force) restarts nothing and sends no note", async () => {
  await post("/api/messages", { to: ["dev"], body: "hi", urgent: false });
  startsOf("dev")
    .at(-1)
    ?.emit(...ev.fullTurn(), ev.background([{ taskId: "t1", description: "pnpm test" }]));
  await (await h.app.runtimes.bySlug("dev"))?.settled();
  const before = startsOf("dev").length;
  const r = await call("lead", { target: "dev", note: "Rerun the tests." });
  expect(r).toMatchObject({ err: true });
  expect(r.text).toContain("pass force: true");
  expect(startsOf("dev")).toHaveLength(before);
  expect(startsOf("dev").at(-1)?.exited).toBe(false);
  expect(
    startsOf("dev")
      .at(-1)
      ?.sent.flat()
      .map((m) => m.from),
  ).not.toContain("@lead");
});

test("force: true restarts the report with its background work stopped, and the note follows", async () => {
  await post("/api/messages", { to: ["dev"], body: "hi", urgent: false });
  startsOf("dev")
    .at(-1)
    ?.emit(...ev.fullTurn(), ev.background([{ taskId: "t1", description: "pnpm test" }]));
  await (await h.app.runtimes.bySlug("dev"))?.settled();
  expect(
    await call("lead", { target: "dev", note: "Rerun the tests.", force: true }),
  ).toMatchObject({
    json: { target: "@dev", status: "restarting" },
  });
  await (await h.app.runtimes.bySlug("dev"))?.settled();
  const next = startsOf("dev").at(-1) as (typeof drv.starts)[number];
  expect(delivered(next).at(-1)).toEqual(["@lead", "Rerun the tests."]);
});

test("a resolver failure (a broken template) still restarts the report and records the restart", async () => {
  const p = await runningMidTurn("dev");
  vi.spyOn(h.app.resolver, "effective").mockRejectedValueOnce(new Error("template is broken"));
  expect(await call("lead", { target: "dev" })).toMatchObject({
    json: { target: "@dev", status: "restarting" },
  });
  p.emit(ev.end());
  await (await h.app.runtimes.bySlug("dev"))?.settled();
  const events = (await h.app.store.after(ids.dev as string, 0, 1000)).map((e) => e.event);
  expect(events).toContainEqual({ type: "control", cmd: "restart", by: "@lead" });
});

test("a hibernated report: the note wakes it, and it is the first message it gets", async () => {
  expect(await call("lead", { target: "dev", note: "Start on the plan." })).toMatchObject({
    json: { status: "not_running" },
  });
  await (await h.app.runtimes.bySlug("dev"))?.settled();
  const started = startsOf("dev").at(-1);
  expect(started && delivered(started)).toEqual([["@lead", "Start on the plan."]]);
});

test("a note over 64 KB is refused by the input schema and the report is not restarted", async () => {
  const r = await call("lead", { target: "dev", note: "x".repeat(64 * 1024 + 1) });
  expect(r.err).toBe(true);
  expect(startsOf("dev")).toHaveLength(0);
});
