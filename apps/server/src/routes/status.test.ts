import { afterAll, beforeAll, expect, test } from "vitest";
import { makeTestApp } from "../test/helpers.ts";
import { FACTORY_VERSION } from "../version.ts";

let t: Awaited<ReturnType<typeof makeTestApp>>;
beforeAll(async () => {
  t = await makeTestApp();
});
afterAll(async () => {
  await t.close();
});

test("GET /api/status is public and reports version + db", async () => {
  const res = await t.app.inject({ method: "GET", url: "/api/status" });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ version: FACTORY_VERSION, db: "ok" });
});

test("unknown /api path is a JSON 404", async () => {
  const res = await t.app.inject({ method: "GET", url: "/api/nope" });
  expect(res.statusCode).toBe(404);
  expect(res.headers["content-type"]).toMatch(/application\/json/);
  expect(res.json()).toEqual({ error: { code: "not_found", message: "Not found" } });
});
