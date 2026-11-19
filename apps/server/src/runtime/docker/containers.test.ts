import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Mount } from "@open-factory/harness";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { AgentStartError } from "../../agents/errors.ts";
import {
  CLI_BUNDLE_TARGET,
  type MountCheckContext,
  MountRefusedError,
} from "../../workspace/mounts.ts";
import type { ContainerCreateOptions, ContainerInfo, DockerClient, ExecStream } from "./client.ts";
import { ContainerManager, containerName, createOptions, specHash } from "./containers.ts";

type Call = { op: string; args: unknown[] };

interface FakeContainer {
  id: string;
  name: string;
  running: boolean;
  labels: Record<string, string>;
  opts: ContainerCreateOptions;
}

/** Records every call; containers and images live in memory. */
class FakeDockerClient implements DockerClient {
  calls: Call[] = [];
  images = new Map<string, { id: string; labels: Record<string, string> }>();
  containers = new Map<string, FakeContainer>();
  pullError: Error | undefined;
  /** What `test -f /run/open-factory/ready` answers. */
  ready: (c: FakeContainer) => boolean = () => true;
  logs = "";
  private seq = 0;

  private rec(op: string, ...args: unknown[]) {
    this.calls.push({ op, args });
  }
  ops() {
    return this.calls.map((c) => c.op);
  }
  private byId(id: string) {
    const c = [...this.containers.values()].find((x) => x.id === id);
    if (!c) throw Object.assign(new Error("no such container"), { statusCode: 404 });
    return c;
  }
  private info(c: FakeContainer): ContainerInfo {
    return { id: c.id, running: c.running, labels: c.labels };
  }

  async imageId(ref: string) {
    this.rec("imageId", ref);
    return this.images.get(ref)?.id;
  }
  async pull(ref: string, _signal: AbortSignal) {
    this.rec("pull", ref);
    if (this.pullError) throw this.pullError;
    this.images.set(ref, { id: "sha256:pulled", labels: {} });
  }
  async imageLabel(ref: string, label: string) {
    this.rec("imageLabel", ref, label);
    return this.images.get(ref)?.labels[label];
  }
  async findContainer(name: string) {
    this.rec("findContainer", name);
    const c = this.containers.get(name);
    return c && this.info(c);
  }
  async listByLabel(label: string) {
    this.rec("listByLabel", label);
    return [...this.containers.values()].filter((c) => label in c.labels).map((c) => this.info(c));
  }
  async create(opts: ContainerCreateOptions) {
    this.rec("create", opts);
    const id = `c${++this.seq}`;
    const name = opts.name ?? id;
    this.containers.set(name, { id, name, running: false, labels: opts.Labels ?? {}, opts });
    return id;
  }
  async start(id: string) {
    this.rec("start", id);
    this.byId(id).running = true;
  }
  async stop(id: string, t: number) {
    this.rec("stop", id, t);
    this.byId(id).running = false;
  }
  async remove(id: string) {
    this.rec("remove", id);
    const c = this.byId(id);
    this.containers.delete(c.name);
  }
  async execRun(id: string, o: { cmd: string[]; user: string }) {
    this.rec("execRun", id, o);
    const c = this.byId(id);
    if (!c.running) throw Object.assign(new Error("container is not running"), { statusCode: 409 });
    return { code: this.ready(c) ? 0 : 1, stdout: "" };
  }
  async execStream(): Promise<ExecStream> {
    throw new Error("not used");
  }
  async logsTail(id: string, n: number) {
    this.rec("logsTail", id, n);
    return this.logs;
  }
}

const log = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
const tmp = (p: string) => realpathSync(mkdtempSync(path.join(os.tmpdir(), p)));

const AGENT = "0123456789abcdef-agent";
const IMAGE = "open-factory-base:dev";
let ctx: MountCheckContext;
let mounts: Mount[];
let docker: FakeDockerClient;
let mgr: ContainerManager;

