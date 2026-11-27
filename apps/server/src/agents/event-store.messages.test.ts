import { messageLookupSchema } from "@open-factory/shared";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { createTestDb } from "../test/helpers.ts";
import { principalSql, testRef } from "../test/principals.ts";
import { EventStore } from "./event-store.ts";
import { insertAgent } from "./testing/rows.ts";

let t: Awaited<ReturnType<typeof createTestDb>>;
let store: EventStore;
beforeAll(async () => {
  t = await createTestDb();
  store = new EventStore(t.db);
  await t.sql.unsafe(principalSql("u1", "human", "or"));
  await t.sql`insert into users (id, name, email) values ('u1', 'Or', 'or@x.io')`;
  await t.sql.unsafe(principalSql("u2", "human", "dana"));
  await t.sql`insert into users (id, name, email) values ('u2', 'Dana', 'd@x.io')`;
  for (const [id, handle] of [
    ["a1", "dev"],
    ["a2", "b"],
    ["a3", "c"],
    ["a4", "d"],
  ] as const)
    await insertAgent(t.sql, { id, handle });
});
afterAll(() => t.close());

const at = (id: string, iso: string) =>
  t.sql`update messages set created_at = ${iso}::timestamptz where id = ${id}`;

test("pendingQueue names agent senders and subjects; notices first", async () => {
  const m = await store.createMessage({
    from: { agentId: "a1" },
    toAgentId: "a2",
    recipientIds: ["a2"],
    body: "hi",
    urgent: false,
  });
  const h = await store.createOrgRow({
    kind: "member_update",
    toAgentId: "a2",
    fromAgentId: "a1",
    body: "text",
  });
  const n = await store.createNotice({ toAgentId: "a2", notice: "factory_restarted", body: "n" });
  await at(m.id, "2026-01-01T00:00:01Z");
  await at(h.id, "2026-01-01T00:00:02Z");
  await at(n.id, "2026-01-01T00:00:03Z");
  const q = await store.pendingQueue("a2");
  expect(q.map((r) => [r.kind, r.fromHandle])).toEqual([
    ["system", null],
    ["message", "dev"],
    ["member_update", "dev"],
  ]);
  expect(h).toMatchObject({
    kind: "member_update",
    fromHandle: "dev",
    fromKind: "agent",
    subjectHandle: null,
  });
  expect(await store.pendingRow(h.id)).toEqual(q[2]);
  const fact = await store.createOrgRow({
    kind: "member_update",
    toAgentId: "a2",
    subjectAgentId: "a1",
    notice: "agent_errored",
    body: "dev errored",
  });
  expect(fact).toMatchObject({
    fromHandle: null,
    subjectHandle: "dev",
    subjectDisplayName: "Dev agent",
  });
});

test("boot wakes no agent for member updates or peer rows; an agent with a pending update, old or young, is listed to load", async () => {
  await store.createOrgRow({
    kind: "member_update",
    toAgentId: "a3",
    fromAgentId: "a1",
    body: "y",
  });
  await store.createOrgRow({
    kind: "peer_joined",
    toAgentId: "a4",
    subjectAgentId: "a1",
    notice: "peer",
    body: "p",
  });
  await t.sql`update messages set created_at = now() - interval '1 day' where to_id = 'a3'`;
  const wakes = (await store.bootWakes()).map((w) => w.id);
  expect(wakes).not.toContain("a3");
  expect(wakes).not.toContain("a4");
  const loads = await store.agentsWithPendingUpdates();
  expect(loads).toContain("a3");
  expect(loads).not.toContain("a4");
});

test("a factory fact fans out one inbox item per existing user, delivered at once", async () => {
  const { row, userIds } = await store.createHumanMessage({
    kind: "system",
    notice: "agent_errored",
    subjectAgentId: "a1",
    fromAgentId: null,
    to: "all",
    body: "hey",
    urgent: true,
  });
  expect(row?.state).toBe("delivered");
  expect([...userIds].sort()).toEqual(["u1", "u2"]);
  expect((await store.inboxPage("u1")).items[0]).toMatchObject({
    messageId: row?.id,
    urgent: true,
    to: "everyone",
    from: { kind: "factory" },
  });
});

test("inboxPage pages newest first with a cursor; chat messages come back as chats, not items", async () => {
  await t.sql`delete from messages where to_all_humans or to_id in (select id from users)`;
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    const { row } = await store.createHumanMessage({
      kind: "system",
      notice: "agent_errored",
      subjectAgentId: "a1",
      fromAgentId: null,
      to: "all",
      body: `m${i}`,
      urgent: false,
    });
    ids.push(row?.id as string);
    await t.sql`update inbox_items set created_at = ${`2026-02-0${i + 1}T00:00:00Z`}::timestamptz where message_id = ${row?.id as string}`;
  }
  await store.createHumanMessage({
    kind: "message",
    recipientIds: ["u1"],
    fromAgentId: "a1",
    to: { userId: "u1" },
    body: "a chat message",
    urgent: false,
  });
  const p1 = await store.inboxPage("u1", undefined, 2);
  expect(p1.items.map((i) => i.messageId)).toEqual([ids[2], ids[1]]);
  expect(p1.nextCursor).not.toBeNull();
  expect(p1.items.every((i) => i.kind === "notice")).toBe(true); // a factory notice is `notice`, never `message`
  expect(p1.chats).toEqual([
    expect.objectContaining({
      ref: testRef("a1"),
      unread: 1,
      latest: expect.objectContaining({ preview: "a chat message" }),
    }),
  ]);
  const p2 = await store.inboxPage("u1", p1.nextCursor ?? undefined, 2);
  expect(p2.items.map((i) => i.messageId)).toEqual([ids[0]]);
  expect(p2.nextCursor).toBeNull();
  expect(p2.chats).toBeUndefined(); // only the first page carries the chats
  expect([...p1.items, ...p2.items].some((i) => (i.kind as string) === "message")).toBe(false);
});

