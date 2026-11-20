import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { loadConfig } from "../config.ts";
import { createTestDb } from "../test/helpers.ts";
import { EventStore } from "./event-store.ts";
import { resetDevSession, seedDevAgent } from "./seed-dev.ts";

let t: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(() => t.close());

test("seed is idempotent, creates the working dir, keeps an edited AGENTS.md", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "of-"));
  const config = loadConfig({
    DATABASE_URL: t.url,
    FACTORY_SECRET_KEY: "k".repeat(40),
    FACTORY_HOME: home,
  });
  const a = await seedDevAgent(t.db, config);
  expect(a).toMatchObject({ slug: "dev", displayName: "Dev agent", status: "hibernated" });
  const work = path.join(home, "agents", "dev");
  expect(existsSync(path.join(work, ".claude-config"))).toBe(true);
  writeFileSync(path.join(work, "AGENTS.md"), "edited");
  const b = await seedDevAgent(t.db, config);
  expect(b.id).toBe(a.id);
  expect(readFileSync(path.join(work, "AGENTS.md"), "utf8")).toBe("edited");
});

test("reset clears the session id and appends a visible session_reset", async () => {
  const config = loadConfig({
    DATABASE_URL: t.url,
    FACTORY_SECRET_KEY: "k".repeat(40),
    FACTORY_HOME: mkdtempSync(path.join(tmpdir(), "of-")),
  });
  const a = await seedDevAgent(t.db, config);
  await t.sql`update agents set session_id = 'sess-1', status = 'errored' where id = ${a.id}`;
  await resetDevSession(t.db, config);
  const [row] = await t.sql`select session_id, status from agents where id = ${a.id}`;
  expect(row).toEqual({ session_id: null, status: "hibernated" });
  const evs = await new EventStore(t.db).after(a.id, 0, 10);
  expect(evs.at(-1)?.event).toEqual({ type: "session_reset", by: "seed script" });
});
