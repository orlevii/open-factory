import { mkdirSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import type { ImagesList, TemplateDetail } from "@open-factory/shared";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { FakeDriver } from "../agents/testing/fake-driver.ts";
import { BUILD_EVENTS, FakeDockerClient } from "../runtime/docker/testing/fake-docker.ts";
import { makeTestApp, signUp } from "../test/helpers.ts";

/** S10 §10.5, §13, AC7, AC8: the images REST surface and the templates' image status, human session only. */
const BASE = "ghcr.io/orlevii/open-factory/base:latest";
const TAG = "open-factory-user/smoke:latest";

let h: Awaited<ReturnType<typeof makeTestApp>>;
let or: Awaited<ReturnType<typeof signUp>>;
let docker: FakeDockerClient;

beforeEach(async () => {
  docker = new FakeDockerClient();
  h = await makeTestApp({ harnessDriver: new FakeDriver(), docker });
  or = await signUp(h.app, { handle: "or" });
  const dir = path.join(h.factoryHome, "images/smoke");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "Dockerfile"), `FROM ${BASE}\nRUN true\n`);
});
afterEach(() => h.close());

const req = (method: "GET" | "POST", url: string, payload?: object, accept?: string) =>
  h.app.inject({
    method,
    url,
    headers: { cookie: or.cookie, ...(accept ? { accept } : {}) },
    ...(payload ? { payload } : {}),
  });

test("GET /api/images returns the folder, the base image and every image's status", async () => {
  const r = await req("GET", "/api/images");
  expect(r.statusCode).toBe(200);
  const body = r.json() as ImagesList;
  expect(body.imagesDir).toBe(path.join(h.factoryHome, "images"));
  expect(body.baseImage).toBe(h.config.defaultImage);
  expect(body.images).toEqual([{ name: "smoke", status: "not_built", usedBy: [] }]);
});

/** Holds the next build open once Docker has it, so the running build's `pull` can be read. */
function gatedBuild() {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const reached = new Promise<void>((r) => {
    docker.builds.push({ gate, emitted: r });
  });
  return { reached, release };
}
const buildCall = () => docker.calls.find((c) => c.op === "buildImage")?.args[0];

test("POST build answers 202 building and builds with pull on by default", async () => {
  const { reached, release } = gatedBuild();
  const r = await req("POST", "/api/images/smoke/build");
  expect(r.statusCode).toBe(202);
  expect(r.json()).toEqual({ state: "building" });
  await reached;
  expect(h.app.images.runningPull("smoke")).toBe(true);
  expect(buildCall()).toMatchObject({ tag: TAG, pull: true });
  release();
  await vi.waitFor(() => expect(h.app.images.running("smoke")).toBe(false));
});

test("POST build with pull:false passes it to Docker", async () => {
  const { reached, release } = gatedBuild();
  const r = await req("POST", "/api/images/smoke/build", { pull: false });
  expect(r.statusCode).toBe(202);
  await reached;
  expect(h.app.images.runningPull("smoke")).toBe(false);
  expect(buildCall()).toMatchObject({ pull: false });
  release();
  await vi.waitFor(() => expect(h.app.images.running("smoke")).toBe(false));
});

test("with Accept ndjson the response streams the lines and ends with the state", async () => {
  const r = await req("POST", "/api/images/smoke/build", {}, "application/x-ndjson");
  expect(r.statusCode).toBe(200);
  expect(r.headers["content-type"]).toContain("application/x-ndjson");
  expect(r.headers["cache-control"]).toBe("no-store");
  expect(r.headers["x-accel-buffering"]).toBe("no");
  const lines = r.body
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  expect(lines.slice(0, -1).every((l) => typeof l.line === "string")).toBe(true);
  expect(lines.some((l) => l.line.includes("Successfully tagged"))).toBe(true);
  expect(lines.at(-1)).toEqual({ state: "succeeded" });
});

test("a failed build ends the stream with the state and error", async () => {
  docker.builds.push({ events: BUILD_EVENTS.runFalse() });
  const r = await req("POST", "/api/images/smoke/build", {}, "application/x-ndjson");
  const last = JSON.parse(r.body.trim().split("\n").at(-1) ?? "");
  expect(last.state).toBe("failed");
  expect(last.error).toContain("returned a non-zero code");
});

test("a client abort mid-stream does not cancel the build", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const emitted = new Promise<void>((r) => {
    docker.builds.push({ events: BUILD_EVENTS.ok(TAG), gate, emitted: r });
  });
  await h.app.listen({ port: 0, host: "127.0.0.1" });
  const addr = h.app.server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  const firstChunk = await new Promise<string>((resolve, reject) => {
    const rq = http.request(
      {
        host: "127.0.0.1",
        port,
        path: "/api/images/smoke/build",
        method: "POST",
        headers: {
          cookie: or.cookie,
          accept: "application/x-ndjson",
          "content-type": "application/json",
          origin: "http://localhost:3000",
        },
      },
      (res) => {
        res.once("data", (c: Buffer) => {
          resolve(c.toString());
          rq.destroy();
        });
      },
    );
    rq.on("error", () => {});
    rq.on("close", () => reject(new Error("closed before data")));
    rq.end("{}");
  });
  expect(firstChunk).toContain('{"line":');
  await emitted;
  release();
  expect(await h.app.images.build("smoke", { pull: true })).toEqual({ state: "succeeded" });
  expect(h.app.images.last("smoke")?.state).toBe("succeeded");
});

