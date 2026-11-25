import { afterAll, beforeAll, expect, test } from "vitest";
import { createTestDb } from "../test/helpers.ts";
import { EventStore } from "./event-store.ts";

let t: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  t = await createTestDb();
  await t.sql`insert into credentials (id,name,kind,value_enc) values ('c1','w','oauth_token','\\x00')`;
});
afterAll(() => t.close());

test("a factory fact for every human with no users still writes its row and no inbox items", async () => {
  const store = new EventStore(t.db);
  const { row, userIds } = await store.createHumanMessage({
    kind: "system",
    notice: "agent_errored",
    subjectCredentialId: "c1",
    fromAgentId: null,
    to: "all",
    body: "anyone?",
    urgent: false,
  });
  expect(row?.state).toBe("delivered");
  expect(userIds).toEqual([]);
});
