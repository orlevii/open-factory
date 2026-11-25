import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { schema } from "@open-factory/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { FakeDriver } from "../agents/testing/fake-driver.ts";
import { makeTestApp } from "../test/helpers.ts";
import { bodyStream, UploadIdleError } from "../uploads/body-stream.ts";
import { heic, jpeg, png } from "../uploads/fixtures.ts";
import { UploadService } from "../uploads/service.ts";
import { agentWorkdir } from "../workspace/paths.ts";

let t: Awaited<ReturnType<typeof makeTestApp>>;
let or: string;
let kim: string;
const MiB = 1024 * 1024;

beforeAll(async () => {
  t = await makeTestApp({ harnessDriver: new FakeDriver() });
  await t.seedAgent({ slug: "dev" });
  await t.seedAgent({ slug: "ops" });
  await t.seedAgent({ slug: "gone" });
  await t.seedAgent({ slug: "shelved" });
  const dev = await t.db.select().from(schema.agents).where(eq(schema.agents.slug, "dev"));
  await t.db
    .update(schema.agents)
    .set({
      kind: "ephemeral",
      reportsTo: dev[0]?.id,
      reportsToUser: null,
      terminatedAt: new Date(),
    })
    .where(eq(schema.agents.slug, "gone"));
  await t.db
    .update(schema.agents)
    .set({ archivedAt: new Date() })
    .where(eq(schema.agents.slug, "shelved"));
  or = (await t.signUpUser({ handle: "or" })).cookie;
  kim = (await t.signUpUser({ handle: "kim", email: "kim@example.com" })).cookie;
});
afterAll(() => t.close());

const wd = (slug: string) => agentWorkdir(t.factoryHome, slug);
const uploadsDir = (slug: string) => path.join(wd(slug), ".factory/uploads");
const listUploads = (slug: string) =>
  existsSync(uploadsDir(slug)) ? readdirSync(uploadsDir(slug)) : [];

const upload = (
  slug: string,
  payload: Buffer | Readable,
  name = "shot.png",
  o: { cookie?: string; headers?: Record<string, string> } = {},
) =>
  t.app.inject({
    method: "POST",
    url: `/api/agents/${slug}/uploads`,
    headers: {
      cookie: o.cookie ?? or,
      "content-type": "application/octet-stream",
      "x-upload-name": encodeURIComponent(name),
      ...o.headers,
    },
    payload,
  });
const get = (slug: string, id: string, cookie = or) =>
  t.app.inject({ method: "GET", url: `/api/agents/${slug}/uploads/${id}`, headers: { cookie } });
const del = (slug: string, id: string, cookie = or) =>
  t.app.inject({ method: "DELETE", url: `/api/agents/${slug}/uploads/${id}`, headers: { cookie } });

test("POST stores a PNG under .factory/uploads with a safe name and answers its info", async () => {
  const data = png(640, 480);
  const res = await upload("dev", data, "shot é [1].png");
  expect(res.statusCode).toBe(201);
  const body = res.json();
  expect(body).toEqual({
    uploadId: expect.any(String),
    kind: "image",
    bytes: data.length,
    width: 640,
    height: 480,
    name: "shot é [1].png",
  });
  const [row] = await t.db
    .select()
    .from(schema.uploads)
    .where(eq(schema.uploads.id, body.uploadId));
  expect(row).toMatchObject({ messageId: null, originalName: "shot é [1].png", kind: "image" });
  expect(row?.storedPath).toMatch(
    new RegExp(`^\\.factory/uploads/\\d{8}-${body.uploadId}-shot----1-\\.png$`),
  );
  const file = path.join(wd("dev"), row?.storedPath ?? "");
  expect(readFileSync(file)).toEqual(data);
  expect(statSync(file).mode & 0o777).toBe(0o644);
  expect(statSync(uploadsDir("dev")).mode & 0o777).toBe(0o755);
});

test("a JPEG and UTF-8 text are accepted by content (sniff.test.ts owns every type)", async () => {
  for (const [data, name, kind] of [
    [jpeg(100, 50), "a.jpg", "image"],
    [Buffer.from("# Notes\nhello\n"), "notes.md", "text"],
  ] as const) {
    const res = await upload("dev", data, name);
    expect(res.statusCode, name).toBe(201);
    expect(res.json().kind).toBe(kind);
  }
});

