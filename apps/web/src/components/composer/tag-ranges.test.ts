import { expect, test } from "vitest";
import {
  deleteTagAt,
  fromClipboard,
  hydrate,
  insertTag,
  insertTagged,
  rebase,
  serialise,
  snapCaret,
  snapSelection,
  type Tagged,
  type TagRange,
  toClipboard,
} from "./tag-ranges";

const ADA = "k3m7p2qz";
const BOB = "h4n8r5tv";
const handles: Record<string, string> = { [ADA]: "ada", [BOB]: "bob" };
const handleOf = (ref: string) => handles[ref] ?? "?";

const bounds = (ranges: readonly TagRange[]) => ranges.map((r) => [r.start, r.end]);
const spans = (t: Tagged) => t.ranges.map((r) => t.text.slice(r.start, r.end));

test.each([
  ["a plain tag", `hi <@${ADA}>!`, "hi @ada!", `hi <@${ADA}>!`],
  ["two tags", `<@${ADA}> and <@${BOB}>`, "@ada and @bob", `<@${ADA}> and <@${BOB}>`],
  ["a labelled agent tag, its label dropped", `<@${ADA}|old-name> ok`, "@ada ok", `<@${ADA}> ok`],
  [
    "a tag inside code, left as written",
    `\`<@${ADA}>\` <@${BOB}>`,
    "`<@" + ADA + ">` @bob",
    `\`<@${ADA}>\` <@${BOB}>`,
  ],
])(
  "hydrate shows %s as @handle, and serialise writes it back as <@ref>",
  (_, stored, shown, back) => {
    const t = hydrate(stored, handleOf);
    expect(t.text).toBe(shown);
    expect(serialise(t)).toBe(back);
  },
);

test("a pending principal shows its range as @… until its handle arrives", () => {
  const t = hydrate(`ping <@${ADA}>`, () => "…");
  expect(t.text).toBe("ping @…");
  expect(t.ranges).toEqual([{ start: 5, end: 7, ref: ADA }]);
});

const ada: TagRange[] = [{ start: 0, end: 4, ref: ADA }];

test.each([
  ["typing before a range shifts it", "@ada hi", "xx@ada hi", [[2, 6]]],
  ["typing exactly at a range's start shifts it", "@ada hi", "x@ada hi", [[1, 5]]],
  ["typing exactly at a range's end leaves it alone", "@ada hi", "@adax hi", [[0, 4]]],
  ["typing after a range leaves it alone", "@ada hi", "@ada hix", [[0, 4]]],
  ["deleting before a range shifts it back", "xx@ada hi", "x@ada hi", [[1, 5]]],
])("rebase: %s", (_, prevText, nextText, want) => {
  const prev: Tagged = {
    text: prevText,
    ranges: prevText.startsWith("xx") ? [{ start: 2, end: 6, ref: ADA }] : ada,
  };
  expect(bounds(rebase(prev, nextText).ranges)).toEqual(want);
});

test.each([
  ["typing inside a range drops it", "@ada hi", "@a3da hi"],
  ["deleting part of a range drops it", "@ada hi", "@a hi"],
  ["deleting across a range drops it", "x @ada hi", "x hi"],
])("rebase: %s", (_, prevText, nextText) => {
  const start = prevText.indexOf("@");
  const prev: Tagged = { text: prevText, ranges: [{ start, end: start + 4, ref: ADA }] };
  expect(rebase(prev, nextText).ranges).toEqual([]);
});

test("rebase keeps the range before an edit and drops the one the edit lands in", () => {
  const prev: Tagged = {
    text: "@ada and @bob end",
    ranges: [
      { start: 0, end: 4, ref: ADA },
      { start: 9, end: 13, ref: BOB },
    ],
  };
  const next = rebase(prev, "@ada and @b0b end");
  expect(next.ranges).toEqual([{ start: 0, end: 4, ref: ADA }]);
});

const oneRange: TagRange[] = [{ start: 5, end: 9, ref: ADA }];
const oddRange: TagRange[] = [{ start: 4, end: 8, ref: ADA }];

