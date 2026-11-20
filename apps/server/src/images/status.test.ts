import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LABEL_BUILT_AT, LABEL_CONTEXT_HASH, type TemplateConfig } from "@open-factory/shared";
import { afterEach, beforeEach, expect, test } from "vitest";
import { FakeDockerClient } from "../runtime/docker/testing/fake-docker.ts";
import type { TemplateRow } from "../templates/template-index.ts";
import type { ImageBuilder } from "./builder.ts";
import { contextHash } from "./context.ts";
import { imageStatus, listImages, templateImageStatus } from "./status.ts";

const TAG = "open-factory-user/smoke:latest";
const DEFAULT = "ghcr.io/orlevii/open-factory/base:latest";

type Last = ReturnType<ImageBuilder["last"]>;

let root: string;
let docker: FakeDockerClient;
let running: Set<string>;
let lasts: Map<string, NonNullable<Last>>;
let d: Parameters<typeof imageStatus>[0];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "of-status-"));
  docker = new FakeDockerClient();
  running = new Set();
  lasts = new Map();
  d = {
    docker,
    imagesRoot: root,
    builder: { running: (n) => running.has(n), last: (n) => lasts.get(n) },
  };
});
afterEach(() => rm(root, { recursive: true, force: true }));

const mkImage = async (name: string, dockerfile = true) => {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  if (dockerfile) await writeFile(join(dir, "Dockerfile"), `FROM ${DEFAULT}\n`);
  return dir;
};
const built = async (name: string, builtAt: string, hash?: string) => {
  const dir = join(root, name);
  docker.images.set(`open-factory-user/${name}:latest`, {
    id: "sha256:img",
    labels: {
      [LABEL_CONTEXT_HASH]: hash ?? (await contextHash(dir, name)),
      [LABEL_BUILT_AT]: builtAt,
    },
  });
};
const failedAt = (iso: string): NonNullable<Last> => ({
  state: "failed",
  finishedAt: new Date(iso),
  error: "boom",
  durationMs: 10,
});
const down = () =>
  Object.assign(new Error("connect ECONNREFUSED /var/run/docker.sock"), { code: "ECONNREFUSED" });

test("no_dockerfile when the folder has no Dockerfile", async () => {
  await mkImage("smoke", false);
  expect(await imageStatus(d, "smoke")).toEqual({
    name: "smoke",
    status: "no_dockerfile",
    usedBy: [],
  });
});

test("building while a build runs", async () => {
  await mkImage("smoke");
  running.add("smoke");
  expect((await imageStatus(d, "smoke")).status).toBe("building");
});

test("failed when the last build failed and no image exists, with the last build", async () => {
  await mkImage("smoke");
  lasts.set("smoke", failedAt("2026-11-20T10:00:00.000Z"));
  expect(await imageStatus(d, "smoke")).toEqual({
    name: "smoke",
    status: "failed",
    usedBy: [],
    lastBuild: {
      state: "failed",
      finishedAt: "2026-11-20T10:00:00.000Z",
      error: "boom",
      durationMs: 10,
    },
  });
});

test("failed when the failure is newer than the existing image", async () => {
  await mkImage("smoke");
  await built("smoke", "2026-11-20T09:00:00.000Z");
  lasts.set("smoke", failedAt("2026-11-20T10:00:00.000Z"));
  expect(await imageStatus(d, "smoke")).toMatchObject({
    status: "failed",
    builtAt: "2026-11-20T09:00:00.000Z",
  });
});

test("an image newer than the failure reads from the image", async () => {
  await mkImage("smoke");
  await built("smoke", "2026-11-20T11:00:00.000Z");
  lasts.set("smoke", failedAt("2026-11-20T10:00:00.000Z"));
  expect((await imageStatus(d, "smoke")).status).toBe("built");
});

test("not_built when there is no local image", async () => {
  await mkImage("smoke");
  expect(await imageStatus(d, "smoke")).toEqual({ name: "smoke", status: "not_built", usedBy: [] });
});

test("built, then out_of_date after a file in the folder changes", async () => {
  const dir = await mkImage("smoke");
  await built("smoke", "2026-11-20T09:00:00.000Z");
  const hash = await contextHash(dir, "smoke");
  expect(await imageStatus(d, "smoke")).toEqual({
    name: "smoke",
    status: "built",
    builtAt: "2026-11-20T09:00:00.000Z",
    contextHash: hash,
    usedBy: [],
  });
  expect(docker.calls.find((c) => c.op === "imageInspect")?.args).toEqual([TAG]);

  await writeFile(join(dir, "extra.txt"), "x");
  expect(await imageStatus(d, "smoke")).toMatchObject({ status: "out_of_date", contextHash: hash });
});

test("unknown when Docker can't be reached", async () => {
  await mkImage("smoke");
  docker.down = down();
  expect((await imageStatus(d, "smoke")).status).toBe("unknown");
});

test("other Docker errors are not swallowed", async () => {
  await mkImage("smoke");
  docker.down = Object.assign(new Error("server error"), { statusCode: 500 });
  await expect(imageStatus(d, "smoke")).rejects.toThrow("server error");
});

test("listImages lists every valid image folder by name with the templates that use it", async () => {
  await mkImage("smoke");
  await mkImage("alpha", false);
  await mkdir(join(root, "Not Valid"));
  await writeFile(join(root, "README.md"), "x");
  const row = (name: string, image?: string): TemplateRow => ({
    name,
    path: join(root, name),
    config: image === "none" ? null : ({ name, image } as TemplateConfig),
    issues: [],
    contentHash: "h",
    scannedAt: new Date(),
  });
  const items = await listImages(d, [
    row("qa", "smoke"),
    row("dev", "smoke"),
    row("ops", DEFAULT),
    row("broken", "none"),
  ]);
  expect(items.map((i) => [i.name, i.status, i.usedBy])).toEqual([
    ["alpha", "no_dockerfile", []],
    ["smoke", "not_built", ["dev", "qa"]],
  ]);
});

test("templateImageStatus: registry refs are present or pulled on start, bare names carry the user status", async () => {
  const cfg = (image?: string) => ({ runtime: "docker", image }) as TemplateConfig;
  expect(await templateImageStatus(d, undefined, DEFAULT)).toBeUndefined();
  expect(await templateImageStatus(d, cfg(), DEFAULT)).toEqual({
    kind: "registry",
    name: DEFAULT,
    status: "pulled_on_start",
  });
  docker.images.set(DEFAULT, { id: "sha256:base", labels: {} });
  expect(await templateImageStatus(d, cfg(), DEFAULT)).toEqual({
    kind: "registry",
    name: DEFAULT,
    status: "present",
  });
  await mkImage("smoke");
  expect(await templateImageStatus(d, cfg("smoke"), DEFAULT)).toEqual({
    kind: "user",
    name: "smoke",
    status: "not_built",
  });
  expect(
    await templateImageStatus(d, { runtime: "local" } as TemplateConfig, DEFAULT),
  ).toBeUndefined();
  docker.down = down();
  expect(await templateImageStatus(d, cfg(), DEFAULT)).toMatchObject({ status: "unknown" });
});
