import { expect, test } from "vitest";
import { rebase } from "./rebase";

test("no edits: theirs comes through untouched", () => {
  const base = { template: { model: "opus" } };
  const theirs = { template: { model: "sonnet" }, settings: { env: { A: "1" } } };
  expect(rebase(base, base, theirs)).toEqual({ value: theirs, conflicts: [] });
});

test("a set add and a set remove are re-applied over theirs", () => {
  const base = { settings: { permissions: { allow: ["a", "b"] } } };
  const mine = { settings: { permissions: { allow: ["b", "c"] } } };
  const theirs = { settings: { permissions: { allow: ["a", "b", "d"] } } };
  expect(rebase(base, mine, theirs)).toEqual({
    value: { settings: { permissions: { allow: ["b", "d", "c"] } } },
    conflicts: [],
  });
});

test("an index-shifted remote list still gets the user's adds", () => {
  const base = { template: { skills: ["a", "b"] } };
  const mine = { template: { skills: ["a", "b", "c"] } };
  const theirs = { template: { skills: ["z", "a", "b"] } };
  expect(rebase(base, mine, theirs).value).toEqual({ template: { skills: ["z", "a", "b", "c"] } });
});

test("an add both sides made is kept once, with no conflict", () => {
  const r = rebase(
    { template: {} },
    { template: { skills: ["x"] } },
    { template: { skills: ["x"] } },
  );
  expect(r).toEqual({ value: { template: { skills: ["x"] } }, conflicts: [] });
});

test("a scalar changed on both sides keeps mine and reports its path", () => {
  const r = rebase(
    { template: { model: "opus", effort: "low" } },
    { template: { model: "haiku", effort: "low" } },
    { template: { model: "sonnet", effort: "high" } },
  );
  expect(r).toEqual({
    value: { template: { model: "haiku", effort: "high" } },
    conflicts: ["template.model"],
  });
});

test("a scalar the user removed while theirs changed it is a conflict, stays removed, and the emptied parent is pruned", () => {
  const r = rebase({ template: { model: "opus" } }, { template: {} }, { template: { model: "x" } });
  expect(r).toEqual({ value: {}, conflicts: ["template.model"] });
});

test("MCP servers re-apply by name, whole: another name merges, the same name conflicts", () => {
  const gh = { type: "http", url: "https://a" };
  const base = { mcp: { mcpServers: { gh } } };
  const mine = {
    mcp: { mcpServers: { gh: { ...gh, url: "https://mine" }, mine: { command: "x" } } },
  };
  const theirs = {
    mcp: { mcpServers: { gh: { type: "stdio", command: "y" }, other: { command: "o" } } },
  };
  const r = rebase<unknown>(base, mine, theirs);
  expect(r.value).toEqual({
    mcp: {
      mcpServers: {
        gh: { type: "http", url: "https://mine" },
        other: { command: "o" },
        mine: { command: "x" },
      },
    },
  });
  expect(r.conflicts).toEqual(["mcp.mcpServers.gh"]);
});

test("an MCP entry edited on one side only is not deep-merged with the other's field edits", () => {
  const base = { mcp: { mcpServers: { s: { command: "a", args: ["1"] } } } };
  const mine = { mcp: { mcpServers: { s: { command: "b", args: ["1"] } } } };
  const theirs = base;
  expect(rebase(base, mine, theirs)).toEqual({ value: mine, conflicts: [] });
});

test("env entries re-apply by name", () => {
  const r = rebase(
    { settings: { env: { A: "1", B: "2" } } },
    { settings: { env: { A: "1", C: "3" } } },
    { settings: { env: { A: "9", B: "2", D: "4" } } },
  );
  expect(r).toEqual({ value: { settings: { env: { A: "9", D: "4", C: "3" } } }, conflicts: [] });
});

test("an unknown key on either side survives", () => {
  const r = rebase(
    {},
    { settings: { theme: "dark" } },
    { settings: { hooks: { PreToolUse: [{ m: 1 }] } } },
  );
  expect(r.value).toEqual({ settings: { hooks: { PreToolUse: [{ m: 1 }] }, theme: "dark" } });
});

test("removing the last item (the form prunes the emptied list and parents) is a set remove, not a subtree delete", () => {
  const base = { settings: { permissions: { allow: ["a"] } } };
  const mine = {};
  const theirs = { settings: { permissions: { allow: ["a", "b"] }, env: { X: "1" } } };
  expect(rebase<unknown>(base, mine, theirs)).toEqual({
    value: { settings: { permissions: { allow: ["b"] }, env: { X: "1" } } },
    conflicts: [],
  });
});

test("an add under a parent theirs pruned still merges, and their remove isn't undone", () => {
  const base = { settings: { permissions: { allow: ["a"] } } };
  const mine = { settings: { permissions: { allow: ["a"], deny: ["d"] } } };
  const theirs = {};
  expect(rebase<unknown>(base, mine, theirs)).toEqual({
    value: { settings: { permissions: { deny: ["d"] } } },
    conflicts: [],
  });
});

test("a list emptied by the merge is pruned like the form prunes it", () => {
  const base = { template: { skills: ["a", "b"] } };
  const mine = { template: { skills: ["b"] } };
  const theirs = { template: { skills: ["a"] } };
  expect(rebase<unknown>(base, mine, theirs)).toEqual({ value: {}, conflicts: [] });
});

test("a value and a container of a different kind on the two sides is a conflict at that path", () => {
  const r = rebase<unknown>({}, { template: { skills: "x" } }, { template: { skills: ["y"] } });
  expect(r).toEqual({ value: { template: { skills: "x" } }, conflicts: ["template.skills"] });
});

test("a __proto__ key on one side only is read as absent on the other", () => {
  const mine = JSON.parse('{"settings":{"__proto__":{"a":1}}}');
  const r = rebase<unknown>({}, mine, { settings: { b: 2 } });
  const settings = (r.value as { settings: Record<string, unknown> }).settings;
  expect(Object.hasOwn(settings, "__proto__")).toBe(true);
  expect(settings.b).toBe(2);
  expect(r.conflicts).toEqual([]);
});

test("a list of objects is a set by canonical JSON", () => {
  const base = { settings: { hooks: { P: [{ a: 1, b: 2 }] } } };
  const mine = { settings: { hooks: { P: [{ b: 2, a: 1 }, { c: 3 }] } } };
  const theirs = { settings: { hooks: { P: [{ z: 0 }, { a: 1, b: 2 }] } } };
  expect(rebase<unknown>(base, mine, theirs).value).toEqual({
    settings: { hooks: { P: [{ z: 0 }, { a: 1, b: 2 }, { c: 3 }] } },
  });
});
