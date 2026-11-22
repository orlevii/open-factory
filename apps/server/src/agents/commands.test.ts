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
      "clear",
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
  expect(findCommand(allowed, "reset")?.name).toBe("clear");
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
