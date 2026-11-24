import { expect, test } from "vitest";
import { readAt, readList, readNumber, readString, setAt } from "./tolerant";

test("readAt walks objects and reports a wrongly typed container", () => {
  expect(readAt({ a: { b: 1 } }, ["a", "b"])).toEqual({ ok: true, value: 1 });
  expect(readAt({}, ["a", "b"])).toEqual({ ok: true, value: undefined });
  expect(readAt({ a: "x" }, ["a", "b"])).toEqual({ ok: false });
  expect(readAt({ a: [1] }, ["a", "0"])).toEqual({ ok: false });
  expect(readAt(null, ["a"])).toEqual({ ok: true, value: undefined });
});

test("readList: absent is empty, strings pass, anything else is wrong", () => {
  const xs = ["a", "b"];
  expect(readList({ ok: true, value: undefined })).toEqual({ ok: true, items: [] });
  expect(readList({ ok: true, value: xs })).toEqual({ ok: true, items: xs });
  expect(readList({ ok: true, value: "release" })).toEqual({ ok: false });
  expect(readList({ ok: true, value: ["a", 1] })).toEqual({ ok: false });
  expect(readList({ ok: false })).toEqual({ ok: false });
});

test("a valid list is passed through by reference, so memoised rows keep their props", () => {
  const xs = ["a"];
  const r = readList({ ok: true, value: xs });
  expect(r.ok && r.items).toBe(xs);
});

test("readString and readNumber", () => {
  expect(readString({ ok: true, value: "opus" })).toEqual({ ok: true, value: "opus" });
  expect(readString({ ok: true, value: undefined })).toEqual({ ok: true, value: undefined });
  expect(readString({ ok: true, value: 5 })).toEqual({ ok: false });
  expect(readNumber({ ok: true, value: 70 })).toEqual({ ok: true, value: 70 });
  expect(readNumber({ ok: true, value: "70" })).toEqual({ ok: false });
  expect(readNumber({ ok: true, value: Number.NaN })).toEqual({ ok: false });
});

test("setAt keeps sibling and unknown keys and never mutates its input", () => {
  const root = { settings: { theme: "dark", permissions: { allow: ["a"] } }, x: 1 };
  const frozen = structuredClone(root);
  const next = setAt(root, ["settings", "permissions", "deny"], ["d"]);
  expect(next).toEqual({
    settings: { theme: "dark", permissions: { allow: ["a"], deny: ["d"] } },
    x: 1,
  });
  expect(root).toEqual(frozen);
});

test("setAt creates the containers it needs, replacing a wrongly typed one", () => {
  expect(setAt({}, ["template", "model"], "opus")).toEqual({ template: { model: "opus" } });
});

test("setAt with undefined or an empty list removes the key and prunes emptied containers", () => {
  expect(setAt({ template: { model: "opus" } }, ["template", "model"], undefined)).toEqual({});
  expect(
    setAt(
      { settings: { permissions: { allow: ["a"] } } },
      ["settings", "permissions", "allow"],
      [],
    ),
  ).toEqual({});
  expect(
    setAt(
      { settings: { theme: "d", permissions: { allow: ["a"] } } },
      ["settings", "permissions", "allow"],
      [],
    ),
  ).toEqual({
    settings: { theme: "d" },
  });
});

test("setAt keeps the kept containers (a template doc's three parts)", () => {
  const keep = (path: readonly string[]) => path.length === 1;
  expect(
    setAt({ template: { model: "opus" }, settings: {} }, ["template", "model"], undefined, keep),
  ).toEqual({
    template: {},
    settings: {},
  });
});

test("setAt never sets a prototype through a __proto__ key", () => {
  const next = setAt({}, ["settings", "__proto__"], { polluted: true }) as Record<string, unknown>;
  const settings = next.settings as Record<string, unknown>;
  expect(Object.hasOwn(settings, "__proto__")).toBe(true);
  expect(({} as Record<string, unknown>).polluted).toBeUndefined();
});
