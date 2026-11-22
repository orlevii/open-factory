import { readFileSync } from "node:fs";
import type { Command } from "@open-factory/shared";
import { expect, test } from "vitest";
import { allowedCommands, canonicalCommand, findCommand } from "./commands.ts";

/** The spike's `initialize` list (57 entries: two project skills, the rest built-in). */
const spikeList = (): Command[] => {
  const url = new URL(
    "../../../../packages/harness/fixtures/u3/control-initialize-commands.jsonl",
    import.meta.url,
  );
  const line = readFileSync(url, "utf8")
    .split("\n")
    .map((l) => (l ? JSON.parse(l) : null))
    .find((l) => l?.type === "control_response");
  return line.response.response.commands;
};
const names = (cs: Command[]) => cs.map((c) => c.name).sort();

test("aliases canonicalize; other names stay as they are", () => {
  expect(canonicalCommand("cost")).toBe("usage");
  expect(canonicalCommand("stats")).toBe("usage");
  expect(canonicalCommand("review")).toBe("code-review");
  expect(canonicalCommand("new")).toBe("clear");
  expect(canonicalCommand("reset")).toBe("clear");
  expect(canonicalCommand("usage")).toBe("usage");
  expect(canonicalCommand("spike-echo")).toBe("spike-echo");
});

test("allowed: non-builtin entries plus the built-in allowlist, nothing else", () => {
  const allowed = allowedCommands(spikeList(), []);
  expect(names(allowed)).toEqual(
    [
      "spike-echo",
      "spike-manual",
      "code-review",
      "compact",
      "context",
      "init",
      "security-review",
      "usage",
    ].sort(),
  );
  // Refused built-ins, including bundled `builtin: true` workflows and skills.
  for (const n of [
    "model",
    "config",
    "mcp",
    "ultrareview",
    "batch",
    "effort",
    "schedule",
    "doctor",
    "heapdump",
    "reload-plugins",
    "agents",
    "deep-research",
    "simplify",
    "loop",
  ])
    expect(findCommand(allowed, n)).toBeUndefined();
  // Aliases stay on the canonical row for the menu.
  expect(allowed.find((c) => c.name === "usage")?.aliases).toEqual(["cost", "stats"]);
});

test("findCommand canonicalizes aliases and matches non-builtin aliases", () => {
  const allowed = allowedCommands(
    [
      ...spikeList(),
      {
        name: "spike-plugin:plover-fact",
        description: "A fact (plugin)",
        argumentHint: "",
        aliases: ["plover-fact"],
      },
    ],
    [],
  );
  expect(findCommand(allowed, "cost")?.name).toBe("usage");
  expect(findCommand(allowed, "review")?.name).toBe("code-review");
  // `/clear` is out until a healthy session can be reset (Task 55 review I1): neither it nor its aliases resolve.
  for (const n of ["clear", "new", "reset", "Clear"])
    expect(findCommand(allowed, n)).toBeUndefined();
  expect(findCommand(allowed, "plover-fact")?.name).toBe("spike-plugin:plover-fact");
  expect(findCommand(allowed, "nonexistent")).toBeUndefined();
});

test("a non-builtin entry never smuggles in a refused built-in name", () => {
  const stored: Command[] = [
    { name: "model", description: "Set the model", argumentHint: "", builtin: true },
    { name: "model", description: "A skill named model (project)", argumentHint: "" },
    { name: "batch", description: "A skill named batch (project)", argumentHint: "" },
    { name: "ok-skill", description: "Fine (project)", argumentHint: "" },
  ];
  expect(names(allowedCommands(stored, []))).toEqual(["ok-skill"]);
});

test("template skills missing from the list are added, refused built-in names never", () => {
  const allowed = allowedCommands([], ["research", "model", "ultrareview", "reload-skills"]);
  expect(allowed).toEqual([{ name: "research", description: "", argumentHint: "" }]);
  // Present already: kept once, with the session's description.
  const both = allowedCommands(spikeList(), ["spike-echo"]);
  expect(both.filter((c) => c.name === "spike-echo")).toHaveLength(1);
  expect(both.find((c) => c.name === "spike-echo")?.description).toMatch(/\(project\)$/);
});

test("a skill's alias never names a built-in; findCommand ignores such an alias", () => {
  const stored: Command[] = [
    ...spikeList(),
    {
      name: "foo",
      description: "A planted skill (project)",
      argumentHint: "",
      aliases: ["model", "MODEL", "cost", "Usage", "batch", "foo-short"],
    },
    { name: "bar", description: "x (project)", argumentHint: "", aliases: ["mcp"] },
  ];
  const allowed = allowedCommands(stored, []);
  expect(allowed.find((c) => c.name === "foo")?.aliases).toEqual(["foo-short"]);
  expect(allowed.find((c) => c.name === "bar")).toEqual({
    name: "bar",
    description: "x (project)",
    argumentHint: "",
  });
  expect(findCommand(allowed, "model")).toBeUndefined();
  expect(findCommand(allowed, "foo-short")?.name).toBe("foo");
  // Even over an unchecked list, an alias naming a built-in never resolves.
  const raw: Command[] = [{ name: "foo", description: "", argumentHint: "", aliases: ["model"] }];
  expect(findCommand(raw, "model")).toBeUndefined();
});

test("refusal and shadowing are case-insensitive", () => {
  const stored: Command[] = [
    { name: "model", description: "", argumentHint: "", builtin: true },
    { name: "Model", description: "(project)", argumentHint: "" },
    { name: "BATCH", description: "(project)", argumentHint: "" },
    { name: "Compact", description: "(project)", argumentHint: "" },
    { name: "fine", description: "(project)", argumentHint: "" },
  ];
  expect(names(allowedCommands(stored, []))).toEqual(["fine"]);
  expect(names(allowedCommands([], ["MCP", "Login", "fine"]))).toEqual(["fine"]);
});

test("malformed stored entries and template skills are dropped", () => {
  const stored = [
    { name: "two words", description: "", argumentHint: "" },
    { name: "ok", description: "", argumentHint: "" },
  ] as Command[];
  expect(names(allowedCommands(stored, ["bad name", "good"]))).toEqual(["good", "ok"]);
});

test("before a session list exists, template skills named like terminal commands are refused", () => {
  expect(
    names(allowedCommands([], ["login", "logout", "exit", "resume", "status", "research"])),
  ).toEqual(["research"]);
});

test("clear and its aliases are refused, even as a template or project skill's name (no healthy-session reset yet)", () => {
  const stored: Command[] = [
    { name: "clear", description: "Clear the conversation", argumentHint: "", builtin: true },
    { name: "new", description: "A skill named new (project)", argumentHint: "" },
    { name: "ok-skill", description: "Fine (project)", argumentHint: "", aliases: ["reset"] },
  ];
  const allowed = allowedCommands(stored, []);
  expect(names(allowed)).toEqual(["ok-skill"]);
  expect(allowed[0]?.aliases).toBeUndefined();
  expect(names(allowedCommands([], ["clear", "reset", "new", "triage"]))).toEqual(["triage"]);
});
