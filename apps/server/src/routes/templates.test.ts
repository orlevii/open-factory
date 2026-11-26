import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { makeTestApp } from "../test/helpers.ts";

let h: Awaited<ReturnType<typeof makeTestApp>>;
let cookie: string;

beforeAll(async () => {
  h = await makeTestApp();
  cookie = (await h.signUpUser()).cookie;
});
afterAll(() => h.close());

const call = (method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: object) =>
  h.app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });
const get = (url: string) => call("GET", url);
const put = (url: string, payload: object) => call("PUT", url, payload);
const post = (url: string, payload: object) => call("POST", url, payload);
const del = (url: string) => call("DELETE", url);

test("list rescans; summaries carry counts and optional fields for unparseable templates", async () => {
  mkdirSync(path.join(h.factoryHome, "templates/broken"), { recursive: true });
  writeFileSync(path.join(h.factoryHome, "templates/broken/template.yaml"), "name: [");
  const r = await get("/api/templates");
  expect(r.statusCode).toBe(200);
  expect(r.json().dir).toBe(path.join(h.factoryHome, "templates"));
  expect(r.json().templates.find((t: { name: string }) => t.name === "broken")).toMatchObject({
    errors: 2,
    warnings: 0,
    agentCount: 0,
  });
});

test("traversal and bad names never reach the filesystem", async () => {
  for (const url of ["/api/templates/..%2F..%2Fetc", "/api/templates/%2Ftmp"])
    expect((await del(url)).statusCode).toBe(400);
  expect(
    (await put("/api/templates/lead/files/..%2Fsecret", { content: "", baseHash: null }))
      .statusCode,
  ).toBe(400);
  expect(
    (await put("/api/templates/lead/files/other.txt", { content: "", baseHash: null })).statusCode,
  ).toBe(400);
});

test("404 on a deleted folder for detail, save and validate", async () => {
  for (const r of [
    await get("/api/templates/gone"),
    await put("/api/templates/gone/files/AGENTS.md", { content: "", baseHash: null }),
    await post("/api/templates/gone/validate", { file: "AGENTS.md", content: "" }),
  ])
    expect(r.json().error.code).toBe("template_not_found");
});

test("save conflict returns currentHash; create conflict 409", async () => {
  expect((await post("/api/templates", { name: "lead", displayName: "Lead" })).statusCode).toBe(
    201,
  );
  const d = (await get("/api/templates/lead")).json().template;
  const agentsMd = d.files.find((f: { file: string }) => f.file === "AGENTS.md");
  writeFileSync(path.join(h.factoryHome, "templates/lead/AGENTS.md"), "# Changed on disk\n");
  const r = await put("/api/templates/lead/files/AGENTS.md", {
    content: "# Mine\n",
    baseHash: agentsMd.hash,
  });
  expect(r.statusCode).toBe(409);
  expect(r.json().error).toMatchObject({
    code: "changed_on_disk",
    currentHash: expect.stringMatching(/^[0-9a-f]{64}$/),
  });
  const again = await put("/api/templates/lead/files/AGENTS.md", {
    content: "# Mine\n",
    baseHash: r.json().error.currentHash,
  });
  expect(again.statusCode).toBe(200);
  expect(again.json()).toMatchObject({ hash: expect.any(String), issues: expect.any(Array) });
  expect(
    (await post("/api/templates", { name: "lead", displayName: "Lead" })).json().error.code,
  ).toBe("template_exists");
});

test("validate reports a YAML syntax error with its file and line and writes nothing; delete removes the folder", async () => {
  expect((await post("/api/templates", { name: "vdel", displayName: "Vdel" })).statusCode).toBe(
    201,
  );
  const dir = path.join(h.factoryHome, "templates/vdel");
  const before = readFileSync(path.join(dir, "template.yaml"), "utf8");
  const v = await post("/api/templates/vdel/validate", {
    file: "template.yaml",
    content: "name: [",
  });
  expect(v.statusCode).toBe(200);
  expect(v.json().issues).toContainEqual(
    expect.objectContaining({
      severity: "error",
      file: "template.yaml",
      message: expect.stringMatching(/YAML/),
      line: expect.any(Number),
    }),
  );
  // Validation is a dry run on the given content: the file on disk is as it was.
  expect(readFileSync(path.join(dir, "template.yaml"), "utf8")).toBe(before);
  expect((await del("/api/templates/vdel")).statusCode).toBe(204);
  expect(existsSync(dir)).toBe(false);
  expect((await get("/api/templates/vdel")).statusCode).toBe(404);
});

