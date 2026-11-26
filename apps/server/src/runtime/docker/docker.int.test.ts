import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import net, { type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { schema } from "@open-factory/db";
import {
  createFakeClaude,
  type FakeClaude,
  type FakeLogEntry,
  type FakeScenario,
  fakeClaudeIn,
  installFakeClaude,
  type WorkdirFakeClaude,
} from "@open-factory/harness/testing";
import type { AnyEvent } from "@open-factory/shared";
import Docker from "dockerode";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, test, vi } from "vitest";
import { EventStore } from "../../agents/event-store.ts";
import { makeTestApp } from "../../test/helpers.ts";
import { seedTestUser } from "../../test/principals.ts";
import { asRunning } from "../../test/running.ts";
import { agentWorkdir } from "../../workspace/paths.ts";
import { dockerodeClient } from "./client.ts";
import { containerName, LABEL_AGENT_ID, READY_MARKER } from "./containers.ts";
import { CLAUDE_PID_FILE } from "./exec-transport.ts";

/**
 * The Docker runtime against a real daemon and the local `open-factory-base:dev` image (spec §17), through the
 * production wiring: buildApp (or the real server entry), the dockerode adapter, ContainerManager, the exec transport,
 * the Claude driver, AgentRuntimes and the Supervisor. The fake claude reaches the container through the real paths
 * only: it is copied into the agent's workdir (a checked mount at path parity), `FACTORY_DOCKER_CLAUDE_BIN` points at
 * it, and its settings are factory secrets listed in the template. Gated: `FACTORY_DOCKER_TESTS=1`.
 */

const enabled = process.env.FACTORY_DOCKER_TESTS === "1";
const docker = enabled ? describe : describe.skip;

const IMAGE = "open-factory-base:dev";
/** makeTestApp's FACTORY_SECRET_KEY: the child server must open the same vault and sessions. */
const SECRET_KEY = "t".repeat(40);
const REPO_ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));
const SERVER_ENTRY = fileURLToPath(new URL("../../index.ts", import.meta.url));

/** A turn that stays open (and a process that outlives stdin EOF) for two minutes. */
const LONG: FakeScenario = {
  onUser: [
    { emit: { fixture: "interrupt-then-message", lines: [1, 3] } },
    { longTool: 120_000 },
    { emit: { fixture: "rate-limit-event-allowed", lines: [3, 5] } },
  ],
};

type TestApp = Awaited<ReturnType<typeof makeTestApp>>;
interface World {
  t: TestApp;
  /** The live app: replaced by a reopen. */
  app: FastifyInstance;
  env: Record<string, string>;
  home: string;
  slug: string;
  agentId: string;
  workdir: string;
  fake: WorkdirFakeClaude;
  cookie: string;
}

const client = dockerodeClient();
const dk = new Docker();
const worlds: World[] = [];
const agentIds = new Set<string>();
const children: ChildProcess[] = [];
const hostFakes: FakeClaude[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const c of children.splice(0))
    if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
  for (const w of worlds.splice(0)) await w.t.close().catch(() => {});
  // Label-based: every container of an agent these tests created, whatever state a failed test left it in.
  for (const id of agentIds) {
    const listed = await dk.listContainers({
      all: true,
      filters: { label: [`${LABEL_AGENT_ID}=${id}`] },
    });
    for (const c of listed)
      await dk
        .getContainer(c.Id)
        .remove({ force: true })
        .catch(() => {});
  }
  agentIds.clear();
  // Only a host fake still running: a live pid that is a `node` or `claude` process (a finished one's pid, such as a
  // `--version` probe's, may have been reused by an unrelated process on this machine). Never a blind kill.
  for (const f of hostFakes.splice(0))
    for (const e of f.log())
      if (e.kind === "start" && !e.argv.includes("--version") && isFake(e.pid)) kill(e.pid);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
}, 90_000);

const kill = (pid: number) => {
  try {
    process.kill(pid, "SIGKILL");
  } catch {}
};
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
/** Alive, and its command (`ps -o comm=`, a path on macOS) is `node` or `claude`. */
const isFake = (pid: number) => {
  if (!alive(pid)) return false;
  try {
    const comm = execFileSync("ps", ["-o", "comm=", "-p", String(pid)])
      .toString()
      .trim();
    return ["node", "claude"].includes(path.basename(comm));
  } catch {
    return false; // gone meanwhile
  }
};
const tmp = (prefix: string) => {
  const d = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  dirs.push(d);
  return d;
};
const until = (check: () => unknown | Promise<unknown>, timeout = 30_000) =>
  vi.waitFor(check, { timeout, interval: 100 });

