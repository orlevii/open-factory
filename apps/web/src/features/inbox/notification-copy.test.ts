import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { refFor } from "@/test/refs";
import {
  burstsOf,
  capTitle,
  type LoopHold,
  type NotifiableChat,
  type NotifiableItem,
} from "./notification-copy";

type ChatFixture = NotifiableChat;
type ItemFixture = NotifiableItem;

const PREVIEW = "SECRET-PREVIEW-MARKER-7431";

const chat = (
  over: Partial<ChatFixture> & { handle?: string; name?: string } = {},
): ChatFixture => ({
  agent: {
    ref: refFor(over.handle ?? "ada"),
    handle: over.handle ?? "ada",
    displayName: over.name ?? "Ada",
    template: "developer",
    avatarVersion: null,
    color: null,
    kind: "persistent",
    status: "idle",
    archivedAt: null,
  },
  unread: over.unread ?? 1,
  latest: {
    messageId: "m-latest",
    preview: PREVIEW,
    createdAt: "2026-11-25T10:00:00.000Z",
    urgent: false,
  },
  firstUnreadId: over.firstUnreadId ?? "m-first",
});

let seq = 0;
const item = (over: Partial<ItemFixture> = {}): ItemFixture => {
  seq += 1;
  return {
    id: `i-${seq}`,
    messageId: `msg-${seq}`,
    kind: "notice",
    read: false,
    from: { kind: "agent", ref: refFor("dev"), handle: "dev" },
    to: "me",
    preview: PREVIEW,
    urgent: false,
    createdAt: `2026-11-25T10:${String(seq).padStart(2, "0")}:00.000Z`,
    link: { kind: "session", agentRef: refFor("dev") },
    ...over,
  };
};

const mention = (over: Partial<ItemFixture> = {}) =>
  item({
    kind: "mention",
    from: { kind: "agent", ref: refFor("dev"), handle: "dev" },
    task: { key: "T-42", title: "Ship it" },
    link: { kind: "task", key: "T-42", commentId: "c-1" },
    ...over,
  });

const errored = (about: string, over: Partial<ItemFixture> = {}) =>
  item({
    kind: "notice",
    notice: "agent_errored",
    about,
    from: { kind: "factory" },
    ...over,
  });

const credential = (name: string, expiresAt: string | null, over: Partial<ItemFixture> = {}) =>
  item({
    kind: "credential",
    from: { kind: "factory" },
    credential: { name, expiresAt, current: true },
    link: { kind: "credential", name },
    ...over,
  });

const loopItem = (
  holdId: string,
  over: Partial<LoopHold> = {},
  itemOver: Partial<ItemFixture> = {},
) =>
  item({
    kind: "notice",
    notice: "loop_held",
    from: { kind: "factory" },
    link: { kind: "session", agentRef: refFor("a") },
    loopHold: {
      id: holdId,
      agents: [
        { ref: refFor("a"), handle: "a", status: "live" },
        { ref: refFor("b"), handle: "b", status: "live" },
      ],
      waiting: 2,
      sentOn: 3,
      resumedAt: null,
      resumedBy: null,
      ...over,
    },
    ...itemOver,
  });