test("the names the web routes use are reserved: POST rejects them; a folder on disk with one still lists", async () => {
  for (const name of ["new"]) {
    const r = await post("/api/templates", { name, displayName: "X" });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatchObject({
      code: "validation_error",
      message: "That name is reserved.",
      fields: { name: "That name is reserved." },
    });
  }
  // Made on disk (an agent, a shell): the list and its detail don't crash on it.
  for (const name of ["new"]) {
    mkdirSync(path.join(h.factoryHome, `templates/${name}`), { recursive: true });
    writeFileSync(
      path.join(h.factoryHome, `templates/${name}/template.yaml`),
      `name: ${name}\ndisplay_name: X\n`,
    );
  }
  const list = await get("/api/templates");
  expect(list.statusCode).toBe(200);
  const names = list.json().templates.map((t: { name: string }) => t.name);
  expect(names).toEqual(expect.arrayContaining(["new"]));
  expect((await get("/api/templates/new")).statusCode).toBe(200);
  for (const name of ["new"])
    rmSync(path.join(h.factoryHome, `templates/${name}`), { recursive: true, force: true });
});

test.each([
  ["GET", "/api/templates"],
  ["GET", "/api/templates/dev"],
  ["GET", "/api/templates/dev/config"],
  ["PUT", "/api/templates/dev/config"],
] as const)("%s %s needs a signed-in user", async (method, url) => {
  expect((await h.app.inject({ method, url, payload: {} })).statusCode).toBe(401);
});

test("avatar route: headers, 404 when absent, 400 invalid name, 404 unknown", async () => {
  expect((await post("/api/templates", { name: "test", displayName: "Test" })).statusCode).toBe(
    201,
  );
  await h.seedAgent({ slug: "pic" });
  const tplDir = path.join(h.factoryHome, "templates/test");
  const avatarOf = async () =>
    (await get("/api/agents")).json().agents.find((a: { handle: string }) => a.handle === "pic")
      .avatarVersion;
  expect((await get("/api/templates/test/avatar.svg")).statusCode).toBe(404);
  expect((await get("/api/templates/test")).json().template.avatar).toEqual({
    version: null,
    tooLarge: false,
  });
  expect(await avatarOf()).toBeNull();

  writeFileSync(path.join(tplDir, "avatar.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
  const r = await get("/api/templates/test/avatar.svg");
  expect(r.statusCode).toBe(200);
  expect(r.headers["content-type"]).toMatch(/^image\/svg\+xml/);
  expect(r.headers["x-content-type-options"]).toBe("nosniff");
  expect(r.headers["content-security-policy"]).toBe(
    "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  );
  expect(r.headers["cache-control"]).toBe("private, max-age=31536000, immutable");
  const version = (await get("/api/templates/test")).json().template.avatar.version;
  expect(version).toMatch(/^\d+-\d+$/);
  expect(r.headers.etag).toBe(`"${version}"`);
  expect(r.body).toBe("<svg xmlns='http://www.w3.org/2000/svg'/>");
  expect(await avatarOf()).toBe(version);

  expect((await get("/api/templates/nope/avatar.svg")).statusCode).toBe(404);
  for (const url of [
    "/api/templates/..%2Fx/avatar.svg",
    "/api/templates/..%2F..%2Fetc/avatar.svg",
    "/api/templates/%2Ftmp/avatar.svg",
    "/api/templates/Test/avatar.svg",
  ])
    expect((await get(url)).statusCode).toBe(400);
  expect(
    (await h.app.inject({ method: "GET", url: "/api/templates/test/avatar.svg" })).statusCode,
  ).toBe(401);

  // A symlink, inside or outside the folder, is absent: 404, and the agent list reports null.
  const outside = mkdtempSync(path.join(tmpdir(), "out-"));
  writeFileSync(path.join(outside, "secret.svg"), "<svg>secret</svg>");
  for (const target of [path.join(outside, "secret.svg"), path.join(tplDir, "template.yaml")]) {
    rmSync(path.join(tplDir, "avatar.svg"));
    symlinkSync(target, path.join(tplDir, "avatar.svg"));
    const s = await get("/api/templates/test/avatar.svg");
    expect(s.statusCode).toBe(404);
    expect(s.body).not.toContain("secret");
    expect(await avatarOf()).toBeNull();
    expect((await get("/api/templates/test")).json().template.avatar.version).toBeNull();
  }

  // Too large: 404, version null, tooLarge on the detail.
  rmSync(path.join(tplDir, "avatar.svg"));
  writeFileSync(path.join(tplDir, "avatar.svg"), "x".repeat(256 * 1024 + 1));
  expect((await get("/api/templates/test/avatar.svg")).statusCode).toBe(404);
  expect((await get("/api/templates/test")).json().template.avatar).toEqual({
    version: null,
    tooLarge: true,
  });
  expect(await avatarOf()).toBeNull();
});