beforeEach(() => {
  const factoryHome = tmp("of-t23-home-");
  const workdir = path.join(factoryHome, "agents", "lead");
  const pluginsDir = path.join(factoryHome, "state", "agents", "lead", "plugins-config", "plugins");
  mkdirSync(workdir, { recursive: true });
  mkdirSync(pluginsDir, { recursive: true });
  const cliBundle = path.join(tmp("of-t23-cli-"), "open-factory.js");
  writeFileSync(cliBundle, "");
  ctx = {
    workdir,
    grantedPaths: [],
    hostSkillPaths: [],
    declaredMarketplaceDirs: [],
    pluginsDir,
    cliBundle,
    factoryHome,
    home: tmp("of-t23-userhome-"),
    dockerSockets: ["/var/run/docker.sock"],
  };
  mounts = [
    { source: workdir, target: workdir, readOnly: false },
    { source: pluginsDir, target: pluginsDir, readOnly: true },
    { source: cliBundle, target: CLI_BUNDLE_TARGET, readOnly: true },
  ];
  docker = new FakeDockerClient();
  docker.images.set(IMAGE, {
    id: "sha256:img1",
    labels: { "io.open-factory.claude-code.version": "2.1.327" },
  });
  mgr = new ContainerManager({ docker, log, uid: 501, gid: 20 });
});

afterEach(() => {
  vi.useRealTimers();
});

/** Fakes only the clock and setTimeout: checkMounts does real fs I/O, so the test yields with a real setImmediate. */
const fakeClock = () => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
const until = async (cond: () => boolean) => {
  while (!cond()) await new Promise((r) => setImmediate(r));
};

const inputs = {
  name: "open-factory-lead-01234567",
  image: IMAGE,
  imageId: "sha256:img1",
  mounts: [
    { source: "/w", target: "/w", readOnly: false },
    { source: "/b", target: CLI_BUNDLE_TARGET, readOnly: true },
  ],
  uid: 501,
  gid: 20,
  agentId: AGENT,
  slug: "lead",
  specHash: "abc123",
};

test("container name: open-factory-<slug>-<first 8 of the agent id>", () => {
  expect(containerName("lead", AGENT)).toBe("open-factory-lead-01234567");
});

test("hardened create options", () => {
  const o = createOptions(inputs);
  expect(o.HostConfig?.SecurityOpt).toEqual(["no-new-privileges:true"]);
  expect(o.HostConfig?.Privileged).toBeFalsy();
  expect(o.HostConfig?.CapAdd).toBeUndefined();
  expect(o.HostConfig?.NetworkMode ?? "default").not.toBe("host");
  expect(o.HostConfig?.PidMode).toBeUndefined();
  expect(o.HostConfig?.Tmpfs).toEqual({ "/run/open-factory": "" });
  expect(o.HostConfig?.ExtraHosts).toEqual(["host.docker.internal:host-gateway"]);
  expect(o.Env).toEqual([`HOST_UID=${inputs.uid}`, `HOST_GID=${inputs.gid}`]);
  expect(o.Labels).toMatchObject({
    "io.open-factory.agent-id": inputs.agentId,
    "io.open-factory.spec-hash": inputs.specHash,
  });
});