function writeTemplate(home: string, name: string, yaml: string) {
  const d = path.join(home, "templates", name);
  mkdirSync(d, { recursive: true });
  writeFileSync(path.join(d, "template.yaml"), `name: ${name}\ndisplay_name: ${name}\n${yaml}`);
  writeFileSync(path.join(d, "AGENTS.md"), `# ${name}\n`);
}

/** A host git repo with one commit, at its realpath (projects are stored that way). */
function gitRepo(): string {
  const repo = tmp("of-repo-");
  const git = (...a: string[]) =>
    execFileSync("git", ["-C", repo, ...a], { env: { ...process.env, LC_ALL: "C" } });
  git("init", "-q", "-b", "main");
  writeFileSync(path.join(repo, "README.md"), "# repo\n");
  git("add", ".");
  git("-c", "user.name=t", "-c", "user.email=t@x.io", "commit", "-qm", "init");
  return repo;
}

/**
 * A factory (buildApp, the real Claude driver) with one Docker agent `dock` made from a template through the agent
 * service. `local` adds the host fake for local agents.
 */
async function setup(o: {
  scenario: string | FakeScenario;
  grant?: boolean;
  local?: FakeClaude;
}): Promise<World> {
  const home = tmp("of-dint-");
  const slug = "dock";
  const workdir = agentWorkdir(home, slug);
  const cliBundle = path.join(tmp("of-cli-"), "open-factory.js");
  writeFileSync(cliBundle, "// cli\n");
  const env: Record<string, string> = {
    FACTORY_HOME: home,
    FACTORY_DEFAULT_IMAGE: IMAGE,
    // Known before the workdir exists: the fake is copied there once the agent is created.
    FACTORY_DOCKER_CLAUDE_BIN: fakeClaudeIn(workdir).bin,
    FACTORY_CLI_BUNDLE: cliBundle,
    ...(o.local ? { FACTORY_CLAUDE_BIN: o.local.bin } : {}),
  };
  const t = await makeTestApp({ env });
  await seedTestUser(t.db, "or");
  const settings = fakeClaudeIn(workdir);
  writeTemplate(
    home,
    "dock",
    "runtime: docker\nsecrets:\n  - FAKE_CLAUDE_SCENARIO\n  - FAKE_CLAUDE_DIR\n",
  );
  const credId = crypto.randomUUID();
  await t.db.insert(schema.credentials).values({
    id: credId,
    name: "work",
    kind: "oauth_token",
    valueEnc: t.app.vault.seal("tok-docker", `credentials:${credId}`),
  });
  // The fake's settings are ordinary factory secrets: they reach the exec env through buildAgentEnv.
  await t.app.secrets.put("FAKE_CLAUDE_SCENARIO", settings.scenario);
  await t.app.secrets.put("FAKE_CLAUDE_DIR", settings.dir);
  if (o.grant) await t.app.projects.create({ name: "app", hostPath: gitRepo() });
  await t.app.agents.create(
    {
      template: "dock",
      slug,
      displayName: "Dock",
      description: "",
      reportsTo: "or",
      credential: "work",
      ...(o.grant ? { projects: ["app"] } : {}),
    },
    { kind: "human", ref: "k7x2m9qd", handle: "or" },
  );
  const fake = installFakeClaude({ workdir, scenario: o.scenario });
  expect(fake.bin).toBe(env.FACTORY_DOCKER_CLAUDE_BIN);
  const agentId = await idOf(t.db, slug);
  agentIds.add(agentId);
  const cookie = (await t.signUpUser({ handle: "or" })).cookie;
  const w: World = { t, app: t.app, env, home, slug, agentId, workdir, fake, cookie };
  worlds.push(w);
  return w;
}

/**
 * A factory with a Docker spawner `lead` (may spawn `kid`, granted project `app`) and its spawned Docker agent
 * `kid-<suffix>`, started by its brief and idle. A spawned agent's workdir is created by the spawn and the brief starts
 * it at once, so the fake can't be copied there first: it lives in the project's repo instead, which the child inherits
 * as a checked read-write mount at path parity. Its settings are secrets both templates list (a child holds nothing its
 * spawner lacks).
 */
