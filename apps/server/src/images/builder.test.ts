import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LABEL_BUILT_AT, LABEL_CONTEXT_HASH, type ServerMessage } from "@open-factory/shared";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { EventBus } from "../agents/event-bus.ts";
import { BUILD_EVENTS, FakeDockerClient } from "../runtime/docker/testing/fake-docker.ts";
import { ImageBuilder } from "./builder.ts";
import { contextHash, ImageNameError } from "./context.ts";

const BASE = "ghcr.io/orlevii/open-factory/base:latest";
const TAG = "open-factory-user/smoke:latest";
const RUN_FALSE = "The command '/bin/bash -o pipefail -c false' returned a non-zero code: 1";
const log = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

let root: string;
let docker: FakeDockerClient;
let bus: EventBus;
let frames: ServerMessage[];
let clock: number;
let builder: ImageBuilder;

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

const mkImage = async (name: string, dockerfile = `FROM ${BASE}\nRUN true\n`) => {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "Dockerfile"), dockerfile);
  return dir;
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "of-builder-"));
  docker = new FakeDockerClient();
  bus = new EventBus();
  frames = [];
  bus.subscribeAll((m) => frames.push(m));
  clock = Date.parse("2026-11-20T10:00:00.000Z");
  builder = new ImageBuilder({
    docker,
    imagesRoot: root,
    bus,
    now: () => new Date(clock),
    log,
  });
});
afterEach(async () => {
  vi.useRealTimers();
  await rm(root, { recursive: true, force: true });
});

test("a build tags the user image with the context hash and built-at labels, passing pull through", async () => {
  const dir = await mkImage("smoke");
  docker.images.set(BASE, {
    id: "sha256:base",
    labels: {},
    repoDigests: ["ghcr.io/orlevii/open-factory/base@sha256:d1"],
  });

  await expect(builder.build("smoke", { pull: false })).resolves.toEqual({ state: "succeeded" });

  const builds = docker.calls.filter((c) => c.op === "buildImage");
  expect(builds).toHaveLength(1);
  const labels = {
    [LABEL_CONTEXT_HASH]: await contextHash(dir, "smoke"),
    [LABEL_BUILT_AT]: "2026-11-20T10:00:00.000Z",
  };
  expect(builds[0]?.args[0]).toEqual({ tag: TAG, pull: false, labels });
  expect(docker.images.get(TAG)?.labels).toEqual(labels);
  expect(docker.buildContexts[0]?.length).toBeGreaterThan(0);

  const out = builder.log("smoke");
  expect(out.state).toBe("succeeded");
  expect(out.lines).toContain(`Successfully tagged ${TAG}`);
  expect(out.lines).toContain(`Base image ${BASE}: ghcr.io/orlevii/open-factory/base@sha256:d1`);
  expect(builder.last("smoke")).toEqual({
    state: "succeeded",
    finishedAt: new Date(clock),
    durationMs: 0,
  });
  expect(builder.running("smoke")).toBe(false);
});

test("pull defaults through as true", async () => {
  await mkImage("smoke");
  await builder.build("smoke", { pull: true });
  expect(docker.calls.find((c) => c.op === "buildImage")?.args[0]).toMatchObject({ pull: true });
});

test("a second build of the same name joins the running one", async () => {
  await mkImage("smoke");
  const gate = deferred();
  const emitted = deferred();
  docker.builds.push({ gate: gate.promise, emitted: emitted.resolve });

  const first = builder.build("smoke", { pull: true });
  await emitted.promise;
  expect(builder.running("smoke")).toBe(true);
  expect(builder.log("smoke")).toMatchObject({ state: "building" });
  const second = builder.build("smoke", { pull: false });

  gate.resolve();
  await expect(first).resolves.toEqual({ state: "succeeded" });
  await expect(second).resolves.toEqual({ state: "succeeded" });
  expect(docker.calls.filter((c) => c.op === "buildImage")).toHaveLength(1);
});

test("two builds asked in the same tick run once", async () => {
  await mkImage("smoke");
  const results = await Promise.all([
    builder.build("smoke", { pull: true }),
    builder.build("smoke", { pull: true }),
  ]);
  expect(results).toEqual([{ state: "succeeded" }, { state: "succeeded" }]);
  expect(docker.calls.filter((c) => c.op === "buildImage")).toHaveLength(1);
});

test("a bad name rejects with ImageNameError and starts nothing", async () => {
  await expect(builder.build("../x", { pull: true })).rejects.toBeInstanceOf(ImageNameError);
  await expect(builder.build("missing", { pull: true })).rejects.toBeInstanceOf(ImageNameError);
  expect(frames).toEqual([]);
  expect(builder.last("missing")).toBeUndefined();
});

