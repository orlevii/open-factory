import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type AgentRow, schema } from "@open-factory/db";
import { createClaudeDriver, localTransport } from "@open-factory/harness";
import { createFakeClaude, type FakeScenario } from "@open-factory/harness/testing";
import { type AnyEvent, templateYamlSchema } from "@open-factory/shared";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import { loadConfig } from "../config.ts";
import { Vault } from "../crypto/vault.ts";
import { Neighborhood } from "../messaging/neighborhood.ts";
import {
  ContainerManager,
  containerName,
  LABEL_AGENT_ID,
  LABEL_CLAUDE_CODE_VERSION,
} from "../runtime/docker/containers.ts";
import {
  CLAUDE_PID_FILE,
  CLAUDE_WRAPPER,
  dockerTransport,
} from "../runtime/docker/exec-transport.ts";
import { FakeDockerClient } from "../runtime/docker/testing/fake-docker.ts";
import { TemplateIndex } from "../templates/template-index.ts";
import { claimTestHandle, claimTestHandleSql } from "../test/handles.ts";
import { createTestDb } from "../test/helpers.ts";
import { hostOnlyLibrary } from "../test/library.ts";
import { KeyedMutex } from "../workspace/lock.ts";
import { Workspace } from "../workspace/workspace.ts";
import type { AgentRuntime } from "./agent-runtime.ts";
import { ConfigResolver } from "./config-resolver.ts";
import { EventBus } from "./event-bus.ts";
import { EventStore } from "./event-store.ts";
import { liveCredentialId } from "./live-credential.ts";
import { AgentRuntimes } from "./runtimes.ts";
import { createPrepareStart, type PrepareStart } from "./start.ts";
import { noForward, noopTokens, sendAs, silentLog } from "./testing/runtime-harness.ts";

/**
 * The Docker start path end to end over a fake Docker daemon (spec §10, §11): the real prepareStart, Workspace,
 * checkMounts, ContainerManager, exec transport, ClaudeProcess and Supervisor. The fake daemon runs each exec's
 * claude path as a local child (the fake claude), so no test seam exists in production code.
 */

const KEY = "k".repeat(40);
const IMAGE = "open-factory-base:dev";
const vault = new Vault(KEY);
let t: Awaited<ReturnType<typeof createTestDb>>;
let store: EventStore;
let seq = 0;

beforeAll(async () => {
  t = await createTestDb();
  store = new EventStore(t.db);
  await claimTestHandleSql(t.sql, "or", "user");
  await t.sql`insert into users (id, name, email, handle) values ('u1', 'Or', 'or@x.io', 'or')`;
});
afterAll(() => t.close());

/** The long-tool scenario keeps a turn open (and the process alive past stdin EOF) for 30 s. */
const LONG: FakeScenario = {
  onUser: [
    { emit: { fixture: "interrupt-then-message", lines: [1, 3] } },
    { longTool: 30_000 },
    { emit: { fixture: "rate-limit-event-allowed", lines: [3, 5] } },
  ],
};

interface World {
  docker: FakeDockerClient;
  containers: ContainerManager;
  runtimes: AgentRuntimes;
  rt: AgentRuntime;
  agent: AgentRow;
  workspace: Workspace;
  prepareStart: PrepareStart;
  cliBundle: string;
  fakeBin: string;
  fakeLog: () => { kind: string; code?: number }[];
  workdir: string;
}
let world: World | undefined;
const extra: ChildProcess[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  if (world) {
    world.runtimes.supervisor.close();
    world.docker.killAll();
    await world.rt.settled();
  }
  for (const c of extra.splice(0)) c.kill("SIGKILL");
  world = undefined;
});

