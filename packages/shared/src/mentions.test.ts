import { expect, test } from "vitest";
import { extractMentions as m } from "./mentions.ts";

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
  ["@or then @or again", ["or"]],
])("%s", (src, want) => expect(m(src).names).toEqual(want));

test("@humans is a name", () => expect(m("@humans and @dev").names).toEqual(["humans", "dev"]));

test("an escape or an entity earlier in the same text node does not shift or lose a mention", () => {
  expect(m("\\* @or").names).toEqual(["or"]);
  expect(m("x &amp; @or").names).toEqual(["or"]);
  expect(m("\\@or and @dev").names).toEqual(["dev"]);
  expect(m("&lt;@or&gt;").names).toEqual(["or"]);
  expect(m("anything").skipped).toEqual([]);
});

test("a name followed by a hyphen and more letters is not a mention of the prefix", () => {
  expect(m("@or-Dev").names).toEqual([]);
  expect(m("@or-devé").names).toEqual([]);
  expect(m("@or-dev").names).toEqual(["or-dev"]);
  expect(m("@or- x").names).toEqual(["or"]);
});
