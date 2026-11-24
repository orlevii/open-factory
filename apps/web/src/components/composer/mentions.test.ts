import { QueryClient } from "@tanstack/react-query";
import { expect, test, vi } from "vitest";
import { mentionSource } from "@/features/mentions/mention-source";
import { acceptMention, type MentionAgent, mentionOpensAt, rankMentions } from "./mentions";

const agent = (slug: string, displayName: string, over: Partial<MentionAgent> = {}) =>
  ({
    slug,
    displayName,
    reportsTo: "lead",
    template: "t",
    avatarVersion: null,
    archivedAt: null,
    ...over,
  }) as MentionAgent;

const agents = [
  agent("zed", "Zed"),
  agent("lead", "Lead", { reportsTo: null }),
  agent("alpha", "Alpha"),
  agent("bravo", "Bravo"),
  agent("gone", "Gone", { terminatedAt: "2026-01-01T00:00:00Z" }),
  agent("old", "Old", { archivedAt: "2026-01-01T00:00:00Z" }),
];
const humans = [
  { handle: "or", name: "Or Levi", disabledAt: null },
  { handle: "dana", name: "Dana", disabledAt: null },
  { handle: "ex", name: "Ex", disabledAt: "2026-01-01T00:00:00Z" },
];
const handles = (q: string, recent: string[] = []) =>
  rankMentions(q, { agents, humans, me: "or", recent }).map((m) => m.handle);

test("your reports and recent senders first, then alphabetical; live agents only", () => {
  expect(handles("", ["zed"])).toEqual(["zed", "lead", "alpha", "bravo", "dana"]);
});

test("without recent senders your reports lead, then everyone by name", () => {
  expect(handles("")).toEqual(["lead", "alpha", "bravo", "dana", "zed"]);
});

test("an agent reporting to you counts as your report", () => {
  const list = [agent("a", "A"), agent("b", "B", { reportsTo: "or" })];
  expect(rankMentions("", { agents: list, humans: [], me: "or" }).map((m) => m.handle)).toEqual([
    "b",
    "a",
  ]);
});

test("the query matches a handle or a name; prefix matches rank above the rest", () => {
  expect(handles("a")).toEqual(["alpha", "lead", "bravo", "dana"]);
  expect(handles("levi", [])).toEqual([]);
  expect(rankMentions("levi", { agents, humans, me: "dana" }).map((m) => m.handle)).toEqual(["or"]);
  expect(handles("lev")).toEqual([]); // yourself is never offered
  expect(handles("DA")).toEqual(["dana"]);
  expect(handles("hum")).toEqual([]); // `humans` is not a handle: there is no group row
});

test("`@` opens anywhere after a non-word character; not inside an email or a path", () => {
  expect(mentionOpensAt("@", 1)).toEqual({ query: "", from: 0 });
  expect(mentionOpensAt("hi @de", 6)).toEqual({ query: "de", from: 3 });
  expect(mentionOpensAt("line\n(@de", 9)).toEqual({ query: "de", from: 6 });
  expect(mentionOpensAt("hi @de there", 6)).toEqual({ query: "de", from: 3 });
  expect(mentionOpensAt("a@b", 3)).toBeUndefined();
  expect(mentionOpensAt("src/@x", 6)).toBeUndefined();
  expect(mentionOpensAt("@de x", 5)).toBeUndefined();
});

test("accepting replaces the typed token with `@handle `", () => {
  expect(acceptMention("hi @de", "dev", 3, 6)).toEqual({ text: "hi @dev ", caret: 8 });
  // An existing space after the token is reused, not doubled.
  expect(acceptMention("@d and", "dev", 0, 2)).toEqual({ text: "@dev and", caret: 5 });
});

test("the source reads the cached lists when asked, and only then", () => {
  const qc = new QueryClient();
  const source = mentionSource(qc, "Insert an agent's handle");
  expect(source.items("")).toEqual([]);
  qc.setQueryData(["agents", "exclude"], [agent("dev", "Dev")]);
  qc.setQueryData(["users"], [{ handle: "dana", name: "Dana", disabledAt: null }]);
  expect(source.items("d").map((i) => i.id)).toEqual(["dana", "dev"]);
  expect(source.items("dev")[0]).toEqual(
    expect.objectContaining({ label: "Dev", detail: "@dev", avatar: expect.anything() }),
  );
});

test("recent agent senders come from the cached inbox", () => {
  const qc = new QueryClient();
  qc.setQueryData(["agents", "exclude"], [agent("a", "A"), agent("z", "Z")]);
  qc.setQueryData(["inbox"], {
    pages: [
      {
        items: [{ from: { kind: "agent", name: "z" }, createdAt: "2026-11-19T10:00:00Z" }],
        nextCursor: null,
      },
    ],
    pageParams: [undefined],
  });
  const source = mentionSource(qc, "x");
  expect(source.items("").map((i) => i.id)).toEqual(["z", "a"]);
});

test("an agent whose unread chat is newer than the inbox items ranks first", () => {
  const qc = new QueryClient();
  qc.setQueryData(["agents", "exclude"], [agent("a", "A"), agent("m", "M"), agent("z", "Z")]);
  qc.setQueryData(["inbox"], {
    pages: [
      {
        chats: [{ agent: { slug: "m" }, latest: { createdAt: "2026-11-19T12:00:00Z" } }],
        items: [{ from: { kind: "agent", name: "z" }, createdAt: "2026-11-19T10:00:00Z" }],
        nextCursor: null,
      },
    ],
    pageParams: [undefined],
  });
  expect(
    mentionSource(qc, "x")
      .items("")
      .map((i) => i.id),
  ).toEqual(["m", "z", "a"]);
});

test("accepting with the caret inside a handle replaces the whole handle", () => {
  expect(acceptMention("@dex and", "dev", 0, 2)).toEqual({ text: "@dev and", caret: 5 });
  expect(acceptMention("hi @de-vx", "dev", 3, 5)).toEqual({ text: "hi @dev ", caret: 8 });
});

test("watching loads the users list once if it isn't cached and reports changes while open", async () => {
  const fetch = vi.fn(async (_url: string) =>
    Response.json({
      users: [
        {
          id: "u1",
          name: "Dana",
          handle: "dana",
          email: "d@x",
          createdAt: "2026-01-01T00:00:00Z",
          disabledAt: null,
        },
      ],
    }),
  );
  vi.stubGlobal("fetch", fetch);
  try {
    const qc = new QueryClient();
    qc.setQueryData(["agents", "exclude"], [agent("dev", "Dev")]);
    const source = mentionSource(qc, "x");
    const changed = vi.fn();
    const stop = source.watch?.(changed);
    expect(source.items("d").map((i) => i.id)).toEqual(["dev"]);
    await vi.waitFor(() => expect(changed).toHaveBeenCalled());
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0]?.[0])).toContain("/api/users");
    expect(source.items("d").map((i) => i.id)).toEqual(["dana", "dev"]);
    // A cached list changing while the menu is open is reported too.
    changed.mockClear();
    qc.setQueryData(["agents", "exclude"], [agent("dev", "Dev"), agent("dot", "Dot")]);
    expect(changed).toHaveBeenCalled();
    stop?.();
    changed.mockClear();
    qc.setQueryData(["agents", "exclude"], [agent("dev", "Dev")]);
    expect(changed).not.toHaveBeenCalled();
    // Cached and fresh: watching again fetches nothing.
    source.watch?.(() => {})?.();
    expect(fetch).toHaveBeenCalledTimes(1);
  } finally {
    vi.unstubAllGlobals();
  }
});
