import { afterAll, beforeAll, expect, test } from "vitest";
import { createTestDb } from "../test/helpers.ts";
import { EventStore } from "./event-store.ts";
import { resetSession } from "./reset-session.ts";
import { insertAgent } from "./testing/rows.ts";

let t: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(() => t.close());

test("clears the session id, sets hibernated and appends session_reset", async () => {
  await insertAgent(t.sql, { id: "a1", slug: "lead", sessionId: "s1", status: "errored" });
  await resetSession(t.db, "lead");
  const [row] = await t.sql`select id, session_id, status from agents where slug = 'lead'`;
  expect(row).toMatchObject({ session_id: null, status: "hibernated" });
  const evs = await new EventStore(t.db).after("a1", 0, 10);
  expect(evs.at(-1)?.event).toEqual({ type: "session_reset", by: "reset-session script" });
  await expect(resetSession(t.db, "nobody")).rejects.toThrow("No agent named nobody");
});
