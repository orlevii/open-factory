import type { PrincipalItem } from "@open-factory/shared";
import { QueryClient } from "@tanstack/react-query";
import { expect, test, vi } from "vitest";
import { mentionSource } from "@/features/mentions/mention-source";
import type { PrincipalsCache } from "@/features/principals/api";
import { refFor } from "@/test/refs";
import { acceptMention, mentionOpensAt, rankMentions } from "./mentions";

const person = (
  handle: string,
  name: string,
  over: Partial<PrincipalItem> = {},
): PrincipalItem => ({
  id: handle,
  ref: refFor(handle),
  kind: "agent",
  handle,
  name,
  state: "live",
  avatar: { template: "t", avatarVersion: null, color: null },
  ...over,
});
const human = (handle: string, name: string, over: Partial<PrincipalItem> = {}) =>
  person(handle, name, { kind: "human", avatar: null, ...over });

const everyone = [
  person("zed", "Zed"),
  person("lead", "Lead"),
  person("alpha", "Alpha"),
  person("bravo", "Bravo"),
  person("gone", "Gone", { state: "terminated" }),
  person("old", "Old", { state: "archived" }),
  human("or", "Or Levi"),
  human("dana", "Dana"),
  human("ex", "Ex", { state: "disabled" }),
];
const handles = (q: string, o: { recent?: string[]; reports?: string[]; me?: string } = {}) =>
  rankMentions(q, everyone, {
    me: refFor(o.me ?? "or"),
    recent: (o.recent ?? []).map(refFor),
    reports: new Set((o.reports ?? []).map(refFor)),
  }).map((p) => p.handle);

function cached(...items: PrincipalItem[]) {
  const qc = new QueryClient();
  const cache: PrincipalsCache = {
    byRef: new Map(items.map((p) => [p.ref, p])),
    unknown: new Set(),
  };
  qc.setQueryData(["principals"], cache);
  return qc;
}

test("the @ menu lists only live principals, never yourself", () => {
  expect(handles("")).toEqual(["alpha", "bravo", "dana", "lead", "zed"]);
});

test("recent senders first, then your reports, then everyone by name", () => {
  expect(handles("", { recent: ["zed"], reports: ["lead"] })).toEqual([
    "zed",
    "lead",
    "alpha",
    "bravo",
    "dana",
  ]);
});

test("the query matches a handle or a name; prefix matches rank above the rest", () => {
  expect(handles("a")).toEqual(["alpha", "bravo", "dana", "lead"]);
  expect(handles("levi")).toEqual([]); // yourself is never offered
  expect(handles("levi", { me: "dana" })).toEqual(["or"]);
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
  // The caret inside a handle replaces the whole handle.
  expect(acceptMention("@dex and", "dev", 0, 2)).toEqual({ text: "@dev and", caret: 5 });
  expect(acceptMention("hi @de-vx", "dev", 3, 5)).toEqual({ text: "hi @dev ", caret: 8 });
});

test("the source offers live principals from the cache with their ref, and a note when it has rows", () => {
  const qc = cached(...everyone);
  qc.setQueryData(["session"], { user: { handle: "or", ref: refFor("or") } });
  const source = mentionSource(qc, { note: "A tag notifies them" });
  const rows = source.items("");
  expect(rows.map((r) => r.detail)).toEqual(["@alpha", "@bravo", "@dana", "@lead", "@zed"]);
  expect(rows[0]).toEqual(expect.objectContaining({ id: refFor("alpha"), label: "Alpha" }));
  expect(source.acceptTag?.(rows[0] as never)).toEqual({ ref: refFor("alpha"), handle: "alpha" });
  expect(source.menuNote?.(rows.length)).toBe("A tag notifies them");
  expect(source.menuNote?.(0)).toBeUndefined();
});

test("your reports come from the cached agents list by manager ref, ahead of other agents", () => {
  const qc = cached(person("a", "A"), person("mine", "Mine"), person("theirs", "Theirs"));
  qc.setQueryData(["session"], { user: { handle: "or", ref: refFor("or") } });
  qc.setQueryData(
    ["agents", "exclude"],
    [
      {
        ref: refFor("mine"),
        handle: "mine",
        // Its manager's handle here is an older label: the ref is what says it is you.
        reportsTo: { kind: "human", ref: refFor("or"), handle: "or-before-rename" },
      },
      {
        ref: refFor("theirs"),
        handle: "theirs",
        reportsTo: { kind: "human", ref: refFor("dana"), handle: "dana" },
      },
    ],
  );
  expect(
    mentionSource(qc)
      .items("")
      .map((i) => i.id),
  ).toEqual([refFor("mine"), refFor("a"), refFor("theirs")]);
});

test("recent agent senders come from the cached inbox", () => {
  const qc = cached(person("a", "A"), person("z", "Z"));
  qc.setQueryData(["inbox"], {
    pages: [
      {
        items: [
          {
            from: { kind: "agent", ref: refFor("z"), handle: "z" },
            createdAt: "2026-11-19T10:00:00Z",
          },
        ],
        nextCursor: null,
      },
    ],
    pageParams: [undefined],
  });
  expect(
    mentionSource(qc)
      .items("")
      .map((i) => i.id),
  ).toEqual([refFor("z"), refFor("a")]);
});

test("watching loads the principals once if they aren't cached and reports changes while open", async () => {
  const fetch = vi.fn(async (_url: string) =>
    Response.json({ principals: [human("dana", "Dana")] }),
  );
  vi.stubGlobal("fetch", fetch);
  try {
    const qc = new QueryClient();
    const source = mentionSource(qc);
    const changed = vi.fn();
    const stop = source.watch?.(changed);
    expect(source.items("d")).toEqual([]);
    await vi.waitFor(() => expect(changed).toHaveBeenCalled());
    expect(String(fetch.mock.calls[0]?.[0])).toContain("/api/principals");
    expect(source.items("d").map((i) => i.detail)).toEqual(["@dana"]);
    stop?.();
    changed.mockClear();
    qc.setQueryData(["principals"], { byRef: new Map(), unknown: new Set() });
    expect(changed).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});
