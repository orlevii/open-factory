import { afterAll, beforeAll, expect, test } from "vitest";
import { claimTestHandleSql } from "../test/handles.ts";
import { createTestDb } from "../test/helpers.ts";
import { EventStore } from "./event-store.ts";

let t: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  t = await createTestDb();
  await t.sql`insert into credentials (id,name,kind,value_enc) values ('c1','w','oauth_token','\\x00')`;
  await claimTestHandleSql(t.sql, "dev", "agent");
  await t.sql`insert into agents (id,slug,display_name,template,config,runtime,credential_id) values ('a1','dev','Dev','t','{}','local','c1')`;
});
afterAll(() => t.close());

test("a message to @humans with no users still writes its row and no inbox items", async () => {
  const store = new EventStore(t.db);
  const { row, userIds } = await store.createHumanMessage({
    kind: "message",
    fromAgentId: "a1",
    to: "all",
    body: "anyone?",
    urgent: false,
  });
  expect(row?.state).toBe("delivered");
  expect(userIds).toEqual([]);
});
