import { mkdirSync, writeFileSync } from "node:fs";
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

test("validate returns issues; delete removes the folder", async () => {
  const v = await post("/api/templates/lead/validate", { file: "AGENTS.md", content: "" });
  expect(v.statusCode).toBe(200);
  expect(Array.isArray(v.json().issues)).toBe(true);
  expect((await del("/api/templates/lead")).statusCode).toBe(204);
  expect((await get("/api/templates/lead")).statusCode).toBe(404);
});

test("unauthenticated → 401", async () => {
  expect((await h.app.inject({ method: "GET", url: "/api/templates" })).statusCode).toBe(401);
});