test("markPending clears delivered_event_seq; rejected is a state", async () => {
  const m = await store.createMessage({
    from: { userId: "u1" },
    toAgentId: "a2",
    recipientIds: ["a2"],
    body: "x",
    urgent: false,
  });
  await store.markDelivered([m.id]);
  await store.setDeliveredEventSeq([m.id], 7);
  expect((await store.messageLookup(m.id))?.recipientEvent).toEqual({
    agentRef: testRef("a2"),
    seq: 7,
  });
  await store.markPending([m.id]);
  expect((await store.messageLookup(m.id))?.recipientEvent).toBeUndefined();
  await store.markRejected(m.id);
  expect((await store.messageLookup(m.id))?.state).toBe("rejected");
  expect(await store.messageLookup("nope")).toBeUndefined();
});

test("rows stamped in the same millisecond keep insert order", async () => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(new Date("2026-03-01T00:00:00Z"));
    const ids: string[] = [];
    for (const body of ["one", "two", "three", "four"])
      ids.push(
        (
          await store.createMessage({
            from: { userId: "u1" },
            toAgentId: "a4",
            recipientIds: ["a4"],
            body,
            urgent: false,
          })
        ).id,
      );
    const q = (await store.pendingQueue("a4")).filter((r) => ids.includes(r.id));
    expect(q.map((r) => r.body)).toEqual(["one", "two", "three", "four"]);
  } finally {
    vi.useRealTimers();
  }
});

test("messageLookup satisfies the shared schema and renders from and to", async () => {
  const m = await store.createMessage({
    from: { agentId: "a1" },
    toAgentId: "a2",
    recipientIds: ["a2"],
    body: "x",
    urgent: false,
  });
  const lookup = messageLookupSchema.parse(await store.messageLookup(m.id));
  expect(lookup).toMatchObject({
    kind: "message",
    from: "@dev",
    fromKind: "agent",
    to: "@b",
    state: "pending",
  });
  const human = await store.createHumanMessage({
    kind: "system",
    notice: "agent_errored",
    subjectAgentId: "a1",
    fromAgentId: null,
    to: "all",
    body: "h",
    urgent: false,
  });
  expect(
    messageLookupSchema.parse(await store.messageLookup(human.row?.id as string)),
  ).toMatchObject({
    to: "everyone",
  });
  const fact = await store.createHumanMessage({
    kind: "system",
    fromAgentId: null,
    notice: "agent_errored",
    subjectAgentId: "a1",
    to: { userId: "u1" },
    body: "f",
    urgent: false,
  });
  expect(
    messageLookupSchema.parse(await store.messageLookup(fact.row?.id as string)),
  ).toMatchObject({
    kind: "system",
    from: "@factory",
    fromKind: "factory",
    to: "@or",
  });
  const fromUser = await store.createMessage({
    from: { userId: "u1" },
    toAgentId: "a2",
    recipientIds: ["a2"],
    body: "u",
    urgent: false,
  });
  expect(await store.messageLookup(fromUser.id)).toMatchObject({ from: "@or", fromKind: "human" });
});

test("factory inbox items link the subject's session; unlinkable human rows are refused", async () => {
  await t.sql`delete from messages where to_id in (select id from users) or to_all_humans`;
  await store.createHumanMessage({
    kind: "system",
    fromAgentId: null,
    notice: "agent_errored",
    subjectAgentId: "a1",
    to: "all",
    body: "dev errored",
    urgent: false,
  });
  expect((await store.inboxPage("u1")).items[0]).toMatchObject({
    from: { kind: "factory" },
    about: "dev",
    link: { agentRef: testRef("a1") },
  });
  await expect(
    store.createHumanMessage({
      kind: "system",
      fromAgentId: null,
      notice: "agent_errored",
      to: "all",
      body: "x",
      urgent: false,
    }),
  ).rejects.toThrow();
});

test("inbox preview is code-point safe", async () => {
  await t.sql`delete from messages where to_id in (select id from users) or to_all_humans`;
  await store.createHumanMessage({
    kind: "message",
    recipientIds: ["u1"],
    fromAgentId: "a1",
    to: { userId: "u1" },
    body: "😀".repeat(300),
    urgent: false,
  });
  const preview = (await store.inboxPage("u1")).chats?.[0]?.latest.preview ?? "";
  expect(Array.from(preview)).toHaveLength(280);
});