async function setup(scenario: string | FakeScenario = "reply", image?: string): Promise<World> {
  seq += 1;
  await t.sql`delete from agents`;
  await t.sql`delete from templates`;
  await t.sql`delete from credentials`;
  const home = realpathSync(mkdtempSync(path.join(tmpdir(), "of-dstart-")));
  const hs = realpathSync(mkdtempSync(path.join(tmpdir(), "hs-")));
  const cliBundle = path.join(realpathSync(mkdtempSync(path.join(tmpdir(), "cli-"))), "of.js");
  writeFileSync(cliBundle, "//");
  const slug = `dock-${seq}`;
  const config = templateYamlSchema.parse({
    name: "dock",
    display_name: "Dock",
    runtime: "docker",
    ...(image ? { image } : {}),
    skills: [],
    plugins: [],
  });
  const tdir = path.join(home, "templates/dock");
  mkdirSync(tdir, { recursive: true });
  writeFileSync(path.join(tdir, "AGENTS.md"), "# Dock\n");
  // A user image the template names has its Dockerfile (or the template doesn't validate); built or not is per test.
  if (image) {
    mkdirSync(path.join(home, "images", image), { recursive: true });
    writeFileSync(path.join(home, "images", image, "Dockerfile"), "FROM scratch\n");
  }
  writeFileSync(
    path.join(tdir, "template.yaml"),
    JSON.stringify({
      name: "dock",
      display_name: "Dock",
      runtime: "docker",
      ...(image ? { image } : {}),
      skills: [],
      plugins: [],
    }),
  );
  await t.db.insert(schema.credentials).values({
    id: "c1",
    name: "work",
    kind: "oauth_token",
    valueEnc: vault.seal("tok-1", "credentials:c1"),
  });
  await claimTestHandle(t.db, slug, "agent");
  const [agent] = await t.db
    .insert(schema.agents)
    .values({
      id: `0123abcd-${seq}`,
      slug,
      displayName: "Dock",
      template: "dock",
      config: {},
      runtime: "docker",
      credentialId: "c1",
    })
    .returning();
  if (!agent) throw new Error("seed failed");
  const lock = new KeyedMutex();
  const fake = createFakeClaude({ scenario });
  const library = hostOnlyLibrary(hs, home);
  const workspace = new Workspace({
    factoryHome: home,
    library,
    claudeBin: fake.bin,
    cliBundle,
    lock,
  });
  const input = {
    slug,
    displayName: "Dock",
    description: "",
    template: "dock",
    config,
    manager: null,
    grants: [],
  };
  await workspace.materialize(
    agent.id,
    slug,
    { dir: tdir, config, tplSettings: {}, tplMcp: { mcpServers: {} } },
    input,
  );
  const factoryConfig = loadConfig({
    DATABASE_URL: t.url,
    FACTORY_SECRET_KEY: KEY,
    FACTORY_HOME: home,
    FACTORY_DEFAULT_IMAGE: IMAGE,
    FACTORY_DOCKER_CLAUDE_BIN: fake.bin,
    FACTORY_CLI_BUNDLE: cliBundle,
    LOG_LEVEL: "silent",
  });
  const docker = new FakeDockerClient();
  docker.images.set(IMAGE, {
    id: "sha256:img1",
    labels: { [LABEL_CLAUDE_CODE_VERSION]: "2.1.327" },
  });
  // A non-root host user whatever runs the tests.
  const containers = new ContainerManager({ docker, log: silentLog, uid: 501, gid: 20 });
  const realPrepare = workspace.prepare.bind(workspace);
  vi.spyOn(workspace, "prepare").mockImplementation(async (i) => {
    docker.mark("prepare");
    return realPrepare(i);
  });
  const prepareStart = createPrepareStart({
    db: t.db,
    config: factoryConfig,
    vault,
    workspace,
    resolver: new ConfigResolver({
      templates: new TemplateIndex({ db: t.db, config: factoryConfig, library }),
      library,
    }),
    lock,
    containers,
    neighborhood: new Neighborhood(t.db),
  });
  const runtimes = new AgentRuntimes({
    tokens: noopTokens,
    forward: noForward,
    store,
    bus: new EventBus(),
    driver: createClaudeDriver({
      transports: { local: localTransport, docker: dockerTransport({ docker, containers }) },
    }),
    prepareStart,
    log: silentLog,
    docker: {
      containers,
      claudeBin: factoryConfig.dockerClaudeBin,
      defaultImage: IMAGE,
      resolver: new ConfigResolver({
        templates: new TemplateIndex({ db: t.db, config: factoryConfig, library }),
        library,
      }),
    },
  });
  const rt = await runtimes.bySlug(slug);
  if (!rt) throw new Error("no runtime");
  world = {
    docker,
    containers,
    runtimes,
    rt,
    agent,
    workspace,
    prepareStart,
    cliBundle,
    fakeBin: fake.bin,
    fakeLog: () => fake.log(),
    workdir: workspace.workdir(slug),
  };
  return world;
}