test("auth, a missing agent and an ended agent: the messaging access check", async () => {
  const anon = await t.app.inject({
    method: "POST",
    url: "/api/agents/dev/uploads",
    headers: { "content-type": "application/octet-stream", "x-upload-name": "a.txt" },
    payload: Buffer.from("x"),
  });
  expect(anon.statusCode).toBe(401);
  expect((await upload("nope", Buffer.from("x"), "a.txt")).statusCode).toBe(404);
  const ended = await upload("gone", Buffer.from("x"), "a.txt");
  expect(ended.statusCode).toBe(409);
  expect(ended.json().error.code).toBe("agent_terminated");
  const archived = await upload("shelved", Buffer.from("x"), "a.txt");
  expect(archived.statusCode).toBe(409);
  expect(archived.json().error.code).toBe("agent_archived");
  expect(listUploads("gone")).toEqual([]);
  expect(listUploads("shelved")).toEqual([]);
});

test("the name header is required and must decode", async () => {
  const none = await t.app.inject({
    method: "POST",
    url: "/api/agents/dev/uploads",
    headers: { cookie: or, "content-type": "application/octet-stream" },
    payload: Buffer.from("x"),
  });
  expect(none.statusCode).toBe(400);
  const bad = await upload("dev", Buffer.from("x"), "a.txt", {
    headers: { "x-upload-name": "%E0%A4%A" },
  });
  expect(bad.statusCode).toBe(400);
});

test("a Content-Length over 20 MiB is refused up front with 413", async () => {
  const before = listUploads("ops");
  let pulled = 0;
  const body = new Readable({
    read() {
      pulled++;
      this.push(Buffer.alloc(1024));
      if (pulled > 4) this.push(null);
    },
  });
  const res = await upload("ops", body, "big.txt", {
    headers: { "content-length": String(20 * MiB + 1) },
  });
  expect(res.statusCode).toBe(413);
  expect(res.json().error.code).toBe("too_large");
  expect(listUploads("ops")).toEqual(before);
});

test("a stream crossing 20 MiB is refused with 413 and its temp file deleted", async () => {
  const before = listUploads("ops");
  let sent = 0;
  const body = new Readable({
    read() {
      if (sent >= 21 * MiB) return this.push(null);
      sent += MiB;
      this.push(Buffer.alloc(MiB, 0x61));
    },
  });
  const res = await upload("ops", body, "big.txt");
  expect(res.statusCode).toBe(413);
  expect(res.json().error.code).toBe("too_large");
  expect(listUploads("ops")).toEqual(before);
  expect(
    await t.db.select().from(schema.uploads).where(eq(schema.uploads.originalName, "big.txt")),
  ).toEqual([]);
});

test("SVG, HTML, HEIC and UTF-16 are 415 with a reason; nothing is kept", async () => {
  const before = listUploads("ops");
  const cases: [Buffer, string, string][] = [
    [
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
      "x.png",
      "SVG isn't supported; export it as PNG.",
    ],
    [Buffer.from("<!doctype html><script>1</script>"), "x.txt", "HTML files aren't supported."],
    [heic(), "IMG_1.HEIC", "HEIC isn't supported; export as JPEG"],
    [
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("hi", "utf16le")]),
      "u.txt",
      "UTF-16 text isn't supported; save it as UTF-8.",
    ],
  ];
  for (const [data, name, reason] of cases) {
    const res = await upload("ops", data, name);
    expect(res.statusCode, name).toBe(415);
    expect(res.json().error).toEqual({ code: "unsupported_type", message: reason });
  }
  expect(listUploads("ops")).toEqual(before);
});

test("a 30000×30000 PNG header is 422 without decoding", async () => {
  const res = await upload("ops", png(30000, 30000), "huge.png");
  expect(res.statusCode).toBe(422);
  expect(res.json().error).toEqual({
    code: "image_too_large",
    message: "Image is too large (max 8000 px a side).",
  });
});