test("inbox preview reads past 2000 characters, so a late-closing fence still renders", async () => {
  await t.sql`delete from messages where to_id in (select id from users) or to_all_humans`;
  await store.createHumanMessage({
    kind: "message",
    recipientIds: ["u1"],
    fromAgentId: "a1",
    to: { userId: "u1" },
    body: `[${"w".repeat(2500)}](https://x.io)`,
    urgent: false,
  });
  const preview = (await store.inboxPage("u1")).chats?.[0]?.latest.preview ?? "";
  expect(preview).toBe("w".repeat(280)); // the link text, not "[www..." cut before its closing "](...)"
});

test("markRejected only touches pending rows", async () => {
  const m = await store.createMessage({
    from: { userId: "u1" },
    toAgentId: "a2",
    recipientIds: ["a2"],
    body: "x",
    urgent: false,
  });
  await store.markDelivered([m.id]);
  await store.markRejected(m.id);
  expect((await store.messageLookup(m.id))?.state).toBe("delivered");
});

test("bootWakes orders by deliverable rows only", async () => {
  await insertAgent(t.sql, { id: "a5", handle: "e" });
  await insertAgent(t.sql, { id: "a6", handle: "f" });
  const peer = await store.createOrgRow({
    kind: "peer_joined",
    toAgentId: "a5",
    subjectAgentId: "a1",
    notice: "peer",
    body: "p",
  });
  const m5 = await store.createMessage({
    from: { userId: "u1" },
    toAgentId: "a5",
    recipientIds: ["a5"],
    body: "m",
    urgent: false,
  });
  const m6 = await store.createMessage({
    from: { userId: "u1" },
    toAgentId: "a6",
    recipientIds: ["a5"],
    body: "m",
    urgent: false,
  });
  await at(peer.id, "2020-01-01T00:00:00Z");
  await at(m6.id, "2020-06-01T00:00:00Z");
  await at(m5.id, "2020-07-01T00:00:00Z");
  const order = (await store.bootWakes()).map((w) => w.id).filter((i) => i === "a5" || i === "a6");
  expect(order).toEqual(["a6", "a5"]);
});

const CID = "7b1d7a0e-3f55-4d8e-9d0e-5a1f2c3b4d5e";
test("a message row can be cancelled and carries a client id", async () => {
  const m = await store.createMessage({
    from: { userId: "u1" },
    toAgentId: "a3",
    recipientIds: ["a3"],
    body: "hi",
    urgent: false,
    clientMessageId: CID,
  });
  await t.sql`update messages set state = 'cancelled' where id = ${m.id}`;
  const row = await store.pendingRow(m.id);
  expect(row.state).toBe("cancelled");
  expect(row.clientMessageId).toBe(CID);
});
test("the same sender can't reuse a client id", async () => {
  const send = (body: string) =>
    store.createMessage({
      from: { userId: "u2" },
      toAgentId: "a4",
      recipientIds: ["a4"],
      body,
      urgent: false,
      clientMessageId: CID,
    });
  await send("a");
  await expect(send("b")).rejects.toThrow();
});

test("U3 §13.2: createClientMessage inserts once per (sender, client id), even concurrently", async () => {
  const cid = "6f1c1c2e-8f7e-4a43-9b7d-2f4d7f1f0a01";
  const m = {
    fromUserId: "u1",
    toAgentId: "a1",
    recipientIds: ["a1"],
    body: "x",
    urgent: false,
    clientMessageId: cid,
  };
  const results = await Promise.all([1, 2, 3, 4].map(() => store.createClientMessage(m)));
  expect(results.filter((r) => r.created)).toHaveLength(1);
  expect(new Set(results.map((r) => r.row.id)).size).toBe(1);
  const later = await store.createClientMessage({ ...m, body: "other" });
  expect(later).toMatchObject({ created: false, row: { id: results[0]?.row.id, body: "x" } });
  const other = await store.createClientMessage({ ...m, fromUserId: "u2" });
  expect(other.created).toBe(true);
  expect(
    (await t.sql`select count(*)::int as n from messages where client_message_id = ${cid}`)[0]?.n,
  ).toBe(2);
});

test("one client id covers a fan-out: a second recipient agent is a second row, listed together", async () => {
  const cid = "0b8a3a52-6c1e-4c0e-8f35-7d5b1a9e2c10";
  const m = {
    fromUserId: "u1",
    recipientIds: ["a1", "a2"],
    body: "x",
    urgent: false,
    clientMessageId: cid,
  };
  const a = await store.createClientMessage({ ...m, toAgentId: "a1" });
  const b = await store.createClientMessage({ ...m, toAgentId: "a2" });
  expect([a.created, b.created]).toEqual([true, true]);
  const again = await store.createClientMessage({ ...m, toAgentId: "a2" });
  expect(again).toMatchObject({ created: false, row: { id: b.row.id } });
  const rows = await store.byClientMessageId("u1", cid);
  expect(rows.map((r) => r.toId).sort()).toEqual(["a1", "a2"]);
  expect(rows[0]?.recipientIds).toEqual(["a1", "a2"]);
});