async function setupSpawned(scenario: string | FakeScenario, suffix = "a1") {
  const home = tmp("of-dspawn-");
  const repo = gitRepo();
  const cliBundle = path.join(tmp("of-cli-"), "open-factory.js");
  writeFileSync(cliBundle, "// cli\n");
  const env: Record<string, string> = {
    FACTORY_HOME: home,
    FACTORY_DEFAULT_IMAGE: IMAGE,
    FACTORY_DOCKER_CLAUDE_BIN: fakeClaudeIn(repo).bin,
    FACTORY_CLI_BUNDLE: cliBundle,
  };
  const t = await makeTestApp({ env });
  await seedTestUser(t.db, "or");
  const fake = installFakeClaude({ workdir: repo, scenario });
  expect(fake.bin).toBe(env.FACTORY_DOCKER_CLAUDE_BIN);
  const secrets = "secrets:\n  - FAKE_CLAUDE_SCENARIO\n  - FAKE_CLAUDE_DIR\n";
  writeTemplate(home, "lead", `runtime: docker\ncan_spawn:\n  - kid\n${secrets}`);
  writeTemplate(home, "kid", `runtime: docker\nprojects:\n  - app\n${secrets}`);
  const credId = crypto.randomUUID();
  await t.db.insert(schema.credentials).values({
    id: credId,
    name: "work",
    kind: "oauth_token",
    valueEnc: t.app.vault.seal("tok-docker", `credentials:${credId}`),
  });
  await t.app.secrets.put("FAKE_CLAUDE_SCENARIO", fake.secrets.FAKE_CLAUDE_SCENARIO);
  await t.app.secrets.put("FAKE_CLAUDE_DIR", fake.secrets.FAKE_CLAUDE_DIR);
  await t.app.projects.create({ name: "app", hostPath: repo });
  await t.app.agents.create(
    {
      template: "lead",
      slug: "lead",
      displayName: "Lead",
      description: "",
      reportsTo: "or",
      credential: "work",
      projects: ["app"],
    },
    { kind: "human", ref: "k7x2m9qd", handle: "or" },
  );
  const leadId = await idOf(t.db, "lead");
  agentIds.add(leadId);
  // I2 §6.2: spawning follows the spawner's running process.
  const leadRow = await t.app.store.agentById(leadId);
  if (!leadRow) throw new Error("no lead");
  await asRunning(t.app, leadRow);
  const cookie = (await t.signUpUser({ handle: "or" })).cookie;

  const r = await t.app.spawner.spawn(
    leadId,
    { template: "kid", description: "Does the work", prompt: "Do it", suffix },
    null,
  );
  if (!r.ok) throw new Error(r.message);
  agentIds.add(r.agentId);
  const w: World = {
    t,
    app: t.app,
    env,
    home,
    slug: r.slug,
    agentId: r.agentId,
    workdir: agentWorkdir(home, r.slug),
    fake,
    cookie,
  };
  worlds.push(w);
  // The brief started it: its first turn ends and it is idle, its container running.
  await until(async () => expect((await runtime(w)).live().status).toBe("idle"));
  expect((await inspect(w)).State.Running).toBe(true);
  return w;
}

/** Every container labelled with the agent's id, in any state. */
const labelled = (agentId: string) =>
  dk.listContainers({ all: true, filters: { label: [`${LABEL_AGENT_ID}=${agentId}`] } });

const idOf = async (db: TestApp["db"], slug: string) => {
  const [r] = await db
    .select({ id: schema.agents.id })
    .from(schema.agents)
    .where(eq(schema.agents.slug, slug));
  if (!r) throw new Error(`no agent ${slug}`);
  return r.id;
};

const runtime = async (w: World, slug = w.slug) => {
  const rt = await w.app.runtimes.bySlug(slug);
  if (!rt) throw new Error(`no runtime ${slug}`);
  return rt;
};
const post = async (w: World, body = "hi", slug = w.slug) => {
  const res = await w.app.inject({
    method: "POST",
    url: `/api/messages`,
    headers: { cookie: w.cookie },
    payload: { to: [slug], body, urgent: false },
  });
  expect(res.statusCode).toBe(202);
};
const events = async (w: World, agentId = w.agentId): Promise<AnyEvent[]> =>
  (await w.app.store.after(agentId, 0, 1000)).map((e) => e.event as AnyEvent);
const starts = (log: FakeLogEntry[]) =>
  log.flatMap((e) => (e.kind === "start" && !e.argv.includes("--version") ? [e] : []));
const exits = (log: FakeLogEntry[]) => log.flatMap((e) => (e.kind === "exit" ? [e.code] : []));

const name = (w: World) => containerName(w.slug, w.agentId);
const inspect = (w: World) => dk.getContainer(name(w)).inspect();
const exec = async (w: World, cmd: string[], user = "agent") =>
  client.execRun((await inspect(w)).Id, { cmd, user });
