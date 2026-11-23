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
const WHY = {
  session: "each agent keeps one session.",
  model: "the model and effort come from the agent's template.",
  credentials: "credentials are managed in Settings \u2192 Credentials.",
  process: "the factory runs this agent's process.",
};
test.each([
  ["clear", WHY.session],
  ["new", WHY.session],
  ["reset", WHY.session],
  ["model", WHY.model],
  ["effort", WHY.model],
  ["login", WHY.credentials],
  ["logout", WHY.credentials],
  ["exit", WHY.process],
  ["quit", WHY.process],
  ["resume", WHY.process],
  ["continue", WHY.process],
])("/%s has its exact reason", (name, why) => {
  expect(deniedReason(name)).toBe(`/${name} isn't available: ${why}`);
  expect(deniedReason(name.toUpperCase())).toBe(`/${name.toUpperCase()} isn't available: ${why}`);
});
test("a name off the denylist has no reason", () =>
  expect(deniedReason("toString")).toBeUndefined());
test.each(["\n", "\r", "\u0085", "\u2028", "\u2029"])(
  "a line break %j makes a command multiline",
  (sep) =>
    expect(classifyInput(`/context${sep}more`, new Set(["context"]))).toMatchObject({
      kind: "command",
      multiline: true,
    }),
);
test("one line is not multiline", () =>
  expect(classifyInput("/context  more", new Set(["context"]))).toMatchObject({
    multiline: false,
  }));
test("/news-digest is not /new", () =>
  expect(classifyInput("/news-digest", new Set(["news-digest"]))).toMatchObject({
    kind: "command",
    denied: undefined,
  }));
test("an unknown /path is text, even on several lines", () =>
  expect(classifyInput("/Users/or/log.txt shows:\nError", new Set())).toEqual({ kind: "text" }));
test("aliases count as known", () =>
  expect(classifyInput("/cost", new Set(["cost"]))).toMatchObject({ kind: "command" }));