test("an invalid or missing image name is 400 invalid_image_name", async () => {
  for (const name of ["..%2Fx", "nope", "UPPER"]) {
    const r = await req("POST", `/api/images/${name}/build`);
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe("invalid_image_name");
    const n = await req("POST", `/api/images/${name}/build`, {}, "application/x-ndjson");
    expect(n.statusCode).toBe(400);
  }
});

test("GET log returns the last build's lines", async () => {
  expect((await req("GET", "/api/images/smoke/log")).json()).toEqual({ state: null, lines: [] });
  await req("POST", "/api/images/smoke/build");
  await h.app.images.build("smoke", { pull: true });
  const log = (await req("GET", "/api/images/smoke/log")).json();
  expect(log.state).toBe("succeeded");
  expect(log.lines.join("\n")).toContain("Successfully tagged");
});

test("a stream that joins a running build with a different pull says so", async () => {
  let release!: () => void;
  let reached!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const emitted = new Promise<void>((r) => {
    reached = r;
  });
  docker.builds.push({ gate, emitted: reached });
  const first = h.app.images.build("smoke", { pull: true });
  await emitted;
  const subscribed = new Promise<void>((r) => {
    const real = h.app.images.subscribe.bind(h.app.images);
    vi.spyOn(h.app.images, "subscribe").mockImplementation((name, fn) => {
      const off = real(name, fn);
      r();
      return off;
    });
  });
  const joined = req("POST", "/api/images/smoke/build", { pull: false }, "application/x-ndjson");
  await subscribed;
  release();
  const r = await joined;
  await first;
  expect(r.body).toContain(
    "Joined the running build of smoke, which has pull on; this request's pull off doesn't apply to it.",
  );
});

test("the templates list and detail carry imageStatus", async () => {
  const dir = path.join(h.factoryHome, "templates/web");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "template.yaml"),
    "name: web\ndisplay_name: Web\nruntime: docker\nimage: smoke\n",
  );
  const list = (await req("GET", "/api/templates")).json();
  expect(list.templates.find((t: { name: string }) => t.name === "web").imageStatus).toEqual({
    kind: "user",
    name: "smoke",
    status: "not_built",
  });
  const detail = (await req("GET", "/api/templates/web")).json().template as TemplateDetail;
  expect(detail.imageStatus).toEqual({ kind: "user", name: "smoke", status: "not_built" });
  expect(((await req("GET", "/api/images")).json() as ImagesList).images[0]?.usedBy).toEqual([
    "web",
  ]);
});

test("a Docker error on one image's inspect never fails the templates list or detail: status unknown", async () => {
  for (const [name, image] of [
    ["web", "smoke"],
    ["api", "docker.io/library/node:22"],
  ]) {
    const dir = path.join(h.factoryHome, `templates/${name}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "template.yaml"),
      `name: ${name}\ndisplay_name: ${name}\nruntime: docker\nimage: ${image}\n`,
    );
  }
  vi.spyOn(docker, "imageInspect").mockRejectedValue(
    Object.assign(new Error("invalid checksum digest length"), { statusCode: 400 }),
  );
  const list = await req("GET", "/api/templates");
  expect(list.statusCode).toBe(200);
  const statuses = (list.json() as { templates: TemplateDetail[] }).templates.map((t) => [
    t.name,
    t.imageStatus?.status,
  ]);
  expect(statuses).toEqual(
    expect.arrayContaining([
      ["web", "unknown"],
      ["api", "unknown"],
    ]),
  );
  const detail = await req("GET", "/api/templates/api");
  expect(detail.statusCode).toBe(200);
  expect((detail.json().template as TemplateDetail).imageStatus?.status).toBe("unknown");
  const images = await req("GET", "/api/images");
  expect(images.statusCode).toBe(200);
  expect((images.json() as ImagesList).images[0]?.status).toBe("unknown");
});

test.each([
  ["GET", "/api/images"],
  ["GET", "/api/images/smoke/log"],
  ["POST", "/api/images/smoke/build"],
] as const)(
  "%s %s needs a human session: no auth and an agent token both get 401",
  async (method, url) => {
    expect((await h.app.inject({ method, url })).statusCode).toBe(401);
    const { id } = await h.seedAgent({ slug: "lead" });
    const { token } = h.app.agentTokens.mint(id);
    const r = await h.app.inject({ method, url, headers: { authorization: `Bearer ${token}` } });
    expect(r.statusCode).toBe(401);
  },
);