const send = (w: World, body = "hi") =>
  sendAs(store, w.rt, { fromUserId: "u1", fromHandle: "or", body, urgent: false });
const events = async (w: World): Promise<AnyEvent[]> =>
  (await store.after(w.agent.id, 0, 1000)).map((e) => e.event as AnyEvent);
const until = (check: () => unknown | Promise<unknown>) =>
  vi.waitFor(check, { timeout: 10_000, interval: 20 });
const execs = (w: World) => w.docker.calls.filter((c) => c.op === "execStream");
const execRuns = (w: World) =>
  w.docker.calls
    .filter((c) => c.op === "execRun")
    .map((c) => (c.args[1] as { cmd: string[]; user: string }).cmd);
const container = (w: World) => w.docker.containers.get(containerName(w.agent.slug, w.agent.id));

/** A started agent whose turn ended. */
async function idleAgent(w: World) {
  await send(w);
  await until(() => expect(w.rt.live().status).toBe("idle"));
}

test("a Docker wake stops a running container, prepares, ensures, then execs", async () => {
  const w = await setup();
  // A container left running (a missed reconciliation): it must be stopped before anything is prepared.
  const left = await w.docker.create({
    name: containerName(w.agent.slug, w.agent.id),
    Labels: { [LABEL_AGENT_ID]: w.agent.id },
  });
  await w.docker.start(left);
  w.docker.calls = [];

  await idleAgent(w);

  const ops = w.docker.ops();
  const stop = ops.indexOf("stop");
  expect(w.docker.calls[stop]?.args).toEqual([left, 5]);
  expect(stop).toBeLessThan(ops.indexOf("prepare"));
  expect(ops.indexOf("prepare")).toBeLessThan(ops.indexOf("create"));
  expect(ops.indexOf("create")).toBeLessThan(ops.lastIndexOf("start"));
  expect(ops.lastIndexOf("start")).toBeLessThan(ops.indexOf("execStream"));
  expect(ops).toContain("remove"); // the left container's spec hash didn't match: re-created

  const [exec] = execs(w);
  const o = exec?.args[1] as { cmd: string[]; user: string; workdir: string; env: string[] };
  expect(exec?.args[0]).toBe(container(w)?.id);
  expect(o.user).toBe("agent");
  expect(o.workdir).toBe(w.workdir);
  expect(o.cmd.slice(0, 4)).toEqual(["sh", "-c", CLAUDE_WRAPPER, w.fakeBin]);
  const env = Object.fromEntries(o.env.map((kv) => kv.split(/=(.*)/s).slice(0, 2)));
  expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("tok-1");
  expect(env.CLAUDE_CONFIG_DIR).toBe(path.join(w.workdir, ".claude-config"));
  expect(env.OPEN_FACTORY_URL).toMatch(/^http:\/\/host\.docker\.internal:/);
  for (const k of ["PATH", "HOME", "DATABASE_URL", "FACTORY_SECRET_KEY"])
    expect(env).not.toHaveProperty(k);

  // Only checkMounts' mounts reach the container.
  const mounts = (container(w)?.opts.HostConfig?.Mounts ?? []).map((m) => m.Source);
  expect(mounts).toContain(w.workdir);
  expect(mounts).toContain(w.cliBundle);
  expect(mounts).toHaveLength(3); // workdir, plugins dir, CLI bundle
});

