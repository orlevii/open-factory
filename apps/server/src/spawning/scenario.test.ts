import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { schema } from "@open-factory/db";
import { eq } from "drizzle-orm";
import { afterEach, expect, test } from "vitest";
import { ev, FakeDriver, type FakeProcess } from "../agents/testing/fake-driver.ts";
import { callTool } from "../mcp/testing/mcp-client.ts";
import { agentRefOf, agentRowOf, makeTestApp, runtimeOf } from "../test/helpers.ts";
import { seedTestUser } from "../test/principals.ts";

let t: Awaited<ReturnType<typeof makeTestApp>> | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

/** An envelope sender is a mention; the scenario reads its handle. */
const handleOf = (from: string) => from.replace(/^<@[0-9a-z]{8}\|(.+)>$/, "@$1");
const writeTemplate = (home: string, name: string, extra = "") => {
  const d = path.join(home, "templates", name);
  mkdirSync(d, { recursive: true });
  writeFileSync(
    path.join(d, "template.yaml"),
    `name: ${name}\ndisplay_name: ${name}\nruntime: local\nprojects:\n  - app\n${extra}`,
  );
  writeFileSync(path.join(d, "AGENTS.md"), `# ${name}\n`);
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8" },
  );

test("S7 scenario: a lead spawns a pair, they collaborate, it terminates them and spawns a developer", async () => {
  const driver = new FakeDriver();
  t = await makeTestApp({
    harnessDriver: driver,
    // A debounce of 0: member updates go out at once, without waiting on a clock.
    factorySettings: { memberUpdateDebounceSeconds: 0 },
  });
  const h = t;
  await seedTestUser(h.db, "or");
  const url = `http://127.0.0.1:${h.app.agentListener.port}`;

  // The project is a real git repo with one commit.
  const repo = realpathSync(mkdtempSync(path.join(tmpdir(), "of-scn-")));
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(path.join(repo, "README.md"), "# app\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  await h.app.projects.create({ name: "app", hostPath: repo });

  writeTemplate(
    h.factoryHome,
    "lead",
    "can_spawn:\n  - tech-lead\n  - proxy-reviewer\n  - developer\n",
  );
  for (const n of ["tech-lead", "proxy-reviewer", "developer"]) writeTemplate(h.factoryHome, n);
  const credentialId = randomUUID();
  await h.db.insert(schema.credentials).values({
    id: credentialId,
    name: "scn-cred",
    kind: "oauth_token",
    valueEnc: h.app.vault.seal("test-token", `credentials:${credentialId}`),
  });
  await h.app.agents.create(
    {
      template: "lead",
      handle: "lead",
      displayName: "Lead",
      description: "",
      reportsTo: "or",
      credential: "scn-cred",
    },
    { kind: "human", ref: "k7x2m9qd", handle: "or" },
  );
  const lead = await agentRowOf(h.app, "lead");
  if (!lead) throw new Error("no lead");

  const procOf = (handle: string) => {
    const p = driver.startsOf(handle).at(-1);
    if (!p) throw new Error(`${handle} not started`);
    return p;
  };
  const tokenOf = (handle: string) => procOf(handle).spec.env.OPEN_FACTORY_AGENT_TOKEN as string;
  const settle = async (handle: string) => void (await (await runtimeOf(h.app, handle))?.settled());
  const call = async (handle: string, name: string, args: object) => {
    const r = await callTool(url, tokenOf(handle), name, args);
    return { isError: r.isError ?? false, out: JSON.parse(r.content[0]?.text ?? "null") };
  };
  /** The agent's part: opens its turn, says `text`; `endTurn` closes it. */
  const open = (p: FakeProcess, sessionId: string) => p.emit(ev.session(sessionId), ev.turn());
  const close = async (handle: string, p: FakeProcess, text?: string) => {
    if (text) p.emit(ev.text(text));
    p.emit(ev.usage(), ev.end());
    await settle(handle);
  };
  /** A batch the factory wrote starts a turn when the process says so, and the turn ends. */
  const turn = async (handle: string, p: FakeProcess, text?: string) => {
    p.emit(ev.turn());
    await close(handle, p, text);
  };
  const batches = async (handle: string) => {
    const row = await agentRowOf(h.app, handle);
    return (await h.app.store.after(row?.id ?? "", 0, 1000)).flatMap((e) =>
      e.event.type === "message_in" ? [e.event.messages] : [],
    );
  };
  const rows = async (handle: string, kind: string) => {
    const row = await agentRowOf(h.app, handle);
    return h.db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.toId, row?.id ?? ""))
      .then((r) => r.filter((m) => m.kind === kind));
  };

  // 1. The human starts the lead; it spawns the pair and names each in the other's brief.
  const { cookie } = await h.signUpUser();
  const sent = await h.app.inject({
    method: "POST",
    url: "/api/messages",
    headers: { cookie },
    payload: { to: [await agentRefOf(h.app, "lead")], body: "start" },
  });
  expect(sent.statusCode).toBeLessThan(300);
  const leadProc = procOf("lead");
  open(leadProc, "sess-lead");

  const tl = await call("lead", "spawn_agent", {
    template: "tech-lead",
    suffix: "t1",
    description: "Plans the work",
    prompt: "Plan the change and agree it with @proxy-reviewer-r1.",
  });
  const rv = await call("lead", "spawn_agent", {
    template: "proxy-reviewer",
    suffix: "r1",
    description: "Reviews the plan",
    prompt: "Review @tech-lead-t1's plan.",
  });
  expect(tl).toMatchObject({ isError: false, out: { handle: "tech-lead-t1" } });
  expect(rv).toMatchObject({ isError: false, out: { handle: "proxy-reviewer-r1" } });
  // The first child hears (held) of the second joining; the second finds the first already there.
  const joined = async (handle: string, about: string) => {
    const subject = await agentRowOf(h.app, about);
    return (await rows(handle, "peer_joined")).filter((m) => m.subjectAgentId === subject?.id);
  };
  expect(await joined("tech-lead-t1", "proxy-reviewer-r1")).toHaveLength(1);
  expect(await joined("proxy-reviewer-r1", "tech-lead-t1")).toHaveLength(0);
  await close("lead", leadProc, "Spawned the pair.");

  // 2. The tech lead (woken by its brief) messages the reviewer, who wakes and replies; the plan lands in the repo.
  await settle("tech-lead-t1");
  await settle("proxy-reviewer-r1");
  const tlProc = procOf("tech-lead-t1");
  const rvProc = procOf("proxy-reviewer-r1");
  expect(tlProc.sent.flat().some((m) => m.kind === "message" && handleOf(m.from) === "@lead")).toBe(
    true,
  );
  open(tlProc, "sess-tl");
  open(rvProc, "sess-rv");
  const ask = await call("tech-lead-t1", "send_message", {
    to: ["proxy-reviewer-r1"],
    body: "Is plan.md the right scope?",
  });
  expect(ask.isError).toBe(false);
  await close("proxy-reviewer-r1", rvProc); // the message waits for the turn boundary, then wakes it
  expect(
    rvProc.sent.flat().some((m) => m.kind === "message" && handleOf(m.from) === "@tech-lead-t1"),
  ).toBe(true);
  open(rvProc, "sess-rv");
  const reply = await call("proxy-reviewer-r1", "send_message", {
    to: ["tech-lead-t1"],
    body: "Yes, ship it.",
  });
  expect(reply.isError).toBe(false);
  await close("proxy-reviewer-r1", rvProc, "Approved the plan.");

  writeFileSync(path.join(repo, "plan.md"), "# Plan\n");
  await close("tech-lead-t1", tlProc, "Plan written to plan.md");
  expect(
    tlProc.sent
      .flat()
      .some((m) => m.kind === "message" && handleOf(m.from) === "@proxy-reviewer-r1"),
  ).toBe(true);

  // 3. The lead's next batches carry member updates from both children. The reviewer's came first and opened a turn;
  // the tech lead's was held until that turn ended.
  await settle("lead");
  await turn("lead", leadProc, "Reviewer is happy.");
  await turn("lead", leadProc, "Plan is in.");
  const updates = (await batches("lead"))
    .flat()
    .filter((m) => m.kind === "member_update")
    .map((m) => handleOf(m.from));
  expect(updates).toContain("@tech-lead-t1");
  expect(updates).toContain("@proxy-reviewer-r1");

  // 4. The lead terminates both and spawns the developer.
  leadProc.emit(ev.turn());
  for (const handle of ["tech-lead-t1", "proxy-reviewer-r1"]) {
    expect(await call("lead", "terminate_agent", { target: handle })).toMatchObject({
      isError: false,
      out: { handle, status: "terminated" },
    });
    const row = await agentRowOf(h.app, handle);
    expect(row?.terminatedAt).toBeInstanceOf(Date);
    expect(row?.runtime).toBe("local"); // no container to remove
    await settle(handle);
    expect(procOf(handle).stopped).toBe(true);
  }
  const dev = await call("lead", "spawn_agent", {
    template: "developer",
    suffix: "d1",
    description: "Implements the plan",
    prompt: "Implement plan.md",
  });
  expect(dev).toMatchObject({ isError: false, out: { handle: "developer-d1" } });
  await close("lead", leadProc);

  // 5. The developer works on its own worktree of the repo (the test stands in for its Bash tool).
  await settle("developer-d1");
  const devProc = procOf("developer-d1");
  expect(
    devProc.sent
      .flat()
      .some((m) => handleOf(m.from) === "@lead" && m.body.includes("Implement plan.md")),
  ).toBe(true);
  open(devProc, "sess-dev");
  const wt = path.join(repo, ".worktrees", "developer-d1-impl");
  git(repo, "worktree", "add", wt, "-b", "impl");
  writeFileSync(path.join(wt, "feature.txt"), "done\n");
  git(wt, "add", "-A");
  git(wt, "commit", "-q", "-m", "implement plan");
  await close("developer-d1", devProc, "Committed on impl");
  await settle("lead");
  await turn("lead", leadProc); // the developer's update opened a turn

  // 6. The result is in git, the lead heard from all three, and its own terminations left no peer_left behind.
  expect(existsSync(path.join(wt, "feature.txt"))).toBe(true);
  expect(git(repo, "log", "impl", "--oneline")).toContain("implement plan");
  await settle("lead");
  const heard = new Set(
    (await batches("lead"))
      .flat()
      .filter((m) => m.kind === "member_update")
      .map((m) => handleOf(m.from)),
  );
  expect([...heard].sort()).toEqual(["@developer-d1", "@proxy-reviewer-r1", "@tech-lead-t1"]);
  expect(await rows("lead", "peer_left")).toEqual([]);
  expect((await batches("lead")).flat().filter((m) => m.kind === "peer_left")).toEqual([]);

  const peers = await call("developer-d1", "list_peers", {});
  expect(
    peers.out.peers
      .filter((p: { kind: string }) => p.kind === "agent")
      .map((p: { handle: string; relation: string }) => [p.handle, p.relation]),
  ).toEqual([["@lead", "manager"]]);
});
