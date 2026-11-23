import { expect, test } from "vitest";
import {
  boundVersion,
  classifyInput,
  deniedReason,
  MAX_COMMANDS,
  parseCommands,
} from "./commands.ts";

const ok = (name: string, over: Record<string, unknown> = {}) => ({
  name,
  description: "",
  argumentHint: "",
  ...over,
});

test("names: one token, no space, newline or leading slash, at most 100 chars", () => {
  const dropped: unknown[] = [];
  const kept = parseCommands(
    [
      ok("spike-plugin:plover-fact"),
      ok("a.b_c-1"),
      ok("/model"),
      ok("two words"),
      ok("x\nmodel"),
      ok("-lead"),
      ok(""),
      ok("a".repeat(100)),
      ok("a".repeat(101)),
    ],
    (e) => dropped.push(e),
  );
  expect(kept.map((c) => c.name)).toEqual(["spike-plugin:plover-fact", "a.b_c-1", "a".repeat(100)]);
  expect(dropped).toHaveLength(6);
});

test("aliases follow the name format; descriptions are capped; a bad builtin mark drops the entry", () => {
  expect(parseCommands([ok("a", { aliases: ["b c"] })])).toEqual([]);
  expect(parseCommands([ok("a", { description: "x".repeat(2049) })])).toEqual([]);
  expect(parseCommands([ok("a", { description: "x".repeat(2048) })])).toHaveLength(1);
  expect(parseCommands([ok("model", { builtin: "true" })])).toEqual([]);
});

test("at most MAX_COMMANDS entries", () => {
  const many = Array.from({ length: MAX_COMMANDS + 20 }, (_, i) => ok(`s${i}`));
  expect(parseCommands(many)).toHaveLength(MAX_COMMANDS);
});

test("the version is kept only as a short plain string", () => {
  expect(boundVersion("2.1.327")).toBe("2.1.327");
  expect(boundVersion("1".repeat(65))).toBeUndefined();
  expect(boundVersion("2.1\nx")).toBeUndefined();
  expect(boundVersion(2)).toBeUndefined();
});

test.each(["/clear", "/NEW", "  /quit", "/Resume x", "/continue"])("%s is denied", (t) =>
  expect(classifyInput(t, new Set())).toMatchObject({
    kind: "command",
    denied: expect.stringContaining("isn't available"),
  }),
);
test("the reason names the command as typed", () =>
  expect(deniedReason("QUIT")).toBe(
    "/QUIT isn't available: the factory runs this agent's process.",
  ));
test("each group has its reason", () => {
  expect(deniedReason("reset")).toBe("/reset isn't available: each agent keeps one session.");
  expect(deniedReason("effort")).toBe(
    "/effort isn't available: the model and effort come from the agent's template.",
  );
  expect(deniedReason("login")).toBe(
    "/login isn't available: credentials are managed in Settings \u2192 Credentials.",
  );
  expect(deniedReason("toString")).toBeUndefined();
});
test("/news-digest is not /new", () =>
  expect(classifyInput("/news-digest", new Set(["news-digest"]))).toMatchObject({
    kind: "command",
    denied: undefined,
  }));
test("an unknown /path is text, even on several lines", () =>
  expect(classifyInput("/Users/or/log.txt shows:\nError", new Set())).toEqual({ kind: "text" }));
test("a known multi-line command is flagged", () =>
  expect(classifyInput("/context\nmore", new Set(["context"]))).toMatchObject({
    multiline: true,
  }));
test("aliases count as known", () =>
  expect(classifyInput("/cost", new Set(["cost"]))).toMatchObject({ kind: "command" }));