test("create options: labels, image, bind mounts only from the input, nothing else that widens the box", () => {
  const o = createOptions(inputs);
  expect(o.name).toBe(inputs.name);
  expect(o.Image).toBe(IMAGE);
  expect(o.Cmd).toBeUndefined(); // the image default (`sleep infinity`)
  expect(o.User).toBeUndefined();
  expect(o.Labels).toEqual({
    "io.open-factory.agent-id": AGENT,
    "io.open-factory.slug": "lead",
    "io.open-factory.spec-hash": "abc123",
    "io.open-factory.image-id": "sha256:img1",
  });
  expect(o.HostConfig?.Mounts).toEqual([
    { Type: "bind", Source: "/w", Target: "/w", ReadOnly: false },
    { Type: "bind", Source: "/b", Target: CLI_BUNDLE_TARGET, ReadOnly: true },
  ]);
  expect(o.HostConfig?.Binds).toBeUndefined();
  expect(o.HostConfig?.Init).toBeUndefined();
  expect(o.HostConfig?.Devices).toBeUndefined();
  expect(o.HostConfig?.IpcMode).toBeUndefined();
  expect(o.HostConfig?.UsernsMode).toBeUndefined();
  expect(o.HostConfig?.VolumesFrom).toBeUndefined();
  expect(Object.keys(o.HostConfig ?? {}).sort()).toEqual(
    ["ExtraHosts", "Mounts", "SecurityOpt", "Tmpfs"].sort(),
  );
  expect(Object.keys(o).sort()).toEqual(["Env", "HostConfig", "Image", "Labels", "name"].sort());
});

test("spec hash changes on image id, mounts and uid; not on anything else passed", () => {
  const base = { imageId: "sha256:a", mounts: inputs.mounts, uid: 501, gid: 20 };
  const h = specHash(base);
  expect(h).toMatch(/^[0-9a-f]{64}$/);
  expect(specHash({ ...base })).toBe(h);
  expect(specHash({ ...base, mounts: [...inputs.mounts].reverse() })).toBe(h); // sorted
  expect(specHash({ ...base, imageId: "sha256:b" })).not.toBe(h);
  expect(specHash({ ...base, uid: 502 })).not.toBe(h);
  expect(specHash({ ...base, gid: 21 })).not.toBe(h);
  expect(specHash({ ...base, mounts: inputs.mounts.slice(1) })).not.toBe(h);
  expect(
    specHash({
      ...base,
      mounts: [{ ...inputs.mounts[0], readOnly: true } as Mount, ...inputs.mounts.slice(1)],
    }),
  ).not.toBe(h);
  // Extra properties (an agent id, a slug, an image ref) never reach the hash.
  expect(specHash({ ...base, agentId: "x", slug: "y", image: "z" } as typeof base)).toBe(h);
});

test("pull only when missing", async () => {
  const signal = new AbortController().signal;
  await mgr.ensureImage(IMAGE, signal);
  expect(docker.ops()).toEqual(["imageId"]);

  docker.calls = [];
  await mgr.ensureImage("ghcr.io/x/missing:1", signal);
  expect(docker.ops()).toEqual(["imageId", "pull"]);

  docker.pullError = new Error("manifest unknown: manifest unknown");
  await expect(mgr.ensureImage("ghcr.io/x/other:1", signal)).rejects.toThrow(
    "manifest unknown: manifest unknown",
  );
});

test("first ensure creates with the checked mounts, starts and waits for the ready marker as root", async () => {
  const r = await mgr.ensure({
    agentId: AGENT,
    slug: "lead",
    image: IMAGE,
    mounts,
    mountCheck: ctx,
  });
  expect(r).toEqual({
    containerId: "c1",
    action: "created",
    imageId: "sha256:img1",
    claudeCodeVersion: "2.1.327",
  });
  const create = docker.calls.find((c) => c.op === "create")?.args[0] as ContainerCreateOptions;
  expect(create.name).toBe("open-factory-lead-01234567");
  expect(create.HostConfig?.Mounts?.map((m) => [m.Source, m.Target, m.ReadOnly])).toEqual(
    mounts.map((m) => [m.source, m.target, m.readOnly]),
  );
  const ops = docker.ops();
  expect(ops.indexOf("create")).toBeLessThan(ops.indexOf("start"));
  expect(ops.indexOf("start")).toBeLessThan(ops.indexOf("execRun"));
  expect(docker.calls.find((c) => c.op === "execRun")?.args[1]).toEqual({
    cmd: ["test", "-f", "/run/open-factory/ready"],
    user: "root",
  });
});