test.each([
  ["a click strictly inside goes to the nearer start", oneRange, 6, "click", 5],
  ["a click strictly inside goes to the nearer end", oneRange, 8, "click", 9],
  ["a click on a tie goes to the end", oddRange, 6, "click", 8],
  ["a left arrow inside goes to the start", oneRange, 7, "left", 5],
  [
    "a left arrow from right after the tag (post-move end - 1) jumps to its start",
    oneRange,
    8,
    "left",
    5,
  ],
  ["a right arrow inside goes to the end", oneRange, 7, "right", 9],
  [
    "a right arrow from right before the tag (post-move start + 1) jumps to its end",
    oneRange,
    6,
    "right",
    9,
  ],
  ["a caret outside every range stays put", oneRange, 3, "click", 3],
  ["a caret on a range's start never snaps, even with a right arrow", oneRange, 5, "right", 5],
  ["a caret on a range's end never snaps, even with a left arrow", oneRange, 9, "left", 9],
  ["a caret on a range's edge never snaps on a click", oneRange, 9, "click", 9],
] as const)("snapCaret: %s", (_, ranges, at, how, want) => {
  expect(snapCaret(ranges, at, how)).toBe(want);
});

test.each([
  ["an edge inside a range snaps outward to its start", 7, 12, [5, 12]],
  ["an edge inside a range snaps outward to its end", 2, 7, [2, 9]],
  ["both edges inside ranges snap outward", 6, 14, [5, 15]],
  ["edges on range boundaries stay put", 5, 9, [5, 9]],
])("snapSelection: %s", (_, start, end, want) => {
  const ranges: TagRange[] = [
    { start: 5, end: 9, ref: ADA },
    { start: 12, end: 15, ref: BOB },
  ];
  expect(snapSelection(ranges, start, end)).toEqual(want);
});

test.each([
  ["Backspace at a tag's end removes it and the space after", "Backspace", "@ada hi", 4, "hi", 0],
  [
    "Backspace at a tag's end with no space removes just the tag",
    "Backspace",
    "x @ada",
    6,
    "x ",
    2,
  ],
  ["Delete at a tag's start removes it and the space after", "Delete", "@ada hi", 0, "hi", 0],
  ["Delete at a tag's start with no space removes just the tag", "Delete", "@ada", 0, "", 0],
] as const)("deleteTagAt: %s", (_, key, text, caret, want, wantCaret) => {
  const start = text.indexOf("@");
  const t: Tagged = { text, ranges: [{ start, end: start + 4, ref: ADA }] };
  const out = deleteTagAt(t, caret, key);
  expect(out?.tagged.text).toBe(want);
  expect(out?.tagged.ranges).toEqual([]);
  expect(out?.caret).toBe(wantCaret);
});

test("deleteTagAt does nothing when the caret is not at the tag's edge for that key", () => {
  const t: Tagged = { text: "hi @ada", ranges: [{ start: 3, end: 7, ref: ADA }] };
  expect(deleteTagAt(t, 1, "Backspace")).toBeUndefined();
  expect(deleteTagAt(t, 3, "Backspace")).toBeUndefined();
  expect(deleteTagAt(t, 5, "Delete")).toBeUndefined();
  expect(deleteTagAt(t, 7, "Delete")).toBeUndefined();
});

test.each([
  ["a typed query becomes the tag and one trailing space", "hi @al", 3, 6, "hi @ada ", 8],
  ["a query at the start", "@a", 0, 2, "@ada ", 5],
])("insertTag: %s", (_, text, from, to, want, caret) => {
  const out = insertTag({ text, ranges: [] }, from, to, ADA, "ada");
  expect(out.tagged.text).toBe(want);
  expect(out.tagged.ranges).toEqual([{ start: from, end: from + 4, ref: ADA }]);
  expect(out.caret).toBe(caret);
});