test("container event carries image id and claude version label", async () => {
  const w = await setup();
  await idleAgent(w);
  const evs = await events(w);
  const at = evs.findIndex((e) => e.type === "container");
  expect(evs[at]).toEqual({
    type: "container",
    action: "created",
    image: IMAGE,
    imageId: "sha256:img1",
    claudeCodeVersion: "2.1.327",
  });
  expect(evs[at + 1]).toMatchObject({ type: "process_started", reason: "message" });
  expect(w.rt.live().image).toBe(IMAGE);

  // The next wake reuses the stopped container.
  expect(await w.rt.hibernate("warm_window")).toBe(true);
  await until(() => expect(w.rt.live().status).toBe("hibernated"));
  await send(w, "again");
  await until(() => expect(w.rt.live().status).toBe("idle"));
  expect((await events(w)).filter((e) => e.type === "container").at(-1)).toMatchObject({
    action: "started",
  });
});

test("a crash stops the container before the recovery start; background processes die with it", async () => {
  const w = await setup(LONG);
  await send(w);
  await until(() => expect(w.rt.live().turnOpen).toBe(true));
  const cid = container(w)?.id ?? "";
  const sleeper = spawn("sleep", ["60"]);
  extra.push(sleeper);
  w.docker.track(cid, sleeper); // a background shell the agent left in its container
  const [claude] = w.docker.live(cid);
  const before = w.docker.calls.length;

  // The exec stream ends while the container keeps running (Docker can't tell the code): a crash (spec §11.3).
  claude?.kill("SIGKILL");
  await until(async () =>
    expect((await events(w)).filter((e) => e.type === "process_started")).toHaveLength(2),
  );

  const evs = await events(w);
  expect(evs).toContainEqual(expect.objectContaining({ type: "exited", code: null, signal: null }));
  expect(evs).toContainEqual({ type: "cleanup", container: "stopped" });
  const after = w.docker.calls.slice(before).map((c) => c.op);
  expect(after.indexOf("stop")).toBeGreaterThan(-1);
  expect(after.indexOf("stop")).toBeLessThan(after.indexOf("execStream"));
  await until(() => expect(sleeper.signalCode).toBe("SIGKILL"));
  expect(evs.filter((e) => e.type === "process_started").at(-1)).toMatchObject({
    reason: "crash_recovery",
    resumed: true,
  });
});

test("hibernate stops the container (not removed)", async () => {
  const w = await setup();
  await idleAgent(w);
  expect(await w.rt.hibernate("warm_window")).toBe(true);
  // The status flips when the exit job begins; its events are recorded later in that job.
  await until(async () =>
    expect((await events(w)).at(-1)).toMatchObject({ type: "hibernated", reason: "warm_window" }),
  );
  expect(w.rt.live().status).toBe("hibernated");
  expect(container(w)).toMatchObject({ running: false });
  expect(w.docker.ops()).not.toContain("remove");
  const evs = await events(w);
  expect(evs.map((e) => e.type)).not.toContain("cleanup");
  await until(() => expect(w.runtimes.supervisor.running().count).toBe(0));
});

test("a container stop that fails on hibernate makes the agent stop_failed and keeps its slot", async () => {
  const w = await setup();
  await idleAgent(w);
  w.docker.stopError = new Error("daemon error");
  expect(await w.rt.hibernate("warm_window")).toBe(true);
  await until(() => expect(w.rt.live().errorKind).toBe("stop_failed"));
  expect(w.rt.live().status).toBe("errored");
  expect(w.runtimes.supervisor.running().count).toBe(1);
});

test("a missing image is pulled before the grant; status queued + pulling", async () => {
  const w = await setup();
  w.docker.images.clear();
  let release = () => {};
  w.docker.pullGate = new Promise<void>((r) => {
    release = r;
  });
  await send(w);
  expect(w.rt.live()).toMatchObject({ status: "queued", pulling: true });
  expect(w.docker.ops()).toContain("pull");
  expect(w.docker.ops()).not.toContain("prepare");
  expect(w.runtimes.supervisor.running().count).toBe(0);
  // A second wake joins the same pull.
  await send(w, "more");
  release();
  await until(() => expect(w.rt.live().status).toBe("idle"));
  expect(w.rt.live().pulling).toBeUndefined();
  expect(w.docker.ops().filter((o) => o === "pull")).toHaveLength(1);
  expect(w.docker.ops().indexOf("pull")).toBeLessThan(w.docker.ops().indexOf("prepare"));
});

