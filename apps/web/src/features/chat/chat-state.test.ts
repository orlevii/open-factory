import type { ChatEntry, ChatPage } from "@open-factory/shared";
import { expect, test } from "vitest";
import {
  entryKey,
  flattenPages,
  liveKeys,
  meetsCache,
  mergeNewest,
  unionEntries,
} from "./chat-state";

const at = (i: number) => new Date(Date.UTC(2026, 10, 23, 9, 0, i)).toISOString();
const msg = (i: number, o: Partial<Extract<ChatEntry, { kind: "message" }>> = {}): ChatEntry => ({
  kind: "message",
  id: `m${i}`,
  from: "@ada",
  fromKind: "agent",
  body: `body ${i}`,
  recipients: ["@or"],
  urgent: false,
  createdAt: at(i),
  state: "delivered",
  ...o,
});
const page = (entries: ChatEntry[], o: Partial<ChatPage> = {}): ChatPage => ({
  entries,
  nextCursor: null,
  newerCursor: null,
  working: null,
  ...o,
});
const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => msg(from + i));
/** What a refetch brings: equal content, new objects. */
const refetched = (es: ChatEntry[]) => JSON.parse(JSON.stringify(es)) as ChatEntry[];

test("a 51st entry leaves the other 50 entry objects identical", () => {
  const cached = range(1, 50);
  const next = unionEntries(cached, refetched([...cached, msg(51)]));
  expect(next).toHaveLength(51);
  for (let i = 0; i < 50; i++) expect(next[i]).toBe(cached[i]);
});

test("nothing changed returns the cached array itself", () => {
  const cached = range(1, 5);
  expect(unionEntries(cached, refetched(cached))).toBe(cached);
});

test("the union never drops a cached entry the refetch lacks", () => {
  const cached = range(1, 60);
  const next = unionEntries(cached, refetched(range(11, 60)));
  expect(next).toHaveLength(60);
  expect(next[0]).toBe(cached[0]);
});

test("an optimistic entry and its server row are one key", () => {
  const optimistic = msg(1, { id: "tmp", clientMessageId: "c1", state: "pending" });
  const server = msg(1, { id: "m1", clientMessageId: "c1" });
  expect(entryKey(optimistic)).toBe(entryKey(server));
  const next = unionEntries([optimistic], [server]);
  expect(next).toEqual([server]);
});

test("pending to delivered replaces the entry under the same key", () => {
  const pending = msg(1, { from: "@or", fromKind: "human", state: "pending" });
  const delivered = { ...pending, state: "delivered" as const };
  const next = unionEntries([pending, msg(2)], [delivered]);
  expect(entryKey(next[0] as ChatEntry)).toBe(entryKey(pending));
  expect(next[0]).toEqual(delivered);
});

test("a late entry is placed by time", () => {
  const next = unionEntries([msg(1), msg(3)], [msg(2)]);
  expect(next.map((e) => (e as { id: string }).id)).toEqual(["m1", "m2", "m3"]);
});

test("the outcome and its working line share a key", () => {
  const outcome: ChatEntry = {
    kind: "turn_outcome",
    key: "m4",
    turnId: "t1",
    endedAt: at(5),
    eventSeq: 9,
    outcome: "no_reply",
  };
  expect(entryKey(outcome)).toBe("turn:m4");
});

test("mergeNewest keeps every unchanged object, the page and the data too", () => {
  const prev = { pages: [page(range(1, 50), { nextCursor: "c1" })], pageParams: [""] };
  const same = mergeNewest(prev, [page(refetched(range(1, 50)), { nextCursor: "c1" })]);
  expect(same).toBe(prev);
  const more = mergeNewest(prev, [page(refetched(range(2, 51)), { nextCursor: "c2" })]);
  expect(more.pages[0]?.entries).toHaveLength(51);
  expect(more.pages[0]?.entries[0]).toBe(prev.pages[0]?.entries[0]);
  // Load earlier still continues from the cached cursor.
  expect(more.pages[0]?.nextCursor).toBe("c1");
});

test("mergeNewest folds a gap in between the cache and the newest page", () => {
  const prev = { pages: [page(range(1, 50), { nextCursor: "c1" })], pageParams: [""] };
  const merged = mergeNewest(prev, [
    page(range(61, 110), { nextCursor: "c60" }),
    page(range(11, 60)),
  ]);
  expect(flattenPages(merged).entries).toHaveLength(110);
});

test("a page meets the cache when it shares an entry or reaches the thread's start", () => {
  const cached = page(range(1, 50));
  expect(meetsCache(page(range(61, 110), { nextCursor: "c" }), cached)).toBe(false);
  expect(meetsCache(page(range(50, 99), { nextCursor: "c" }), cached)).toBe(true);
  expect(meetsCache(page(range(61, 70)), cached)).toBe(true);
});

test("flattenPages lists older pages first and each entry once", () => {
  const data = {
    pages: [page(range(4, 6), { nextCursor: "c" }), page(range(1, 4))],
    pageParams: ["", "c"],
  };
  expect(flattenPages(data).entries.map((e) => (e as { id: string }).id)).toEqual([
    "m1",
    "m2",
    "m3",
    "m4",
    "m5",
    "m6",
  ]);
});

test("live keys: an agent's new message, never yours or a held one or the working line's outcome", () => {
  const cursor = new Set(["m1"]);
  const mine = msg(3, { from: "@or", fromKind: "human" });
  const outcome: ChatEntry = {
    kind: "turn_outcome",
    key: "m3",
    turnId: "t",
    endedAt: at(9),
    eventSeq: null,
    outcome: "error",
  };
  const live = liveKeys([msg(1), msg(2), mine, outcome], cursor, "m3");
  expect([...live]).toEqual(["m2"]);
});