test("re-creates on hash change, starts on match", async () => {
  const first = await mgr.ensure({
    agentId: AGENT,
    slug: "lead",
    image: IMAGE,
    mounts,
    mountCheck: ctx,
  });
  await mgr.stop(AGENT, "lead");

  // Same spec: the stopped container is started again, not re-created.
  docker.calls = [];
  const again = await mgr.ensure({
    agentId: AGENT,
    slug: "lead",
    image: IMAGE,
    mounts,
    mountCheck: ctx,
  });
  expect(again).toMatchObject({ containerId: first.containerId, action: "started" });
  expect(docker.ops()).not.toContain("create");
  expect(docker.ops()).not.toContain("remove");

  // A rebuilt image (new id) changes the hash: stop + remove + create.
  docker.images.set(IMAGE, { id: "sha256:img2", labels: {} });
  docker.calls = [];
  const re = await mgr.ensure({
    agentId: AGENT,
    slug: "lead",
    image: IMAGE,
    mounts,
    mountCheck: ctx,
  });
  expect(re).toEqual({ containerId: "c2", action: "recreated", imageId: "sha256:img2" });
  const ops = docker.ops();
  expect(ops.indexOf("stop")).toBeLessThan(ops.indexOf("remove"));
  expect(ops.indexOf("remove")).toBeLessThan(ops.indexOf("create"));
  expect(docker.calls.find((c) => c.op === "stop")?.args).toEqual([first.containerId, 5]);

  // A new grant changes the mounts and so the hash.
  const proj = tmp("of-t23-proj-");
  const grantCtx = { ...ctx, grantedPaths: [proj] };
  const r3 = await mgr.ensure({
    agentId: AGENT,
    slug: "lead",
    image: IMAGE,
    mounts: [...mounts, { source: proj, target: proj, readOnly: false }],
    mountCheck: grantCtx,
  });
  expect(r3.action).toBe("recreated");
});

test("checkMounts runs on every ensure, including reuse of a stopped container", async () => {
  await mgr.ensure({ agentId: AGENT, slug: "lead", image: IMAGE, mounts, mountCheck: ctx });
  await mgr.stop(AGENT, "lead");
  docker.calls = [];
  // The same inputs, but the workdir was swapped for a link to the host home after prepare: the reuse of the
  // stopped container must fail closed, unstarted (bind sources resolve again at every start).
  renameSync(ctx.workdir, `${ctx.workdir}.moved`);
  symlinkSync(ctx.home, ctx.workdir);
  await expect(
    mgr.ensure({ agentId: AGENT, slug: "lead", image: IMAGE, mounts, mountCheck: ctx }),
  ).rejects.toThrow(MountRefusedError);
  expect(docker.ops()).not.toContain("start");
  expect(docker.ops()).not.toContain("create");
});

test("a mount that isn't allowed never reaches create", async () => {
  const home = tmp("of-t23-h-");
  await expect(
    mgr.ensure({
      agentId: AGENT,
      slug: "lead",
      image: IMAGE,
      mounts: [...mounts, { source: home, target: home, readOnly: false }],
      mountCheck: ctx,
    }),
  ).rejects.toBeInstanceOf(MountRefusedError);
  expect(docker.ops()).not.toContain("create");
});

test("a running container with the same spec is reused without a start", async () => {
  const first = await mgr.ensure({
    agentId: AGENT,
    slug: "lead",
    image: IMAGE,
    mounts,
    mountCheck: ctx,
  });
  docker.calls = [];
  const r = await mgr.ensure({
    agentId: AGENT,
    slug: "lead",
    image: IMAGE,
    mounts,
    mountCheck: ctx,
  });
  expect(r).toMatchObject({ containerId: first.containerId, action: "started" });
  expect(docker.ops()).not.toContain("create");
});