test("the closing latch aborts an in-flight pull; nothing starts", async () => {
  const w = await setup();
  w.docker.images.clear();
  let release = () => {};
  w.docker.pullGate = new Promise<void>((r) => {
    release = r;
  });
  await send(w);
  expect(w.docker.pullSignals[0]?.aborted).toBe(false);
  w.runtimes.supervisor.close();
  expect(w.docker.pullSignals[0]?.aborted).toBe(true);
  release();
  await w.rt.settled();
  expect(w.rt.live()).toMatchObject({ status: "hibernated" });
  expect(w.rt.live().pulling).toBeUndefined();
  expect(w.docker.ops()).not.toContain("prepare");
});

test("an image removed after it was seen goes back through the pull instead of failing", async () => {
  const w = await setup();
  await idleAgent(w);
  expect(await w.rt.hibernate("warm_window")).toBe(true);
  await until(() => expect(w.rt.live().status).toBe("hibernated"));
  w.docker.images.clear(); // `docker rmi` while the factory runs
  await send(w, "after rmi"); // no 503: the wake is re-queued behind the pull
  await until(() => expect(w.rt.live().status).toBe("idle"));
  expect(w.docker.ops().filter((o) => o === "pull")).toHaveLength(1);
  expect((await events(w)).map((e) => e.type)).not.toContain("error");
});

test("an image still missing after the re-pull fails the start (no loop)", async () => {
  const w = await setup();
  await idleAgent(w);
  expect(await w.rt.hibernate("warm_window")).toBe(true);
  await until(() => expect(w.rt.live().status).toBe("hibernated"));
  w.docker.images.clear();
  const pull = vi.spyOn(w.docker, "pull").mockResolvedValue(undefined); // "succeeds", but no image
  await send(w, "after rmi");
  await until(() => expect(w.rt.live().status).toBe("errored"));
  expect(w.rt.live()).toMatchObject({
    errorKind: "start",
    lastError: `The image ${IMAGE} isn't available locally.`,
  });
  expect(pull).toHaveBeenCalledTimes(1);
  await until(() => expect(w.runtimes.supervisor.running().count).toBe(0));
  // The second miss forgot the image too: a human's retry pulls it for real and starts.
  pull.mockRestore();
  await send(w, "retry");
  await until(() => expect(w.rt.live().status).toBe("idle"));
  expect(w.docker.ops()).toContain("pull");
});

/** Runs `then` right after the real `ensure` started the container, before the launch. */
function afterEnsure(w: World, then: () => void | Promise<void>) {
  const real = w.containers.ensure.bind(w.containers);
  vi.spyOn(w.containers, "ensure").mockImplementation(async (i) => {
    const r = await real(i);
    await then();
    return r;
  });
}
const opsAfterStart = (w: World) => {
  const ops = w.docker.ops();
  return ops.slice(ops.lastIndexOf("start"));
};

test("the closing latch between ensure and launch: the container is stopped and the slot released", async () => {
  const w = await setup();
  afterEnsure(w, () => w.runtimes.supervisor.close());
  await send(w);
  await until(() => expect(opsAfterStart(w)).toContain("stop"));
  await w.rt.settled();
  expect(w.docker.ops()).not.toContain("execStream");
  expect(container(w)).toMatchObject({ running: false });
  expect(w.runtimes.supervisor.running().count).toBe(0);
});

test("a credential pause between ensure and launch: the container is stopped and the wake re-queued", async () => {
  const w = await setup();
  afterEnsure(w, () =>
    w.runtimes.supervisor.pause(liveCredentialId(w.agent), new Date(Date.now() + 3_600_000), true),
  );
  await send(w);
  await until(() => expect(opsAfterStart(w)).toContain("stop"));
  await w.rt.settled();
  expect(w.docker.ops()).not.toContain("execStream");
  expect(container(w)).toMatchObject({ running: false });
  expect(w.runtimes.supervisor.running().count).toBe(0);
  expect(w.runtimes.supervisor.isQueued(w.agent.id)).toBe(true);
});

