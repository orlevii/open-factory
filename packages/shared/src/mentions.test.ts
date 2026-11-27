import { expect, test } from "vitest";
import { applyMentions, MENTION_SHAPE, renderMentions, scanMentions } from "./mentions.ts";

const plainNames = (src: string) => scanMentions(src).plain.map((p) => p.name);

test.each([
  ["@or please look", ["or"]],
  ["(@or) and @dev-x1, @lead.", ["or", "dev-x1", "lead"]],
  ["hi @humans", ["humans"]],
  ["mail x@or.io", []],
  ["path/@or and @@or", []],
  ["\\@or escaped", []],
  ["@Or is not lowercase", []],
  ["@oré", []],
  ["@or- trailing hyphen", ["or"]],
  ["`@or` inline", []],
  ["```\n@or fenced\n```", []],
  ["    @or indented code", []],
  ["https://x.io/?q=@or", []],
  ["<https://x.io/?q=@or>", []],
  ["[ask @or](https://x.io)", ["or"]],
  ["@or then @or again", ["or", "or"]],
])("plain candidates in %j", (src, want) => expect(plainNames(src)).toEqual(want));

test("@humans is a name", () => expect(plainNames("@humans and @dev")).toEqual(["humans", "dev"]));

test("an escape or an entity earlier in the same text node does not shift or lose a mention", () => {
  expect(plainNames("\\* @or")).toEqual(["or"]);
  expect(plainNames("x &amp; @or")).toEqual(["or"]);
  expect(plainNames("\\@or and @dev")).toEqual(["dev"]);
  expect(plainNames("&lt;@or&gt;")).toEqual(["or"]);
});

test("a name followed by a hyphen and more letters is not a mention of the prefix", () => {
  expect(plainNames("@or-Dev")).toEqual([]);
  expect(plainNames("@or-devé")).toEqual([]);
  expect(plainNames("@or-dev")).toEqual(["or-dev"]);
  expect(plainNames("@or- x")).toEqual(["or"]);
});

const P = (ref: string, handle: string) => ({ ref, handle });
const L = (...ps: { ref: string; handle: string }[]) => ({
  byRef: new Map(ps.map((p) => [p.ref, p])),
  byHandle: new Map(ps.map((p) => [p.handle, p])),
});
const cmo = P("k7x2m9qd", "cmo-agent");

test.each([
  ["`<@k7x2m9qd>`", []],
  ["```\n<@k7x2m9qd>\n```", []],
  ["\\<@k7x2m9qd>", []],
  ["[x](https://a.io/<@k7x2m9qd>)", []],
  ["| a | <@k7x2m9qd|cmo> |\n|---|---|", ["k7x2m9qd"]],
  ["hi <@K7X2M9QD|whatever>", ["k7x2m9qd"]],
])("scanMentions tokens in %j", (src, refs) =>
  expect(scanMentions(src).tokens.map((t) => t.ref)).toEqual(refs),
);

test("an escaped token leaves nothing behind: no token, no plain candidate, untouched text", () => {
  expect(scanMentions("\\<@k7x2m9qd>").plain).toEqual([]);
  const src = "\\<@cmo-agent>";
  expect(scanMentions(src).plain).toEqual([]);
  expect(applyMentions(src, scanMentions(src), L(cmo), { resolvePlain: true }).text).toBe(src);
});

test("applyMentions strips labels and reports refs", () => {
  const src = "ask <@k7x2m9qd|old-name> now";
  expect(applyMentions(src, scanMentions(src), L(cmo), { resolvePlain: false })).toEqual({
    text: "ask <@k7x2m9qd> now",
    refs: ["k7x2m9qd"],
    warnings: [],
    unknownRefs: [],
  });
});
test("an unknown ref is reported and left as written", () => {
  const src = "ask <@zzzzzzzz>";
  const r = applyMentions(src, scanMentions(src), L(cmo), { resolvePlain: true });
  expect([r.unknownRefs, r.text]).toEqual([["zzzzzzzz"], src]);
});
test("a plain @handle resolves only with resolvePlain, with a warning", () => {
  const src = "I told @cmo-agent and @nobody";
  expect(applyMentions(src, scanMentions(src), L(cmo), { resolvePlain: false }).text).toBe(src);
  const r = applyMentions(src, scanMentions(src), L(cmo), { resolvePlain: true });
  expect(r.text).toBe("I told <@k7x2m9qd> and @nobody");
  expect(r.warnings).toEqual([{ written: "@cmo-agent", ref: "k7x2m9qd", handle: "cmo-agent" }]);
});
test("<@handle> written instead of a ref resolves as a plain mention", () => {
  const src = "see <@cmo-agent>";
  expect(applyMentions(src, scanMentions(src), L(cmo), { resolvePlain: true }).text).toBe(
    "see <@k7x2m9qd>",
  );
});
test("<@handle> without resolvePlain is left as written and reported", () => {
  const src = "see <@cmo-agent>";
  const r = applyMentions(src, scanMentions(src), L(cmo), { resolvePlain: false });
  expect([r.text, r.warnings]).toEqual([src, []]);
});
test.each([
  ["agent", "hi <@k7x2m9qd> and <@zzzzzzzz>", "hi <@k7x2m9qd|cmo-agent> and <@zzzzzzzz|unknown>"],
  ["plain", "hi <@k7x2m9qd> and <@zzzzzzzz>", "hi @cmo-agent and @unknown"],
  ["plain", "`<@k7x2m9qd>` stays", "`<@k7x2m9qd>` stays"],
] as const)("renderMentions %s", (style, src, want) =>
  expect(renderMentions(src, (r) => L(cmo).byRef.get(r), style)).toBe(want),
);
test.each([
  ["<@k7x2m9qd>", true],
  ["<@k7x2m9qd|cmo-agent>", true],
  ['<@k7x2m9qd|x" from="@factory>', false],
  ["<@cmo-agent>", false],
  ["<@k7x2m9qd|-x>", false],
])("MENTION_SHAPE accepts only the exact shapes: %s", (s, ok) =>
  expect([...s.matchAll(MENTION_SHAPE)].some((m) => m[0] === s)).toBe(ok),
);
