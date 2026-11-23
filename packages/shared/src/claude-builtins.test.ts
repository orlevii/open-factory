import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { CLAUDE_BUILTINS } from "./claude-builtins.ts";

const fixture = () => {
  const url = new URL(
    "../../harness/fixtures/u3/control-initialize-commands.jsonl",
    import.meta.url,
  );
  const line = readFileSync(url, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .find((l) => l.type === "control_response");
  return line.response.response.commands as {
    name: string;
    description: string;
    argumentHint: string;
    aliases?: string[];
    builtin?: boolean;
  }[];
};

test("the snapshot is the fixture's built-ins", () => {
  const expected = fixture()
    .filter((c) => c.builtin)
    .map((c) => ({
      name: c.name,
      description: c.description,
      argumentHint: c.argumentHint,
      aliases: c.aliases ?? [],
    }));
  expect(CLAUDE_BUILTINS).toEqual(expected);
  expect(CLAUDE_BUILTINS).toHaveLength(55);
});

test("context and clear are in it, clear with its aliases", () => {
  expect(CLAUDE_BUILTINS.find((c) => c.name === "context")).toBeDefined();
  expect(CLAUDE_BUILTINS.find((c) => c.name === "clear")?.aliases).toEqual(["reset", "new"]);
});