test("a container that can't be stopped before the launch: stop_failed, and the slot is kept", async () => {
  const w = await setup();
  afterEnsure(w, () => {
    w.docker.stopError = new Error("daemon error");
    w.runtimes.supervisor.close();
  });
  await send(w);
  await until(() => expect(w.rt.live().errorKind).toBe("stop_failed"));
  await w.rt.settled();
  expect(w.docker.ops()).not.toContain("execStream");
  expect(container(w)).toMatchObject({ running: true });
  expect(w.runtimes.supervisor.running().count).toBe(1);
});

test("ensure failing after the container started: errored start, container stopped, slot released", async () => {
  const w = await setup();
  afterEnsure(w, () => {
    throw new Error("label lookup failed");
  });
  await send(w);
  await until(() => expect(w.rt.live().status).toBe("errored"));
  await w.rt.settled();
  expect(w.rt.live()).toMatchObject({
    errorKind: "start",
    lastError: "Docker failed: label lookup failed",
  });
  expect(opsAfterStart(w)).toContain("stop");
  expect(container(w)).toMatchObject({ running: false });
  expect(w.docker.ops()).not.toContain("execStream");
  expect(w.runtimes.supervisor.running().count).toBe(0);
});

test("ensure failing and the stop failing too: the start failure is recorded, then stop_failed keeps the slot", async () => {
  const w = await setup();
  afterEnsure(w, () => {
    w.docker.stopError = new Error("daemon error");
    throw new Error("label lookup failed");
  });
  await send(w);
  await until(() => expect(w.rt.live().errorKind).toBe("stop_failed"));
  await w.rt.settled();
  expect(await events(w)).toContainEqual({
    type: "error",
    source: "spawn",
    message: "Docker failed: label lookup failed",
  });
  expect(container(w)).toMatchObject({ running: true });
  expect(w.runtimes.supervisor.running().count).toBe(1);
});

test("ensure failing while the DB can't record it: the container is stopped anyway", async () => {
  const w = await setup();
  const realAppend = store.append.bind(store);
  vi.spyOn(store, "append").mockImplementation((id, turn, event, tx) =>
    event.type === "error" ? Promise.reject(new Error("db down")) : realAppend(id, turn, event, tx),
  );
  afterEnsure(w, () => {
    throw new Error("label lookup failed");
  });
  await send(w);
  await until(() => expect(opsAfterStart(w)).toContain("stop"));
  await w.rt.settled();
  expect(container(w)).toMatchObject({ running: false });
  expect(w.runtimes.supervisor.running().count).toBe(0);
});

test("a failed stop before the launch keeps the slot even when stop_failed can't be written", async () => {
  const w = await setup();
  vi.spyOn(store, "setErrored").mockRejectedValue(new Error("db down"));
  afterEnsure(w, () => {
    w.docker.stopError = new Error("daemon error");
    w.runtimes.supervisor.close();
  });
  await send(w);
  await until(() => expect(w.rt.live().errorKind).toBe("stop_failed"));
  await w.rt.settled();
  expect(container(w)).toMatchObject({ running: true });
  expect(w.runtimes.supervisor.running().count).toBe(1);
});

/** Hibernate with a failing container stop: stop_failed with no process left. */
async function stopFailedWithoutProcess(w: World) {
  await idleAgent(w);
  w.docker.stopError = new Error("daemon error");
  expect(await w.rt.hibernate("warm_window")).toBe(true);
  await until(() => expect(w.rt.live().errorKind).toBe("stop_failed"));
}
const removes = (w: World) => w.docker.calls.filter((c) => c.op === "remove");

test("Restart of a stop_failed Docker agent: the stop fails again, so the container is removed and it starts", async () => {
  const w = await setup();
  await stopFailedWithoutProcess(w);
  const old = container(w)?.id;
  await w.rt.restart({ byHandle: "or", runtimeAllowed: true });
  await until(() => expect(w.rt.live().status).toBe("idle"));
  w.docker.stopError = undefined;
  expect(removes(w).map((c) => c.args)).toEqual([[old, { force: true }]]);
  const evs = await events(w);
  expect(evs).toContainEqual({ type: "cleanup", container: "removed" });
  expect(evs.filter((e) => e.type === "process_started").at(-1)).toMatchObject({
    reason: "restart",
  });
  expect(container(w)?.id).not.toBe(old); // a fresh container
  expect(w.runtimes.supervisor.running().count).toBe(1);
});