/** Lists /proc as `pid<TAB>comm<TAB>cmdline` lines (a fixed script: no host value is interpolated). */
const LIST_PROCS = [
  "for p in /proc/[0-9]*; do",
  'printf "%s\\t%s\\t%s\\n" "$(basename $p)" "$(cat $p/comm 2>/dev/null)"',
  '"$(tr "\\0" " " < $p/cmdline 2>/dev/null)"; done',
].join(" ");
/** Every process in the container: pid, comm and command line. */
async function procs(w: World): Promise<{ pid: number; comm: string; cmd: string }[]> {
  const r = await exec(w, ["sh", "-c", LIST_PROCS], "root");
  return r.stdout
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [pid, comm, cmd] = l.split("\t");
      return { pid: Number(pid), comm: comm ?? "", cmd: cmd ?? "" };
    });
}
const claudes = async (w: World) => (await procs(w)).filter((p) => p.comm === "claude");
const pidFile = async (w: World) => Number((await exec(w, ["cat", CLAUDE_PID_FILE])).stdout.trim());

async function idle(w: World, body = "hi") {
  await post(w, body);
  await until(async () => expect((await runtime(w)).live().status).toBe("idle"));
}
async function turnOpen(w: World, body = "long job") {
  await post(w, body);
  await until(async () => expect((await runtime(w)).live().turnOpen).toBe(true));
}

