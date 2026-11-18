import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { makeTestApp } from "./test/helpers.ts";

let t: Awaited<ReturnType<typeof makeTestApp>>;
beforeAll(async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "of-web-"));
  writeFileSync(path.join(dir, "index.html"), "<!doctype html><div id=app></div>");
  writeFileSync(path.join(dir, "app.js"), "console.log(1)");
  t = await makeTestApp({ webRoot: dir });
});
afterAll(async () => {
  await t.close();
});

test("serves files, falls back to index.html for app routes, keeps /api 404 as JSON", async () => {
  expect((await t.app.inject({ url: "/app.js" })).body).toBe("console.log(1)");
  const deep = await t.app.inject({ url: "/agents" });
  expect(deep.statusCode).toBe(200);
  expect(deep.headers["content-type"]).toMatch(/text\/html/);
  const api = await t.app.inject({ url: "/api/missing" });
  expect(api.statusCode).toBe(404);
  expect(api.json()).toEqual({ error: { code: "not_found", message: "Not found" } });
});