test("a symlinked .factory refuses the upload and nothing is written outside the workspace", async () => {
  await t.seedAgent({ slug: "linked" });
  const outside = realpathSync(mkdtempSync(path.join(tmpdir(), "outside-")));
  symlinkSync(outside, path.join(wd("linked"), ".factory"));
  const res = await upload("linked", Buffer.from("hello"), "a.txt");
  expect(res.statusCode).toBe(409);
  expect(res.json().error).toEqual({
    code: "unsafe_workspace",
    message:
      "The agent's .factory folder is a link or isn't a folder; the factory won't write through it.",
  });
  // Finding D16: no server path in what the chip shows.
  expect(res.body).not.toContain(t.factoryHome);
  expect(readdirSync(outside)).toEqual([]);
  expect(
    await t.db.select().from(schema.uploads).where(eq(schema.uploads.originalName, "a.txt")),
  ).toEqual([]);
});

test("GET sends nosniff, a sandboxing CSP, no-store and the sniffed type; text is an attachment; a swapped or resized file is refused", async () => {
  const img = (await upload("dev", png(8, 8), "pic.txt")).json();
  const r1 = await get("dev", img.uploadId);
  expect(r1.statusCode).toBe(200);
  expect(r1.headers["content-type"]).toBe("image/png");
  expect(r1.headers["x-content-type-options"]).toBe("nosniff");
  // Uploaded bytes are untrusted: no script, no framing, no caching of what a human sent.
  expect(r1.headers["content-security-policy"]).toBe("default-src 'none'; sandbox");
  expect(r1.headers["cache-control"]).toBe("private, no-store");
  expect(String(r1.headers["content-disposition"])).toMatch(/^inline/);
  expect(r1.rawPayload).toEqual(png(8, 8));

  const txt = (await upload("dev", Buffer.from("plain\n"), "page.md")).json();
  const r2 = await get("dev", txt.uploadId);
  expect(r2.headers["content-type"]).toBe("text/plain; charset=utf-8");
  expect(r2.headers["x-content-type-options"]).toBe("nosniff");
  expect(r2.headers["content-security-policy"]).toBe("default-src 'none'; sandbox");
  expect(r2.headers["cache-control"]).toBe("private, no-store");
  expect(String(r2.headers["content-disposition"])).toMatch(/^attachment; filename="page.md"/);
  expect(r2.body).toBe("plain\n");

  const [row] = await t.db.select().from(schema.uploads).where(eq(schema.uploads.id, txt.uploadId));
  const file = path.join(wd("dev"), row?.storedPath ?? "");
  writeFileSync(file, "PLAIN\n"); // swapped, same size
  expect((await get("dev", txt.uploadId)).statusCode).toBe(409);
  writeFileSync(file, "plain and more\n"); // resized
  expect((await get("dev", txt.uploadId)).statusCode).toBe(409);
  rmSync(file);
  symlinkSync(path.join(wd("dev"), "AGENTS.md"), file); // a planted link
  expect((await get("dev", txt.uploadId)).statusCode).toBe(409);
});

test("no cross-agent or cross-user reads and deletes of an unsent upload", async () => {
  const mine = (await upload("dev", Buffer.from("secret draft\n"), "d.txt")).json();
  expect((await get("ops", mine.uploadId)).statusCode).toBe(404); // another agent's URL
  expect((await get("dev", mine.uploadId, kim)).statusCode).toBe(404); // another user, unsent
  expect((await del("ops", mine.uploadId)).statusCode).toBe(404);
  expect((await del("dev", mine.uploadId, kim)).statusCode).toBe(404);
  expect((await get("dev", "not-an-id")).statusCode).toBe(404);
  expect((await get("dev", mine.uploadId)).statusCode).toBe(200);
});

test("DELETE by the uploader while unsent removes row and file; a sent upload can't be deleted", async () => {
  const a = (await upload("dev", Buffer.from("bye\n"), "bye.txt")).json();
  const [row] = await t.db.select().from(schema.uploads).where(eq(schema.uploads.id, a.uploadId));
  const file = path.join(wd("dev"), row?.storedPath ?? "");
  expect(existsSync(file)).toBe(true);
  const res = await del("dev", a.uploadId);
  expect(res.statusCode).toBe(204);
  expect(existsSync(file)).toBe(false);
  expect(await t.db.select().from(schema.uploads).where(eq(schema.uploads.id, a.uploadId))).toEqual(
    [],
  );

  const b = (await upload("dev", Buffer.from("kept\n"), "kept.txt")).json();
  const sent = await t.app.inject({
    method: "POST",
    url: "/api/messages",
    headers: { cookie: or },
    payload: { to: ["dev"], body: "see attached", attachments: [b.uploadId] },
  });
  expect(sent.statusCode).toBe(202);
  const [claimed] = await t.db
    .select()
    .from(schema.uploads)
    .where(eq(schema.uploads.id, b.uploadId));
  expect(claimed?.messageId).toBe(sent.json().results[0].item.id);
  const refused = await del("dev", b.uploadId);
  expect(refused.statusCode).toBe(409);
  expect(refused.json().error.code).toBe("already_sent");
  expect((await del("dev", b.uploadId, kim)).statusCode).toBe(403);
  // A sent upload is part of the session: any signed-in human who can read it may preview it.
  expect((await get("dev", b.uploadId, kim)).statusCode).toBe(200);
});