beforeEach(() => {
  seq = 0;
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-25T12:00:00.000Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("chat bursts", () => {
  test("title is the agent's display name, body counts unread messages, tag follows the first unread", () => {
    const [b] = burstsOf({
      chats: [chat({ name: "Ada", unread: 3, firstUnreadId: "m-first" })],
      items: [],
    });
    expect(b).toMatchObject({
      key: `chat:${refFor("ada")}`,
      tag: `chat:${refFor("ada")}:m-first`,
      title: "Ada",
      body: "3 new messages",
      newestId: "m-latest",
      itemIds: [],
      open: { to: `/agents/${refFor("ada")}/chat`, search: { message: "m-first" } },
    });
  });

  test("one unread message reads singular", () => {
    const [b] = burstsOf({ chats: [chat({ unread: 1 })], items: [] });
    expect(b?.body).toBe("1 new message");
  });

  test("the tag changes when the first unread changes", () => {
    const before = burstsOf({ chats: [chat({ firstUnreadId: "m-1" })], items: [] })[0]?.tag;
    const after = burstsOf({ chats: [chat({ firstUnreadId: "m-2" })], items: [] })[0]?.tag;
    expect(after).not.toBe(before);
  });
});

describe("mention bursts", () => {
  test("one mention titles the burst with the mentioner's handle and names the task", () => {
    const [b] = burstsOf({ chats: [], items: [mention()] });
    expect(b).toMatchObject({
      key: "task:T-42",
      title: "@dev",
      body: "Mentioned you on T-42",
      open: { to: "/tasks/T-42", search: { comment: "c-1" } },
    });
  });

  test("several mentions on one task count them, and the open comment is the first unread", () => {
    const older = mention({
      createdAt: "2026-11-25T10:01:00.000Z",
      link: { kind: "task", key: "T-42", commentId: "c-old" },
    });
    const newer = mention({
      createdAt: "2026-11-25T10:09:00.000Z",
      link: { kind: "task", key: "T-42", commentId: "c-new" },
    });
    const [b] = burstsOf({ chats: [], items: [newer, older] });
    expect(b).toMatchObject({
      body: "2 mentions on T-42",
      open: { to: "/tasks/T-42", search: { comment: "c-old" } },
      newestId: newer.id,
      itemIds: [older.id, newer.id],
    });
    expect(b?.tag).toBe(`task:T-42:${older.id}`);
  });

  test("mentions from several people title the burst with the task key", () => {
    const [b] = burstsOf({
      chats: [],
      items: [
        mention({ from: { kind: "agent", ref: refFor("dev"), handle: "dev" } }),
        mention({ from: { kind: "agent", ref: refFor("qa"), handle: "qa" } }),
      ],
    });
    expect(b?.title).toBe("T-42");
  });

  test("read mentions do not notify", () => {
    expect(burstsOf({ chats: [], items: [mention({ read: true })] })).toEqual([]);
  });
});

describe("error bursts", () => {
  test("an agent error titles the burst with the agent's handle and opens its session", () => {
    const [b] = burstsOf({ chats: [], items: [errored("dev")] });
    expect(b).toMatchObject({
      key: "error:dev",
      title: "@dev",
      body: "Hit an error",
      open: { to: `/agents/${refFor("dev")}/session` },
    });
  });
});

describe("credential bursts", () => {
  // The date is formatted in the browser's locale and zone (spec §5.1), so the expected day is too.
  const day = (iso: string) =>
    new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(iso));
  const EXPIRY = "2026-12-03T09:00:00.000Z";

  test("an expiring credential says when it expires, and opens its settings row", () => {
    const [b] = burstsOf({ chats: [], items: [credential("work", EXPIRY)] });
    expect(b).toMatchObject({
      key: "credential:work",
      title: 'Credential "work"',
      body: `Expires ${day(EXPIRY)}`,
      open: { to: "/settings/credentials", search: { credential: "work" } },
    });
  });

  test("a credential past its expiry says so with the same date", () => {
    vi.setSystemTime(new Date("2026-12-10T12:00:00.000Z"));
    const [b] = burstsOf({ chats: [], items: [credential("work", EXPIRY)] });
    expect(b?.body).toBe(`Expired ${day(EXPIRY)}`);
  });

  test("a credential with no expiry date notifies nothing", () => {
    expect(burstsOf({ chats: [], items: [credential("work", null)] })).toEqual([]);
  });
});

describe("loop bursts", () => {
  test("a held loop titles the burst with both handles, is keyed by the hold, and opens the Inbox item", () => {
    const held = loopItem("h-9");
    const [b] = burstsOf({ chats: [], items: [held] });
    expect(b).toMatchObject({
      key: "loop:h-9",
      tag: "loop:h-9",
      title: "@a and @b",
      body: "Messages between them are held",
      itemIds: [held.id],
      open: { to: "/inbox", search: { item: held.id } },
    });
    expect(b?.resolved).toBeFalsy();
  });

  test("a resumed hold is marked resolved so the notifier can close it", () => {
    const [b] = burstsOf({
      chats: [],
      items: [
        loopItem("h-9", {
          resumedAt: "2026-11-25T11:00:00.000Z",
          resumedBy: { ref: refFor("ana"), handle: "ana" },
        }),
      ],
    });
    expect(b?.resolved).toBe(true);
  });
});

describe("what does not notify", () => {
  test.each([
    ["a task event", item({ kind: "task_event", fact: "done", task: { key: "T-1", title: "x" } })],
    ["a factory restart", item({ notice: "factory_restarted" })],
    ["a worktrees-kept notice", item({ notice: "worktrees_kept" })],
  ])("%s produces no burst", (_, i) => {
    expect(burstsOf({ chats: [], items: [i] })).toEqual([]);
  });
});

describe("copy never carries message text", () => {
  test("no title or body contains a message preview", () => {
    const bursts = burstsOf({
      chats: [chat({ unread: 2 })],
      items: [
        mention(),
        errored("dev"),
        credential("work", "2026-12-03T09:00:00.000Z"),
        loopItem("h-1"),
      ],
    });
    expect(bursts.length).toBe(5);
    for (const b of bursts) {
      expect(b.title).not.toContain(PREVIEW);
      expect(b.body).not.toContain(PREVIEW);
    }
  });
});

describe("capTitle", () => {
  test("a 60-character handle is middle-truncated to 40 characters, keeping both ends", () => {
    const handle = `@${"a".repeat(30)}${"z".repeat(29)}`;
    const out = capTitle(handle, "handle");
    expect(out).toHaveLength(40);
    expect(out.startsWith("@aaa")).toBe(true);
    expect(out.endsWith("zzz")).toBe(true);
    expect(out).toContain("…");
  });

  test("a 60-character display name is end-truncated to 40 characters", () => {
    const name = "N".repeat(60);
    const out = capTitle(name, "name");
    expect(out).toHaveLength(40);
    expect(out.startsWith("NNN")).toBe(true);
    expect(out.endsWith("…")).toBe(true);
  });

  test("a title at or under 40 characters is unchanged", () => {
    expect(capTitle("@dev", "handle")).toBe("@dev");
    expect(capTitle("x".repeat(40), "name")).toBe("x".repeat(40));
  });

  test("a long handle reaches the notification title capped", () => {
    const long = `dev-${"x".repeat(60)}`;
    const [b] = burstsOf({ chats: [], items: [errored(long)] });
    expect(b?.title.length).toBeLessThanOrEqual(40);
  });
});

describe("plurals", () => {
  test.each([
    [1, "1 new message"],
    [2, "2 new messages"],
  ])("%i unread reads %s", (n, body) => {
    expect(burstsOf({ chats: [chat({ unread: n })], items: [] })[0]?.body).toBe(body);
  });
});
