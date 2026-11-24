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
import type { ContainerCreateOptions } from "./client.ts";
import { ContainerManager, containerName, createOptions, specHash } from "./containers.ts";
import { LAUNCHER_VERSION } from "./spec-hash.ts";
import { FakeDockerClient } from "./testing/fake-docker.ts";

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
  const pluginsDir = path.join(factoryHome, "state", "agents", "lead", "plugins");
  mkdirSync(workdir, { recursive: true });
  mkdirSync(pluginsDir, { recursive: true });
  const cliBundle = path.join(tmp("of-t23-cli-"), "open-factory.js");
  writeFileSync(cliBundle, "");
  ctx = {
    slug: "lead",
    workdir,
    grantedPaths: [],
    skillPaths: [],
    templateSkillPaths: [],
    templateDir: path.join(factoryHome, "templates/t"),
    declaredMarketplaceDirs: [],
    pluginsDir,
    cliBundle,
    factoryHome,
    home: tmp("of-t23-userhome-"),
    dockerSockets: ["/var/run/docker.sock"],
  };
  mounts = [
    { source: workdir, target: workdir, readOnly: false },
    { source: pluginsDir, target: pluginsDir, readOnly: false },
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

test("an image below the Claude Code floor fails the start before any container is created", async () => {
  const checkImage = vi.fn(async () => {
    throw new Error("Claude Code 2.1.1 is too old; update it to 2.1.331 or later.");
  });
  const strict = new ContainerManager({ docker, log, uid: 501, gid: 20, checkImage });
  const err = await strict
    .ensure({ agentId: AGENT, slug: "lead", image: IMAGE, mounts, mountCheck: ctx })
    .catch((e) => e);
  expect(err).toBeInstanceOf(AgentStartError);
  expect(err.message).toBe("Claude Code 2.1.1 is too old; update it to 2.1.331 or later.");
  expect(checkImage).toHaveBeenCalledWith(IMAGE, "sha256:img1");
  expect(docker.containers.size).toBe(0);
});

test("pinned create options and spec hash (changed? check the hardening, then update the pins)", () => {
  expect(createOptions(inputs)).toEqual({
    name: "open-factory-lead-01234567",
    Image: "sha256:img1", // the hashed id, never the (retaggable) ref
    Env: ["HOST_UID=501", "HOST_GID=20"],
    Labels: {
      "io.open-factory.agent-id": AGENT,
      "io.open-factory.slug": "lead",
      "io.open-factory.spec-hash": "abc123",
      "io.open-factory.image-id": "sha256:img1",
      "io.open-factory.image": IMAGE,
    },
    HostConfig: {
      Mounts: [
        { Type: "bind", Source: "/b", Target: CLI_BUNDLE_TARGET, ReadOnly: true },
        { Type: "bind", Source: "/w", Target: "/w", ReadOnly: false },
      ],
      Tmpfs: { "/run/open-factory": "" },
      ExtraHosts: ["host.docker.internal:host-gateway"],
      SecurityOpt: ["no-new-privileges:true"],
    },
  });
  expect(LAUNCHER_VERSION).toBe(1);
  // The hash is taken over the options themselves: any change to what a container runs with changes it.
  expect(specHash({ imageId: "sha256:img1", mounts: inputs.mounts, uid: 501, gid: 20 })).toBe(
    "013f0f4a5ef8789c127dc461a4827e5ab625d806ec01781503ad8d37a586afab",
  );
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
  expect(create.Image).toBe("sha256:img1");
  expect(create.HostConfig?.Mounts?.map((m) => [m.Source, m.Target, m.ReadOnly]).sort()).toEqual(
    mounts.map((m) => [m.source, m.target, m.readOnly]).sort(),
  );
  expect(docker.calls.find((c) => c.op === "imageLabel")?.args[0]).toBe("sha256:img1");
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
  expect(docker.ops()).not.toContain("start");
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

test("root host user is refused, even when non-root ids are injected", async () => {
  for (const id of ["getuid", "getgid"] as const) {
    const spy = vi.spyOn(process, id).mockReturnValue(0);
    try {
      // `mgr` was built with injected non-root ids (501/20): they don't hide the server's own root id.
      await expect(
        mgr.ensure({ agentId: AGENT, slug: "lead", image: IMAGE, mounts, mountCheck: ctx }),
      ).rejects.toThrow("The factory runs as root; Docker agents need a non-root host user.");
      await expect(
        new ContainerManager({ docker, log }).ensure({
          agentId: AGENT,
          slug: "lead",
          image: IMAGE,
          mounts,
          mountCheck: ctx,
        }),
      ).rejects.toThrow("The factory runs as root; Docker agents need a non-root host user.");
    } finally {
      spy.mockRestore();
    }
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
  const err = await caught;
  expect(err).toBeInstanceOf(Error);
  expect((err as Error).message).toMatch(/didn't finish within 15 s/);
});

test("a ready check the daemon never answers can't outlast the 30 s deadline", async () => {
  fakeClock();
  docker.execRun = () => new Promise(() => {});
  docker.logs = "still booting\n";
  const caught = mgr
    .ensure({ agentId: AGENT, slug: "lead", image: IMAGE, mounts, mountCheck: ctx })
    .catch((e: unknown) => e);
  await until(() => docker.ops().includes("start"));
  await vi.advanceTimersByTimeAsync(31_000);
  const err = await caught;
  expect(err).toBeInstanceOf(AgentStartError);
  expect((err as Error).message).toContain("wasn't ready within 30 s");
  expect((err as Error).message).toContain("still booting");
});

test("a container with the agent's name that the factory didn't create is never reused, stopped or removed", async () => {
  const name = containerName("lead", AGENT);
  const foreign: Record<string, string>[] = [{}, { "io.open-factory.agent-id": "someone-else" }];
  for (const labels of foreign) {
    docker.containers.set(name, {
      id: "foreign",
      name,
      running: true,
      labels: { ...labels, "io.open-factory.spec-hash": "copied" },
      opts: {},
    });
    docker.calls = [];
    const msg = `A container named ${name} exists that the factory didn't create.`;
    await expect(
      mgr.ensure({ agentId: AGENT, slug: "lead", image: IMAGE, mounts, mountCheck: ctx }),
    ).rejects.toThrow(msg);
    await expect(mgr.stopIfRunning(AGENT, "lead")).rejects.toThrow(msg);
    await expect(mgr.stop(AGENT, "lead")).rejects.toThrow(msg);
    await expect(mgr.forceRemove(AGENT, "lead")).rejects.toThrow(msg);
    expect(docker.ops()).not.toContain("stop");
    expect(docker.ops()).not.toContain("remove");
    expect(docker.ops()).not.toContain("start");
    expect(docker.ops()).not.toContain("create");
  }
});

test("forceRemove removes the agent's running container with force; a missing one is fine", async () => {
  expect(await mgr.forceRemove(AGENT, "lead")).toBe(false);
  const { containerId } = await mgr.ensure({
    agentId: AGENT,
    slug: "lead",
    image: IMAGE,
    mounts,
    mountCheck: ctx,
  });
  expect(await mgr.forceRemove(AGENT, "lead")).toBe(true);
  expect(docker.calls.at(-1)).toEqual({ op: "remove", args: [containerId, { force: true }] });
  expect(docker.containers.size).toBe(0);
});

test("remove (termination) stops a running container, then removes it; a missing one is fine", async () => {
  expect(await mgr.remove(AGENT, "lead")).toBe(false);
  const { containerId } = await mgr.ensure({
    agentId: AGENT,
    slug: "lead",
    image: IMAGE,
    mounts,
    mountCheck: ctx,
  });
  docker.calls = [];
  expect(await mgr.remove(AGENT, "lead")).toBe(true);
  expect(docker.calls.filter((c) => c.op !== "findContainer")).toEqual([
    { op: "stop", args: [containerId, 5] },
    { op: "remove", args: [containerId, undefined] }, // not forced: it was stopped first
  ]);
  expect(docker.containers.size).toBe(0);
});

test("remove of a stopped container skips the stop; removeListed removes by id with force", async () => {
  const { containerId } = await mgr.ensure({
    agentId: AGENT,
    slug: "lead",
    image: IMAGE,
    mounts,
    mountCheck: ctx,
  });
  await mgr.stop(AGENT, "lead");
  docker.calls = [];
  await mgr.remove(AGENT, "lead");
  expect(docker.ops().filter((op) => op !== "findContainer")).toEqual(["remove"]);

  const again = await mgr.ensure({
    agentId: AGENT,
    slug: "lead",
    image: IMAGE,
    mounts,
    mountCheck: ctx,
  });
  expect(again.containerId).not.toBe(containerId);
  docker.calls = [];
  await mgr.removeListed(again.containerId);
  expect(docker.calls).toEqual([{ op: "remove", args: [again.containerId, { force: true }] }]);
  expect(docker.containers.size).toBe(0);
});

test("a removal that never answers is bounded", async () => {
  await mgr.ensure({ agentId: AGENT, slug: "lead", image: IMAGE, mounts, mountCheck: ctx });
  await mgr.stop(AGENT, "lead");
  docker.remove = () => new Promise<void>(() => {});
  fakeClock();
  const caught = mgr.remove(AGENT, "lead").catch((e: unknown) => e);
  await vi.advanceTimersByTimeAsync(20_000);
  expect((await caught) as Error).toMatchObject({
    message: expect.stringMatching(/^Removing container .* didn't finish within 15 s\.$/),
  });
});
