import { readFileSync } from "node:fs";
import type { Command } from "@open-factory/shared";
import { expect, test } from "vitest";
import { commandList, commandsResponse } from "./commands.ts";

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
const byName = (cs: Command[], n: string) => cs.find((c) => c.name === n);

test("nothing stored: the built-ins and the template's skills", () => {
  const list = commandList(undefined, ["research"]);
  expect(byName(list, "context")).toMatchObject({ builtin: true });
  expect(byName(list, "context")?.denied).toBeUndefined();
  expect(byName(list, "clear")?.denied).toBe(
    "/clear isn't available: each agent keeps one session.",
  );
  expect(byName(list, "research")).toEqual({ name: "research", description: "", argumentHint: "" });
  // 55 built-ins, but `__remote-workflow` is outside the name format and dropped, as the harness drops it.
  expect(list).toHaveLength(55);
});

test("stored: the stored list, the denylist flagged, nothing dropped", () => {
  const list = commandList(spikeList(), ["not-yet-started"]);
  expect(list).toHaveLength(spikeList().length - 1);
  expect(byName(list, "spike-echo")?.denied).toBeUndefined();
  expect(byName(list, "model")?.denied).toBe(
    "/model isn't available: the model and effort come from the agent's template.",
  );
  expect(byName(list, "not-yet-started")).toBeUndefined();
});

test("a skill is flagged by its name only, never by an alias", () => {
  const list = commandList(
    [
      { name: "reset", description: "(project)", argumentHint: "" },
      { name: "tidy", description: "(project)", argumentHint: "", aliases: ["quit"] },
    ],
    [],
  );
  expect(byName(list, "reset")?.denied).toMatch(/^\/reset isn't available/);
  expect(byName(list, "tidy")?.denied).toBeUndefined();
  expect(commandList(undefined, ["reset"]).filter((c) => c.name === "reset")).toHaveLength(1);
});

test("a stored `denied` is never trusted; malformed entries are dropped", () => {
  const list = commandList(
    [
      { name: "ok", description: "", argumentHint: "", denied: "forged" },
      { name: "two words", description: "", argumentHint: "" },
    ],
    [],
  );
  expect(list).toEqual([{ name: "ok", description: "", argumentHint: "" }]);
});

test("the response: template before a first start, session after, stale when the template grew", () => {
  expect(commandsResponse(undefined, []).source).toBe("template");
  const r = commandsResponse({ commands: spikeList(), at: new Date(0) }, ["spike-echo", "new-one"]);
  expect(r).toMatchObject({ source: "session", at: new Date(0).toISOString(), stale: true });
});
