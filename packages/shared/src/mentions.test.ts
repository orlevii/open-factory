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

test("a mention after an escape in the same text node is reported as skipped, never guessed", () => {
  const r = m("\\* @or");
  expect(r.names).toEqual([]);
  expect(r.skipped).toEqual(["or"]);
});