test("Restart of a stop_failed Docker agent whose remove fails too: still stop_failed, slot kept, no start", async () => {
  const w = await setup();
  await stopFailedWithoutProcess(w);
  w.docker.removeError = new Error("daemon error");
  await w.rt.restart({ byHandle: "or", runtimeAllowed: true });
  await w.rt.settled();
  expect(w.rt.live()).toMatchObject({ status: "errored", errorKind: "stop_failed" });
  expect(execs(w)).toHaveLength(1);
  expect(w.runtimes.supervisor.running().count).toBe(1);
});

test("Restart of a stop_failed Docker agent with its process left: the escalation fails again, so the container is removed", async () => {
  const w = await setup(LONG);
  await send(w);
  await until(() => expect(w.rt.live().turnOpen).toBe(true));
  w.docker.pidFile = "abc"; // terminate can't signal it
  w.docker.stopError = new Error("daemon error"); // and the container stop fails
  await w.rt.stop({ graceMs: 50, termWaitMs: 200 });
  await until(() => expect(w.rt.live().errorKind).toBe("stop_failed"));
  expect(w.docker.live(container(w)?.id ?? "")).toHaveLength(1); // Claude still runs
  await w.rt.restart({ byHandle: "or", runtimeAllowed: true });
  await until(async () =>
    expect((await events(w)).filter((e) => e.type === "process_started").at(-1)).toMatchObject({
      reason: "restart",
    }),
  );
  w.docker.stopError = undefined;
  expect(removes(w).map((c) => c.args[1])).toEqual([{ force: true }]);
  expect(execs(w)).toHaveLength(2);
});

test("a pull failure records errored start with the registry error", async () => {
  const w = await setup();
  w.docker.images.clear();
  const registry = "manifest for open-factory-base:dev not found: manifest unknown";
  w.docker.pullError = new Error(registry);
  await send(w);
  await until(() => expect(w.rt.live().status).toBe("errored"));
  expect(w.rt.live()).toMatchObject({ errorKind: "start", lastError: registry });
  expect(await events(w)).toContainEqual({ type: "error", source: "spawn", message: registry });
  expect(w.docker.ops()).not.toContain("prepare");
  expect(w.runtimes.supervisor.running().count).toBe(0);
  const [row] = await t.db.select().from(schema.agents).where(eq(schema.agents.id, w.agent.id));
  expect(row).toMatchObject({ status: "errored", errorKind: "start", lastError: registry });
});

test("Docker unreachable: start fails with the DOCKER_HOST message", async () => {
  const w = await setup();
  vi.stubEnv("DOCKER_HOST", "unix:///tmp/of-test-docker.sock");
  w.docker.down = Object.assign(new Error("connect ECONNREFUSED /tmp/of-test-docker.sock"), {
    code: "ECONNREFUSED",
    syscall: "connect",
  });
  const message =
    "Can't reach Docker at unix:///tmp/of-test-docker.sock: connect ECONNREFUSED /tmp/of-test-docker.sock.";
  // The prepare path (the image is known): stopIfRunning can't reach the daemon.
  await expect(
    w.prepareStart(w.agent, { agentToken: "tok", loaded: () => undefined }),
  ).rejects.toMatchObject({
    name: "AgentStartError",
    message,
  });
  expect(w.workspace.prepare).not.toHaveBeenCalled();
  // A wake: the image check can't reach it either.
  await send(w);
  await until(() => expect(w.rt.live().status).toBe("errored"));
  expect(w.rt.live()).toMatchObject({ errorKind: "start", lastError: message });
});