test("ready timeout surfaces the container logs", async () => {
  fakeClock();
  docker.ready = () => false;
  docker.logs = "entrypoint: usermod failed\n";
  const p = mgr.ensure({ agentId: AGENT, slug: "lead", image: IMAGE, mounts, mountCheck: ctx });
  const caught = p.catch((e: unknown) => e);
  await until(() => docker.ops().includes("execRun"));
  await vi.advanceTimersByTimeAsync(29_000);
  expect(docker.ops()).not.toContain("logsTail");
  await vi.advanceTimersByTimeAsync(2_000);
  const err = await caught;
  expect(err).toBeInstanceOf(AgentStartError);
  expect((err as Error).message).toContain("entrypoint: usermod failed");
  expect(docker.calls.find((c) => c.op === "logsTail")?.args).toEqual(["c1", 50]);
  // Polled every 200 ms for 30 s.
  const polls = docker.calls.filter((c) => c.op === "execRun").length;
  expect(polls).toBeGreaterThanOrEqual(140);
  expect(polls).toBeLessThanOrEqual(152);
});

test("a container that exits before it is ready fails the start with its logs", async () => {
  fakeClock();
  docker.ready = (c) => {
    c.running = false; // the entrypoint died
    return false;
  };
  docker.logs = "tini: exec failed\n";
  const p = mgr.ensure({ agentId: AGENT, slug: "lead", image: IMAGE, mounts, mountCheck: ctx });
  const caught = p.catch((e: unknown) => e);
  await until(() => docker.ops().includes("execRun"));
  await vi.advanceTimersByTimeAsync(1_000);
  const err = await caught;
  expect(err).toBeInstanceOf(AgentStartError);
  expect((err as Error).message).toContain("tini: exec failed");
});

test("root host user is refused", async () => {
  for (const ids of [
    { uid: 0, gid: 20 },
    { uid: 501, gid: 0 },
  ]) {
    const m = new ContainerManager({ docker, log, ...ids });
    await expect(
      m.ensure({ agentId: AGENT, slug: "lead", image: IMAGE, mounts, mountCheck: ctx }),
    ).rejects.toThrow("The factory runs as root; Docker agents need a non-root host user.");
  }
  expect(docker.ops()).not.toContain("create");
  expect(docker.ops()).not.toContain("start");
});

test("a missing image fails the start (the pull runs before, outside ensure)", async () => {
  await expect(
    mgr.ensure({ agentId: AGENT, slug: "lead", image: "nope:1", mounts, mountCheck: ctx }),
  ).rejects.toBeInstanceOf(AgentStartError);
  expect(docker.ops()).not.toContain("pull");
});

test("stop, stopIfRunning, isRunning and listOurs", async () => {
  expect(await mgr.stopIfRunning(AGENT, "lead")).toBe(false);
  expect(await mgr.isRunning(AGENT, "lead")).toBe(false);
  const { containerId } = await mgr.ensure({
    agentId: AGENT,
    slug: "lead",
    image: IMAGE,
    mounts,
    mountCheck: ctx,
  });
  expect(await mgr.isRunning(AGENT, "lead")).toBe(true);
  expect(await mgr.listOurs()).toEqual([{ id: containerId, agentId: AGENT, running: true }]);
  expect(await mgr.stopIfRunning(AGENT, "lead")).toBe(true);
  expect(docker.calls.at(-1)).toEqual({ op: "stop", args: [containerId, 5] });
  expect(await mgr.stopIfRunning(AGENT, "lead")).toBe(false);
  await mgr.stop(AGENT, "lead"); // a stopped container: no error
  await mgr.stop("ffffffff-none", "ghost"); // no container: no error
  expect(docker.calls.filter((c) => c.op === "listByLabel").map((c) => c.args[0])).toEqual([
    "io.open-factory.agent-id",
  ]);
});

test("a container stop that never answers is bounded", async () => {
  await mgr.ensure({ agentId: AGENT, slug: "lead", image: IMAGE, mounts, mountCheck: ctx });
  docker.stop = () => new Promise<void>(() => {});
  fakeClock();
  const caught = mgr.stop(AGENT, "lead").catch((e: unknown) => e);
  await vi.advanceTimersByTimeAsync(20_000);
  expect(await caught).toBeInstanceOf(Error);
});