test.each([
  ["typing an @ before a tag that starts with @ shifts it", "@ada", "@@ada", 1, [1, 5]],
  ["backspacing the plain @ before a tag that starts with @ shifts it", "@@ada", "@ada", 0, [0, 4]],
])("rebase with the caret hint: %s", (_, prevText, nextText, caret, want) => {
  const prev: Tagged = {
    text: prevText,
    ranges: [{ start: prevText.length - 4, end: prevText.length, ref: ADA }],
  };
  const next = rebase(prev, nextText, caret);
  expect(bounds(next.ranges)).toEqual([want]);
  expect(spans(next)).toEqual(["@ada"]);
});

test("insertTagged puts a pasted fragment's tags at the replaced span, with the caret after it", () => {
  const prev: Tagged = { text: "@bob x y", ranges: [{ start: 0, end: 4, ref: BOB }] };
  const fragment: Tagged = { text: "hi @ada!", ranges: [{ start: 3, end: 7, ref: ADA }] };
  const out = insertTagged(prev, 5, 7, fragment);
  expect(out.tagged.text).toBe("@bob hi @ada!y");
  expect(out.caret).toBe(5 + fragment.text.length);
  expect(bounds(out.tagged.ranges)).toEqual([
    [0, 4],
    [8, 12],
  ]);
  expect(out.tagged.ranges.map((r) => r.ref)).toEqual([BOB, ADA]);
});

test("insertTagged drops an existing tag the pasted span covers", () => {
  const prev: Tagged = { text: "a @bob b", ranges: [{ start: 2, end: 6, ref: BOB }] };
  const fragment: Tagged = { text: "@ada", ranges: [{ start: 0, end: 4, ref: ADA }] };
  const out = insertTagged(prev, 1, 8, fragment);
  expect(out.tagged.text).toBe("a@ada");
  expect(out.tagged.ranges).toEqual([{ start: 1, end: 5, ref: ADA }]);
});

test("insertTag shifts a tag that follows the typed query", () => {
  const prev: Tagged = { text: "@ada yo @al", ranges: ada };
  const { tagged } = insertTag(prev, 8, 11, BOB, "bob");
  expect(tagged.text).toBe("@ada yo @bob ");
  expect(bounds(tagged.ranges)).toEqual([
    [0, 4],
    [8, 12],
  ]);
});

test.each([
  [
    "an HTML chip keeps the text around it",
    { html: `see <span data-of-tag="${ADA}">@ada</span> please`, text: "see @ada please" },
    "see @ada please",
    [[4, 8]],
  ],
  [
    "raw tags in plain text, labels dropped",
    { text: `hi <@${BOB}> and <@${ADA}|ada>` },
    "hi @bob and @ada",
    [
      [3, 7],
      [12, 16],
    ],
  ],
] as const)("fromClipboard reads %s", (_, data, text, want) => {
  const t = fromClipboard(data, handleOf);
  expect(t.text).toBe(text);
  expect(bounds(t.ranges)).toEqual(want);
});

test("fromClipboard takes the chip from the HTML, not the raw text beside it", () => {
  const t = fromClipboard(
    { html: `<span data-of-tag="${BOB}">@bob</span>`, text: "@bob" },
    handleOf,
  );
  expect(serialise(t)).toBe(`<@${BOB}>`);
});

test("toClipboard writes the handles as text and each tag as a data-of-tag span", () => {
  const t: Tagged = { text: "hi @ada & more", ranges: [{ start: 3, end: 7, ref: ADA }] };
  expect(toClipboard(t, 0, t.text.length)).toEqual({
    text: "hi @ada & more",
    html: `hi <span data-of-tag="${ADA}">@ada</span> &amp; more`,
  });
});

test("a copied selection of tags pastes back as the same tags", () => {
  const t: Tagged = {
    text: "@bob, @ada",
    ranges: [
      { start: 0, end: 4, ref: BOB },
      { start: 6, end: 10, ref: ADA },
    ],
  };
  const copied = toClipboard(t, 0, t.text.length);
  expect(serialise(fromClipboard(copied, handleOf))).toBe(serialise(t));
});