test("the sweep deletes unsent uploads older than 24 hours, and only those", async () => {
  const old = (await upload("ops", Buffer.from("old\n"), "old.txt")).json();
  const fresh = (await upload("ops", Buffer.from("fresh\n"), "fresh.txt")).json();
  const oldSent = (await upload("ops", Buffer.from("old sent\n"), "old-sent.txt")).json();
  const msg = await t.app.inject({
    method: "POST",
    url: "/api/messages",
    headers: { cookie: or },
    payload: { to: ["ops"], body: "x" },
  });
  await t.db
    .update(schema.uploads)
    .set({ messageId: msg.json().results[0].item.id })
    .where(eq(schema.uploads.id, oldSent.uploadId));
  const longAgo = new Date(Date.now() - 25 * 3_600_000);
  for (const id of [old.uploadId, oldSent.uploadId])
    await t.db.update(schema.uploads).set({ createdAt: longAgo }).where(eq(schema.uploads.id, id));
  const rows = await t.db.select().from(schema.uploads);
  const pathOf = (id: string) =>
    path.join(wd("ops"), rows.find((r) => r.id === id)?.storedPath ?? "");

  expect(await t.app.uploads.sweepUnsent()).toBe(1);
  expect(existsSync(pathOf(old.uploadId))).toBe(false);
  expect(existsSync(pathOf(fresh.uploadId))).toBe(true);
  expect(existsSync(pathOf(oldSent.uploadId))).toBe(true);
  const left = (await t.db.select().from(schema.uploads)).map((r) => r.id);
  expect(left).not.toContain(old.uploadId);
  expect(left).toEqual(expect.arrayContaining([fresh.uploadId, oldSent.uploadId]));
});

test("an upload adds .factory/ to the repository's info/exclude (git-exclude.test.ts owns the detail)", async () => {
  await t.seedAgent({ slug: "repo" });
  execFileSync("git", ["init", "-q"], { cwd: wd("repo") });
  mkdirSync(path.join(wd("repo"), ".git/info"), { recursive: true });
  expect((await upload("repo", Buffer.from("a\n"), "a.txt")).statusCode).toBe(201);
  const exclude = readFileSync(path.join(wd("repo"), ".git/info/exclude"), "utf8");
  expect(exclude.split("\n")).toContain(".factory/");
});

test("over real HTTP: a chunked body crossing 20 MiB gets its 413 and the connection closes", async () => {
  const { request } = await import("node:http");
  await t.app.listen({ port: 0, host: "127.0.0.1" });
  const port = (t.app.server.address() as { port: number }).port;
  const before = listUploads("ops");
  const res413 = await new Promise<{ status: number; connection: unknown }>((resolve, reject) => {
    const r = request(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: "/api/agents/ops/uploads",
        headers: {
          cookie: or,
          "content-type": "application/octet-stream",
          "x-upload-name": "big.txt",
          "transfer-encoding": "chunked",
        },
      },
      (res) => {
        res.resume();
        resolve({ status: res.statusCode ?? 0, connection: res.headers.connection });
      },
    );
    r.on("error", (e: NodeJS.ErrnoException) => {
      // The server may close before every chunk was written; the status already arrived.
      if (e.code !== "EPIPE" && e.code !== "ECONNRESET") reject(e);
    });
    const chunk = Buffer.alloc(MiB, 0x61);
    let n = 0;
    const pump = () => {
      while (n < 30) {
        n++;
        if (!r.write(chunk)) return r.once("drain", pump);
      }
      r.end();
    };
    pump();
  });
  expect(res413.status).toBe(413);
  // The rest of the body is unread, so the server must not keep the connection for another request.
  expect(res413.connection).toBe("close");
  // The temp file is deleted once the handler has unwound.
  await vi.waitFor(() => expect(listUploads("ops")).toEqual(before));
});