test("a failing build keeps the last 200 lines and the error", async () => {
  await mkImage("smoke");
  const many = Array.from({ length: 250 }, (_, i) => ({ stream: `line ${i}\n` }));
  docker.builds.push({ events: [...many, ...BUILD_EVENTS.runFalse()] });
  const started = clock;
  const p = builder.build("smoke", { pull: true });
  clock = started + 1500;

  const msg = RUN_FALSE;
  await expect(p).resolves.toEqual({ state: "failed", error: msg });
  const out = builder.log("smoke");
  expect(out.state).toBe("failed");
  expect(out.lines).toHaveLength(200);
  expect(out.lines.at(-1)).toBe(msg);
  expect(builder.last("smoke")).toEqual({
    state: "failed",
    finishedAt: new Date(started + 1500),
    error: msg,
    durationMs: 1500,
  });
  expect(docker.images.has(TAG)).toBe(false);
});

test("a denied base pull says how to build without pulling", async () => {
  await mkImage("smoke", "FROM open-factory-base:dev\nRUN true\n");
  docker.builds.push({ events: BUILD_EVENTS.pullDenied() });

  await expect(builder.build("smoke", { pull: true })).resolves.toEqual({
    state: "failed",
    error:
      "Base image open-factory-base:dev couldn't be pulled. If it's local-only, run `open-factory images build smoke --no-pull`.",
  });
  // Docker's own words stay in the log.
  expect(builder.log("smoke").lines.at(-1)).toMatch(/^pull access denied for open-factory-base/);
});

test("a Docker error before the build starts fails the build with its message", async () => {
  await mkImage("smoke");
  docker.down = Object.assign(new Error("connect ECONNREFUSED /var/run/docker.sock"), {
    code: "ECONNREFUSED",
  });
  await expect(builder.build("smoke", { pull: true })).resolves.toEqual({
    state: "failed",
    error: "connect ECONNREFUSED /var/run/docker.sock",
  });
  expect(builder.running("smoke")).toBe(false);
});

test("a context link outside the folder fails the build before Docker", async () => {
  const dir = await mkImage("smoke");
  const { symlink } = await import("node:fs/promises");
  await symlink("/etc/hosts", join(dir, "hosts"));
  await expect(builder.build("smoke", { pull: true })).resolves.toEqual({
    state: "failed",
    error: "images/smoke/hosts links outside the folder. Copy the file into the folder instead.",
  });
  expect(docker.ops()).not.toContain("buildImage");
});

test("output lines are batched every 250 ms into image_build frames, then the end state and images_changed", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  await mkImage("smoke");
  const gate = deferred();
  const emitted = deferred();
  docker.builds.push({
    events: [{ stream: "Step 1/2 : FROM x\n" }, { stream: "Step 2/2 : RUN true\n" }],
    gate: gate.promise,
    emitted: emitted.resolve,
  });
  const seen: string[] = [];
  const p = builder.build("smoke", { pull: true });
  const off = builder.subscribe("smoke", (l) => seen.push(l));
  await emitted.promise;

  expect(seen).toEqual(["Step 1/2 : FROM x", "Step 2/2 : RUN true"]);
  expect(frames).toEqual([{ type: "image_build", name: "smoke", state: "building" }]);
  vi.advanceTimersByTime(249);
  expect(frames).toHaveLength(1);
  vi.advanceTimersByTime(1);
  expect(frames).toEqual([
    { type: "image_build", name: "smoke", state: "building" },
    {
      type: "image_build",
      name: "smoke",
      state: "building",
      lines: ["Step 1/2 : FROM x", "Step 2/2 : RUN true"],
    },
  ]);

  gate.resolve();
  await p;
  off();
  expect(frames.slice(2)).toEqual([
    { type: "image_build", name: "smoke", state: "succeeded" },
    { type: "images_changed" },
  ]);
  expect(vi.getTimerCount()).toBe(0);
});

test("lines still pending at the end are sent before the end state", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  await mkImage("smoke");
  docker.builds.push({ events: BUILD_EVENTS.runFalse() });
  await builder.build("smoke", { pull: true });
  expect(frames.map((f) => (f.type === "image_build" ? [f.state, f.lines] : [f.type]))).toEqual([
    ["building", undefined],
    ["building", ["Step 2/2 : RUN false", RUN_FALSE]],
    ["failed", undefined],
    ["images_changed"],
  ]);
  expect(vi.getTimerCount()).toBe(0);
});

test("an unsubscribed listener gets no more lines", async () => {
  await mkImage("smoke");
  const seen: string[] = [];
  const p = builder.build("smoke", { pull: true });
  builder.subscribe("smoke", (l) => seen.push(l))();
  await p;
  expect(seen).toEqual([]);
});

test("log and last are empty for a name never built", () => {
  expect(builder.log("nope")).toEqual({ state: null, lines: [] });
  expect(builder.last("nope")).toBeUndefined();
  expect(builder.running("nope")).toBe(false);
});