test("missing CLI bundle: 'Build the CLI first (pnpm build).'", async () => {
  const w = await setup();
  rmSync(w.cliBundle);
  await expect(
    w.prepareStart(w.agent, { agentToken: "tok", loaded: () => undefined }),
  ).rejects.toMatchObject({
    name: "AgentStartError",
    message: "Build the CLI first (pnpm build).",
  });
  expect(w.workspace.prepare).not.toHaveBeenCalled();
  expect(w.docker.calls).toEqual([]);
});

test.each(["abc", "0", "-5", "12345678901"])(
  "a bad pid file (%s): no kill exec, the stop times out and escalates to the container stop",
  async (pidFile) => {
    const w = await setup(LONG);
    await send(w);
    await until(() => expect(w.rt.live().turnOpen).toBe(true));
    w.docker.pidFile = pidFile;
    await w.rt.stop({ graceMs: 50, termWaitMs: 200 });
    await until(async () => expect((await events(w)).map((e) => e.type)).toContain("exited"));
    // `exited` is appended mid-job and the slot is released further down that same job: let the job finish.
    await w.rt.settled();

    expect(execRuns(w)).toContainEqual(["cat", CLAUDE_PID_FILE]);
    expect(execRuns(w).some((cmd) => cmd[0] === "kill")).toBe(false);
    const evs = await events(w);
    expect(evs).toContainEqual({ type: "stop_escalated", how: "container_stop" });
    expect(evs.filter((e) => e.type === "exited")).toHaveLength(1);
    expect(container(w)).toMatchObject({ running: false });
    expect(w.fakeLog().some((l) => l.kind === "exit")).toBe(false); // never SIGTERMed: killed with the container
    expect(w.runtimes.supervisor.running().count).toBe(0);
  },
);

test("a good pid file: terminate SIGTERMs Claude in the container, no escalation", async () => {
  const w = await setup(LONG);
  await send(w);
  await until(() => expect(w.rt.live().turnOpen).toBe(true));
  const pid = w.docker.live(container(w)?.id ?? "")[0]?.pid;
  await w.rt.stop({ graceMs: 50, termWaitMs: 5000 });
  expect(execRuns(w)).toContainEqual(["kill", "-TERM", String(pid)]);
  expect(w.fakeLog()).toContainEqual({ kind: "exit", code: 143 });
  expect((await events(w)).map((e) => e.type)).not.toContain("stop_escalated");
  await until(() => expect(container(w)).toMatchObject({ running: false })); // the exit stops the container
});

test("a user image that isn't built fails the start with fix image, and is never pulled", async () => {
  const w = await setup("reply", "smoke");
  await send(w);
  await until(() => expect(w.rt.live().status).toBe("errored"));
  const message =
    "Image `smoke` isn't built. Build it in Templates \u2192 Images, or run `open-factory images build smoke`.";
  expect(w.rt.live().lastError).toBe(message);
  expect(await events(w)).toContainEqual(
    expect.objectContaining({ type: "error", source: "spawn", message, fix: "image" }),
  );
  expect(w.docker.ops()).not.toContain("pull");
});

test("a user image's presence check never shows the wake as pulling", async () => {
  const w = await setup("reply", "smoke");
  w.docker.images.set("open-factory-user/smoke:latest", { id: "sha256:smoke", labels: {} });
  const real = w.docker.imageId.bind(w.docker);
  let release = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  vi.spyOn(w.docker, "imageId").mockImplementation(async (ref) => {
    await gate;
    return real(ref);
  });
  await send(w);
  expect(w.rt.live().status).toBe("queued");
  expect(w.rt.live().pulling).toBeUndefined();
  release();
  await until(() => expect(w.rt.live().status).toBe("idle"));
  expect(w.docker.ops()).not.toContain("pull");
});

test("a user image that is built starts from its local tag without a pull", async () => {
  const w = await setup("reply", "smoke");
  w.docker.images.set("open-factory-user/smoke:latest", { id: "sha256:smoke", labels: {} });
  await send(w);
  await until(() => expect(w.rt.live().status).toBe("idle"));
  expect(w.rt.live().image).toBe("open-factory-user/smoke:latest");
  expect(w.docker.ops()).not.toContain("pull");
});