docker("Docker runtime (open-factory-base:dev, fake claude)", { timeout: 120_000 }, () => {
  test("hardened container: ready marker, -u agent, sudo fails", async () => {
    const w = await setup({ scenario: "reply" });
    await idle(w);

    const c = await inspect(w);
    expect(c.State.Running).toBe(true);
    expect(c.HostConfig.SecurityOpt).toEqual(["no-new-privileges:true"]);
    expect(c.HostConfig.Privileged).toBe(false);
    expect(c.HostConfig.CapAdd ?? []).toEqual([]);
    expect(c.HostConfig.NetworkMode).not.toBe("host");
    expect(c.HostConfig.PidMode ?? "").toBe("");
    expect(c.HostConfig.Tmpfs).toEqual({ "/run/open-factory": "" });
    expect(c.HostConfig.ExtraHosts).toEqual(["host.docker.internal:host-gateway"]);
    const sources = (c.Mounts ?? []).map((m) => m.Source);
    expect(sources).toContain(w.workdir);
    for (const s of sources) {
      expect(s).not.toMatch(/docker\.sock/);
      expect(s).not.toBe(process.env.HOME);
    }
    expect(c.Config.Env).toEqual(
      expect.arrayContaining([`HOST_UID=${process.getuid?.()}`, `HOST_GID=${process.getgid?.()}`]),
    );

    // The ready marker the start waited for; agent remapped to the host user; no privilege escalation.
    expect((await exec(w, ["test", "-f", READY_MARKER], "root")).code).toBe(0);
    expect((await exec(w, ["id", "-u"])).stdout.trim()).toBe(String(process.getuid?.()));
    expect((await exec(w, ["sudo", "-n", "true"])).code).not.toBe(0);

    // Claude runs as agent, is the pid in the pid file, and its comm is `claude` (the terminate check).
    const pid = await pidFile(w);
    expect(await claudes(w)).toEqual([expect.objectContaining({ pid })]);
    expect((await exec(w, ["stat", "-c", "%U", `/proc/${pid}`])).stdout.trim()).toBe("agent");
    expect((await exec(w, ["readlink", `/proc/${pid}/cwd`])).stdout.trim()).toBe(w.workdir);

    // Its env is buildAgentEnv's: the credential, the secrets, no server env.
    const [start] = starts(w.fake.log());
    expect(start?.env).toMatchObject({
      CLAUDE_CODE_OAUTH_TOKEN: "tok-docker",
      CLAUDE_CONFIG_DIR: path.join(w.workdir, ".claude-config"),
      FAKE_CLAUDE_DIR: w.fake.dir,
      // The agent listener's port: the OS chooses it for the test app.
      OPEN_FACTORY_URL: `http://host.docker.internal:${w.app.agentListener.port}`,
    });
    for (const k of ["DATABASE_URL", "FACTORY_SECRET_KEY", "FACTORY_HOME"])
      expect(start?.env).not.toHaveProperty(k);
  });

  test("exec round trip: envelope in, events out, half-close exits", async () => {
    const w = await setup({ scenario: "reply" });
    await idle(w, "hello");

    const stdin = w.fake
      .log()
      .flatMap((e) =>
        e.kind === "stdin" && JSON.parse(e.line).type === "user" ? [JSON.parse(e.line)] : [],
      );
    expect(stdin).toHaveLength(1);
    expect(stdin[0].message.content).toMatch(
      /^<factory-message from="@or" from_kind="human" kind="message" to="@[a-z0-9-]+" urgent="false" id="[0-9a-f-]+">\nhello\n<\/factory-message>$/,
    );
    const types = (await events(w)).map((e) => e.type);
    expect(types).toEqual([
      "container",
      "process_started",
      "message_in",
      "session_started",
      // The fake replays a recorded init that lists no MCP servers (it never connects to the factory MCP), so the
      // runtime reports it unavailable, as assembled.test.ts expects too.
      "mcp_unavailable",
      "turn_started",
      "assistant_text",
      "usage",
      "turn_end",
    ]);
    expect((await events(w))[0]).toMatchObject({
      type: "container",
      action: "created",
      image: IMAGE,
    });

    // Half-close: stdin EOF reaches Claude through the hijacked stream, it exits 0, and the code comes back.
    expect(await (await runtime(w)).hibernate("warm_window")).toBe(true);
    await until(async () => expect((await events(w)).at(-1)).toMatchObject({ type: "hibernated" }));
    expect(exits(w.fake.log())).toEqual([0]);
    expect(await events(w)).toContainEqual(
      expect.objectContaining({ type: "exited", code: 0, signal: null, expected: true }),
    );
  });

  test("terminate via the pid file stops claude (143)", async () => {
    const w = await setup({ scenario: LONG });
    await turnOpen(w);
    const pid = await pidFile(w);
    expect((await exec(w, ["cat", `/proc/${pid}/comm`])).stdout.trim()).toBe("claude");

    // stdin closes, the long tool keeps Claude busy past the grace: terminate SIGTERMs it through the pid file.
    await (await runtime(w)).stop({ graceMs: 300, termWaitMs: 10_000 });
    expect(exits(w.fake.log())).toEqual([143]);
    const evs = await events(w);
    expect(evs).toContainEqual(
      expect.objectContaining({ type: "exited", code: 143, expected: true }),
    );
    expect(evs.map((e) => e.type)).not.toContain("stop_escalated");
    expect((await inspect(w)).State.Running).toBe(false);
  });

  test("a forged pid file: terminate refuses, the escalation stops the container", async () => {
    const w = await setup({ scenario: LONG });
    await turnOpen(w);
    // The agent owns the pid file: it can point it at another of its processes. The comm check refuses it.
    expect((await exec(w, ["sh", "-c", "nohup sleep 300 >/dev/null 2>&1 &"])).code).toBe(0);
    let decoy: number | undefined;
    await until(async () => {
      decoy = (await procs(w)).find((p) => p.cmd.startsWith("sleep 300"))?.pid;
      expect(decoy).toBeDefined();
    });
    expect((await exec(w, ["sh", "-c", `echo ${decoy} > ${CLAUDE_PID_FILE}`])).code).toBe(0);

    const stopping = (await runtime(w)).stop({ graceMs: 200, termWaitMs: 3_000 });
    // Past the grace and terminate, before the escalation: the decoy wasn't signalled, Claude still runs.
    await new Promise((r) => setTimeout(r, 1_500));
    expect((await procs(w)).map((p) => p.pid)).toEqual(expect.arrayContaining([decoy]));
    expect(await claudes(w)).toHaveLength(1);
    await stopping;
    const evs = await events(w);
    expect(evs).toContainEqual({ type: "stop_escalated", how: "container_stop" });
    // Killed with the container's namespace, never SIGTERMed by terminate: the fake logged no exit.
    expect(exits(w.fake.log())).toEqual([]);
    expect((await inspect(w)).State.Running).toBe(false);
    expect((await runtime(w)).live()).toMatchObject({ status: "hibernated" });
  });

  test("hibernate stops the container; a grant change re-creates it", async () => {
    const w = await setup({ scenario: "reply" });
    await idle(w);
    const first = await inspect(w);
    expect(await (await runtime(w)).hibernate("warm_window")).toBe(true);
    await until(async () => expect((await inspect(w)).State.Running).toBe(false));
    expect((await inspect(w)).Id).toBe(first.Id); // stopped, not removed

    // The same spec: the stopped container is reused.
    await idle(w, "again");
    expect((await inspect(w)).Id).toBe(first.Id);
    expect((await events(w)).filter((e) => e.type === "container").at(-1)).toMatchObject({
      action: "started",
    });
    expect(await (await runtime(w)).hibernate("warm_window")).toBe(true);
    await until(async () => expect((await inspect(w)).State.Running).toBe(false));

    // A new grant changes the mounts, so the spec hash: the next start re-creates the container.
    const repo = gitRepo();
    await w.app.projects.create({ name: "app", hostPath: repo });
    await w.app.agents.update(
      w.slug,
      { projects: ["app"] },
      { kind: "human", ref: "k7x2m9qd", handle: "or" },
    );
    await idle(w, "with a project");
    const next = await inspect(w);
    expect(next.Id).not.toBe(first.Id);
    expect((next.Mounts ?? []).map((m) => m.Source)).toContain(repo);
    expect((await events(w)).filter((e) => e.type === "container").at(-1)).toMatchObject({
      action: "recreated",
    });
    await expect(dk.getContainer(first.Id).inspect()).rejects.toMatchObject({ statusCode: 404 });
  });

  test("crash: container stopped, the planted background sleep is gone, one notice-led resume", async () => {
    const w = await setup({ scenario: LONG });
    await turnOpen(w);
    // A background process the agent left in its container.
    expect((await exec(w, ["sh", "-c", "nohup sleep 300 >/dev/null 2>&1 &"])).code).toBe(0);
    await until(async () =>
      expect((await procs(w)).some((p) => p.cmd.startsWith("sleep 300"))).toBe(true),
    );
    const before = (await inspect(w)).State.StartedAt;

    expect((await exec(w, ["kill", "-KILL", String(await pidFile(w))])).code).toBe(0);
    await until(async () =>
      expect((await events(w)).filter((e) => e.type === "process_started")).toHaveLength(2),
    );

    const evs = await events(w);
    expect(evs).toContainEqual(expect.objectContaining({ type: "exited", expected: false }));
    expect(evs).toContainEqual({ type: "cleanup", container: "stopped" });
    expect(evs.filter((e) => e.type === "process_started").at(-1)).toMatchObject({
      reason: "crash_recovery",
      resumed: true,
    });
    // The container was stopped (and started again for the recovery): the sleep went with it.
    expect((await inspect(w)).State.StartedAt).not.toBe(before);
    expect((await procs(w)).some((p) => p.cmd.startsWith("sleep 300"))).toBe(false);

    // One resume, led by the crash notice.
    await until(() =>
      expect(
        w.fake.log().filter((e) => e.kind === "stdin" && JSON.parse(e.line).type === "user").length,
      ).toBeGreaterThanOrEqual(2),
    );
    const log = w.fake.log();
    const [, resumed] = starts(log);
    expect(starts(log)).toHaveLength(2);
    expect(resumed?.argv).toContain("--resume");
    const afterResume = log.slice(log.indexOf(resumed as FakeLogEntry));
    const first = afterResume.find((e) => e.kind === "stdin" && JSON.parse(e.line).type === "user");
    expect(first?.kind === "stdin" && JSON.parse(first.line).message.content).toMatch(
      /^<factory-message from="@factory" from_kind="factory" kind="system"[^>]*>\nYour previous process stopped unexpectedly \(exit code 137\) during a turn\./,
    );
    expect(await claudes(w)).toHaveLength(1);
  });

  test("a file written through a project mount is owned by the host user; git worktree list matches", async () => {
    const w = await setup({ scenario: "reply", grant: true });
    await idle(w);
    const [project] = await w.app.projects.list();
    const repo = project?.hostPath ?? "";
    expect(repo).not.toBe("");

    const file = path.join(repo, "from-agent.txt");
    expect((await exec(w, ["sh", "-c", `echo hi > '${file}'`])).code).toBe(0);
    const st = statSync(file);
    expect(st.uid).toBe(process.getuid?.());
    expect(st.gid).toBe(process.getgid?.());
    // Docker Desktop's file sharing maps every write to the host user, so the host-side owner alone can't tell
    // whether the remap happened; on a Linux engine it can. The writer's own uid is the host user's either way.
    expect((await exec(w, ["id", "-u"])).stdout.trim()).toBe(String(process.getuid?.()));
    expect((await exec(w, ["stat", "-c", "%u", file])).stdout.trim()).toBe(
      String(process.getuid?.()),
    );

    const wt = path.join(repo, ".worktrees", "dock-feature");
    const add = await exec(w, ["git", "-C", repo, "worktree", "add", "-q", "-b", "feature", wt]);
    expect(add.code).toBe(0);
    expect(statSync(wt).uid).toBe(process.getuid?.());
    const inContainer = (await exec(w, ["git", "-C", repo, "worktree", "list"])).stdout;
    const onHost = execFileSync("git", ["-C", repo, "worktree", "list"]).toString();
    expect(inContainer).toContain(wt);
    expect(inContainer).toBe(onHost);
  });

  test("boot reconciliation stops a running labelled container", async () => {
    const w = await setup({ scenario: "reply" });
    await idle(w);
    await w.app.close(); // shutdown: the container is stopped
    expect((await inspect(w)).State.Running).toBe(false);
    // What a server that died leaves behind: the agent's container still running.
    await dk.getContainer(name(w)).start();
    expect((await inspect(w)).State.Running).toBe(true);

    w.app = (await w.t.reopen({ env: w.env })).app;
    expect((await inspect(w)).State.Running).toBe(false);
    expect(await events(w)).toContainEqual({
      type: "reconciled",
      killedProcesses: 0,
      stoppedContainer: true,
    });
  });

  test("a container left running by a dropped exec is stopped before the next start", async () => {
    const w = await setup({ scenario: "reply" });
    await idle(w);
    expect(await (await runtime(w)).hibernate("warm_window")).toBe(true);
    await until(async () => expect((await inspect(w)).State.Running).toBe(false));

    // The container running again with a Claude whose exec lost its client (stdin a pipe nobody closes).
    await dk.getContainer(name(w)).start();
    await until(async () =>
      expect((await exec(w, ["test", "-f", READY_MARKER], "root")).code).toBe(0),
    );
    const env = `FAKE_CLAUDE_SCENARIO='${w.fake.secrets.FAKE_CLAUDE_SCENARIO}' FAKE_CLAUDE_DIR='${w.fake.dir}'`;
    await exec(w, [
      "sh",
      "-c",
      `cd '${w.workdir}' && sleep 300 | ${env} '${w.fake.bin}' -p >/dev/null 2>&1 &`,
    ]);
    await until(async () => expect(await claudes(w)).toHaveLength(1));
    const [orphan] = await claudes(w);
    const startedAt = (await inspect(w)).State.StartedAt;

    await idle(w, "after the drop");
    // Stopped before the start (spec §10 step 2), then started again for the new exec: only the new Claude runs.
    expect((await inspect(w)).State.StartedAt).not.toBe(startedAt);
    const now = await claudes(w);
    expect(now).toHaveLength(1);
    expect(now[0]?.pid).toBe(await pidFile(w));
    expect(now[0]?.pid === orphan?.pid && now[0]?.cmd === orphan?.cmd).toBe(false);
    expect((await procs(w)).some((p) => p.cmd.startsWith("sleep 300"))).toBe(false);
    expect((await events(w)).filter((e) => e.type === "container").at(-1)).toMatchObject({
      action: "started",
    });
  });

  test("terminate removes a spawned agent's container and gives its slot back", async () => {
    const w = await setupSpawned("reply");
    expect(await labelled(w.agentId)).toHaveLength(1);
    expect(w.app.runtimes.supervisor.running().count).toBe(1);

    expect(await w.app.terminator.terminate(w.agentId, await seedTestUser(w.app.db, "or"))).toEqual(
      { status: "terminated" },
    );
    // The stop and the removal run in the background (spec §8 step 3): the container goes, running or not.
    await until(async () => expect(await labelled(w.agentId)).toEqual([]));
    await until(() => expect(w.app.runtimes.supervisor.running().count).toBe(0));
    await expect(inspect(w)).rejects.toMatchObject({ statusCode: 404 });

    const evs = await events(w);
    expect(evs.filter((e) => e.type === "terminated")).toEqual([{ type: "terminated", by: "@or" }]);
    expect(exits(w.fake.log())).toEqual([0]);
    expect(w.app.runtimes.statusOf({ id: w.agentId, status: "hibernated" })).toBe("terminated");
  });

  test.each(["stopped", "running"] as const)(
    "boot removes a terminated agent's leftover container (%s)",
    async (state) => {
      const w = await setupSpawned("reply");
      expect(await (await runtime(w)).hibernate("warm_window")).toBe(true);
      await until(async () => expect((await inspect(w)).State.Running).toBe(false));
      const { Id } = await inspect(w);
      await w.app.close();
      // What a server that died leaves behind: the container still running (or stopped, as the hibernate left it).
      if (state === "running") await dk.getContainer(Id).start();
      expect((await inspect(w)).State.Running).toBe(state === "running");

      // The termination committed with no app running (so no runtime loaded): exactly the state a crash between the
      // commit and the stop leaves (spec §8 crash safety). No `terminated` event, the container still there.
      const store = new EventStore(w.t.db);
      await w.t.db.transaction((tx) => store.terminateRows(tx, w.agentId, "@or"));
      expect(await store.hasTerminatedEvent(w.agentId)).toBe(false);

      w.app = (await w.t.reopen({ env: w.env })).app;
      // Boot reconciliation, before the app is returned: the container is gone, the event appended once, no slot held.
      expect(await labelled(w.agentId)).toEqual([]);
      await expect(dk.getContainer(Id).inspect()).rejects.toMatchObject({ statusCode: 404 });
      const evs = await events(w);
      expect(evs.filter((e) => e.type === "terminated")).toEqual([
        { type: "terminated", by: "@or" },
      ]);
      expect(evs.map((e) => e.type)).not.toContain("reconciled");
      expect(w.app.runtimes.supervisor.running().count).toBe(0);
      expect(starts(w.fake.log())).toHaveLength(1);
    },
  );

  test("server restart invariant: one claude per agent (local and Docker)", async () => {
    const local = createFakeClaude({ scenario: LONG });
    hostFakes.push(local);
    const w = await setup({ scenario: LONG, local });
    writeTemplate(w.home, "loc", "runtime: local\n");
    await w.app.agents.create(
      {
        template: "loc",
        slug: "loc",
        displayName: "Loc",
        description: "",
        reportsTo: "or",
        credential: "work",
      },
      { kind: "human", ref: "k7x2m9qd", handle: "or" },
    );
    const locId = await idOf(w.t.db, "loc");
    await w.app.close();

    // The real server entry in a child process, killed mid-turn: what a crash leaves is real.
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const child = spawn(process.execPath, ["--import", "tsx", SERVER_ENTRY], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        DATABASE_URL: w.t.config.databaseUrl,
        FACTORY_SECRET_KEY: SECRET_KEY,
        FACTORY_HOST_CLAUDE_DIR: w.t.config.hostClaudeDir,
        FACTORY_ALLOW_LOCAL_RUNTIME: "true",
        ...w.env,
        PORT: String(port),
        HOST: "127.0.0.1",
        LOG_LEVEL: "silent",
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    children.push(child);
    let stderr = "";
    child.stderr?.on("data", (d) => {
      stderr += String(d);
    });
    const api = (p: string, init?: RequestInit) =>
      fetch(`${base}${p}`, {
        ...init,
        headers: { cookie: w.cookie, "content-type": "application/json", ...init?.headers },
      });
    await until(async () => {
      expect(child.exitCode, stderr).toBeNull();
      expect((await fetch(`${base}/api/status`).catch(() => undefined))?.ok).toBe(true);
    }, 60_000);
    for (const slug of ["dock", "loc"]) {
      const res = await api(`/api/messages`, {
        method: "POST",
        body: JSON.stringify({ to: [slug], body: "long job", urgent: false }),
      });
      expect(res.status).toBe(202);
    }
    for (const slug of ["dock", "loc"])
      await until(async () =>
        expect(
          ((await (await api(`/api/agents/${slug}`)).json()) as { agent: { turnOpen: boolean } })
            .agent.turnOpen,
        ).toBe(true),
      );
    const localPid = starts(local.log())[0]?.pid ?? 0;
    const dockerPid = await pidFile(w);
    expect(alive(localPid)).toBe(true);
    expect(await claudes(w)).toEqual([expect.objectContaining({ pid: dockerPid })]);

    child.kill("SIGKILL");
    await once(child, "exit");
    // Both Claudes outlive their server: the local one on the host, the Docker one in its running container.
    expect(alive(localPid)).toBe(true);
    expect(await claudes(w)).toEqual([expect.objectContaining({ pid: dockerPid })]);

    // The next boot reaps and stops the leftovers before any wake, then resumes each agent once.
    w.app = (await w.t.reopen({ env: { ...w.env } })).app;
    expect(alive(localPid)).toBe(false);
    const locEvents = await events(w, locId);
    expect(locEvents).toContainEqual({
      type: "reconciled",
      killedProcesses: 1,
      stoppedContainer: false,
    });
    expect(await events(w)).toContainEqual({
      type: "reconciled",
      killedProcesses: 0,
      stoppedContainer: true,
    });
    for (const id of [w.agentId, locId])
      await until(async () =>
        expect(
          (await events(w, id)).filter((e) => e.type === "process_started").at(-1),
        ).toMatchObject({ reason: "boot_resume", resumed: true }),
      );
    for (const slug of ["dock", "loc"])
      await until(async () => expect((await runtime(w, slug)).live().turnOpen).toBe(true));

    // Exactly one Claude per agent.
    const localStarts = starts(local.log()).map((s) => s.pid);
    expect(localStarts).toHaveLength(2);
    expect(localStarts.filter(alive)).toEqual([localStarts[1]]);
    const now = await claudes(w);
    expect(now).toHaveLength(1);
    expect(now[0]?.pid).toBe(await pidFile(w));
    expect(starts(w.fake.log())).toHaveLength(2);
  });
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as AddressInfo;
      s.close(() => resolve(port));
    });
  });
}