describe("security review fixes", () => {
  test("I2: a control character in X-Upload-Name is 400 and nothing is kept", async () => {
    await t.seedAgent({ slug: "ctl" });
    const res = await upload("ctl", Buffer.from("x\n"), "a.txt", {
      headers: { "x-upload-name": "a%00.txt" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("validation_error");
    expect((await upload("ctl", Buffer.from("x\n"), "a\u0085b.txt")).statusCode).toBe(400);
    expect(listUploads("ctl")).toEqual([]);
  });

  test("I2: a failure after the file is written (the insert) removes the file", async () => {
    const [agent] = await t.db.select().from(schema.agents).where(eq(schema.agents.slug, "ctl"));
    const [me] = await t.db.select().from(schema.users).where(eq(schema.users.handle, "or"));
    if (!agent || !me) throw new Error("seed");
    async function* one() {
      yield Buffer.from("x\n");
    }
    // Postgres can't store a NUL in text: the insert throws after the bytes landed.
    await expect(t.app.uploads.create(agent, me.id, "a\u0000.txt", one())).rejects.toThrow();
    expect(listUploads("ctl")).toEqual([]);
  });

  test("I1: a .factory swapped for a link between the walk and the open is 409 and nothing appears outside", async () => {
    await t.seedAgent({ slug: "race" });
    expect((await upload("race", Buffer.from("first\n"), "first.txt")).statusCode).toBe(201);
    const outside = realpathSync(mkdtempSync(path.join(tmpdir(), "outside-")));
    mkdirSync(path.join(outside, "uploads"));
    const { renameSync } = await import("node:fs");
    t.app.uploads.storeHooks = {
      beforeOpen: async () => {
        renameSync(path.join(wd("race"), ".factory"), path.join(wd("race"), ".factory-moved"));
        symlinkSync(outside, path.join(wd("race"), ".factory"));
      },
    };
    try {
      const res = await upload("race", Buffer.from("secret\n"), "raced.txt");
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe("unsafe_workspace");
    } finally {
      t.app.uploads.storeHooks = {};
    }
    expect(readdirSync(path.join(outside, "uploads"))).toEqual([]);
    expect(
      await t.db.select().from(schema.uploads).where(eq(schema.uploads.originalName, "raced.txt")),
    ).toEqual([]);
  });

  test("I3: a FACTORY_HOME reached through a symlink works, and info/exclude is written", async () => {
    await t.seedAgent({ slug: "aliased" });
    execFileSync("git", ["init", "-q"], { cwd: wd("aliased") });
    const alias = path.join(realpathSync(mkdtempSync(path.join(tmpdir(), "alias-"))), "home");
    symlinkSync(t.factoryHome, alias);
    const svc = new UploadService({
      db: t.db,
      factoryHome: alias,
      lock: t.app.workspaceLock,
      log: { debug() {}, info() {}, warn() {}, error() {} },
    });
    const [agent] = await t.db
      .select()
      .from(schema.agents)
      .where(eq(schema.agents.slug, "aliased"));
    const [me] = await t.db.select().from(schema.users).where(eq(schema.users.handle, "or"));
    if (!agent || !me) throw new Error("seed");
    async function* one() {
      yield Buffer.from("hello\n");
    }
    const r = await svc.create(agent, me.id, "a.txt", one());
    expect(r).toMatchObject({ kind: "text" });
    expect(listUploads("aliased")).toHaveLength(1);
    expect(readFileSync(path.join(wd("aliased"), ".git/info/exclude"), "utf8")).toContain(
      ".factory/\n",
    );
  });

  test("M1: at most 20 unsent uploads per agent and uploader; at most 3 streaming per agent", async () => {
    await t.seedAgent({ slug: "quota" });
    const [agent] = await t.db.select().from(schema.agents).where(eq(schema.agents.slug, "quota"));
    const [me] = await t.db.select().from(schema.users).where(eq(schema.users.handle, "or"));
    if (!agent || !me) throw new Error("seed");
    await t.db.insert(schema.uploads).values(
      Array.from({ length: 20 }, (_, i) => ({
        id: `fake-${i}`,
        agentId: agent.id,
        uploaderId: me.id,
        storedPath: `.factory/uploads/20261122-fake-${i}.txt`,
        originalName: `${i}.txt`,
        kind: "text" as const,
        bytes: 1,
        sha256: "0",
      })),
    );
    const res = await upload("quota", Buffer.from("x\n"), "21.txt");
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe("too_many_uploads");
    // Another human's quota is separate.
    expect((await upload("quota", Buffer.from("x\n"), "kim.txt", { cookie: kim })).statusCode).toBe(
      201,
    );
    await t.db.delete(schema.uploads).where(eq(schema.uploads.agentId, agent.id));

    const releases: (() => void)[] = [];
    const stalled = () =>
      (async function* () {
        yield Buffer.from("x");
        await new Promise<void>((r) => releases.push(r));
      })();
    const running = [1, 2, 3].map((i) => t.app.uploads.create(agent, me.id, `${i}.txt`, stalled()));
    await new Promise((r) => setTimeout(r, 50));
    const fourth = await upload("quota", Buffer.from("x\n"), "4.txt");
    expect(fourth.statusCode).toBe(429);
    // Review m3: the slots are per uploader; another human still gets through.
    expect(
      (await upload("quota", Buffer.from("x\n"), "kim2.txt", { cookie: kim })).statusCode,
    ).toBe(201);
    for (const r of releases) r();
    await Promise.all(running);
    expect((await upload("quota", Buffer.from("x\n"), "5.txt")).statusCode).toBe(201);
  });

  test("M2: the sweep also deletes an old upload file no row references", async () => {
    await t.seedAgent({ slug: "orphans" });
    expect((await upload("orphans", Buffer.from("x\n"), "a.txt")).statusCode).toBe(201);
    const { utimesSync } = await import("node:fs");
    const stray = path.join(
      uploadsDir("orphans"),
      "20261101-00000000-0000-4000-8000-000000000009-x.txt",
    );
    writeFileSync(stray, "x");
    const old = new Date(Date.now() - 30 * 3_600_000);
    utimesSync(stray, old, old);
    await t.app.uploads.sweepUnsent();
    expect(existsSync(stray)).toBe(false);
    expect(listUploads("orphans")).toHaveLength(1);
  });

  test("M4: filename* escapes ' ( ) * ! (RFC 5987)", async () => {
    const r = (await upload("dev", Buffer.from("x\n"), "it's (1)*!.txt")).json();
    const res = await get("dev", r.uploadId);
    expect(String(res.headers["content-disposition"])).toContain(
      "filename*=UTF-8''it%27s%20%281%29%2A%21.txt",
    );
  });

  test("M5: GET for a deleted workspace is 410 workspace_gone", async () => {
    await t.seedAgent({ slug: "wiped" });
    const r = (await upload("wiped", Buffer.from("x\n"), "a.txt")).json();
    rmSync(wd("wiped"), { recursive: true, force: true });
    const res = await get("wiped", r.uploadId);
    expect(res.statusCode).toBe(410);
    expect(res.json().error.code).toBe("workspace_gone");
  });

  test("M7: a body that isn't application/octet-stream is 415", async () => {
    const res = await t.app.inject({
      method: "POST",
      url: "/api/agents/dev/uploads",
      headers: { cookie: or, "content-type": "text/plain", "x-upload-name": "a.txt" },
      payload: "hello",
    });
    expect(res.statusCode).toBe(415);
    expect(res.json().error.code).toBe("unsupported_media_type");
  });
});

test("review m3: a stalled body is abandoned and its temp file deleted", async () => {
  await t.seedAgent({ slug: "stall" });
  const [agent] = await t.db.select().from(schema.agents).where(eq(schema.agents.slug, "stall"));
  const [me] = await t.db.select().from(schema.users).where(eq(schema.users.handle, "or"));
  if (!agent || !me) throw new Error("seed");
  async function* stalled() {
    yield Buffer.from("partial");
    await new Promise(() => {});
  }
  const err = await t.app.uploads
    .create(agent, me.id, "s.txt", bodyStream(stalled(), 50))
    .catch((e) => e);
  expect(err).toBeInstanceOf(UploadIdleError);
  expect(listUploads("stall")).toEqual([]);
  // The slot was released.
  expect((await upload("stall", Buffer.from("ok\n"), "ok.txt")).statusCode).toBe(201);
});
