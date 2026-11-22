import { expect, test } from "vitest";
import { activityKey, deriveActivity, formatTarget, mcpParts } from "./activity";
import type { ToolRow } from "./rows";

let n = 0;
const tool = (name: string, input: unknown): ToolRow => {
  n++;
  return {
    kind: "tool",
    seq: n,
    at: "2026-11-21T10:00:00.000Z",
    call: { type: "tool_call", toolUseId: `tu-${n}`, name, input },
    state: "running",
    children: [],
    key: `${n}`,
  };
};
const bash = (command: string, description?: string) =>
  tool("Bash", description === undefined ? { command } : { command, description });
const agentRow = (description: string) => tool("Agent", { description, prompt: "…" });

test("priority: subagents, then the newest open tool, then working", () => {
  expect(
    deriveActivity(
      { openSubagents: [agentRow("Draft the request")], newestOpenTool: bash("pnpm test") },
      undefined,
    ),
  ).toEqual({ kind: "subagent", target: "Draft the request" });
  const a1 = agentRow("One");
  const a2 = agentRow("Two");
  const a3 = agentRow("Three");
  expect(deriveActivity({ openSubagents: [a1, a2, a3] }, undefined)).toEqual({
    kind: "subagents",
    target: "Three",
    more: 2,
  });
  expect(
    deriveActivity(
      { openSubagents: [], newestOpenTool: bash("pnpm test", "Run the tests") },
      undefined,
    ),
  ).toEqual({ kind: "tool", tool: "Bash", target: "Run the tests", prose: true });
  expect(deriveActivity({ openSubagents: [] }, undefined)).toEqual({ kind: "working" });
  expect(deriveActivity(undefined, undefined)).toEqual({ kind: "working" });
});

test("live inputs outrank rows (PR4 shape); thinking, then live text, then working", () => {
  const open = { openSubagents: [agentRow("Draft")], newestOpenTool: bash("ls") };
  expect(
    deriveActivity(open, { toolInput: { name: "Write", target: "src/app.ts" }, texts: [] }),
  ).toEqual({ kind: "tool_input", tool: "Write", target: "app.ts" });
  expect(deriveActivity(undefined, { thinking: { tokens: 10 }, texts: ["x"] })).toEqual({
    kind: "thinking",
  });
  expect(deriveActivity(undefined, { texts: ["x"] })).toEqual({ kind: "text" });
  expect(deriveActivity(undefined, { texts: [] })).toEqual({ kind: "working" });
});

test("formatTarget: Bash description else the command's first line; files by name; patterns; MCP", () => {
  expect(formatTarget("Bash", { command: "pnpm test\n--watch" })).toBe("pnpm test");
  expect(formatTarget("Bash", { command: "ls", description: "List files" })).toBe("List files");
  expect(formatTarget("Read", { file_path: "/w/src/retry.ts" })).toBe("retry.ts");
  expect(formatTarget("Edit", { file_path: "src/a.ts" })).toBe("a.ts");
  expect(formatTarget("Write", { file_path: "b.md" })).toBe("b.md");
  expect(formatTarget("Grep", { pattern: "TODO\\(" })).toBe("TODO\\(");
  expect(formatTarget("Glob", { pattern: "**/*.ts" })).toBe("**/*.ts");
  expect(formatTarget("mcp__github__create_pull_request", {})).toBe("github · create_pull_request");
  expect(formatTarget("WebFetch", { url: "https://x" })).toBeUndefined();
  expect(formatTarget("Bash", null)).toBeUndefined();
});

test("activityKey is a primitive per distinct activity", () => {
  expect(activityKey({ kind: "working" })).toBe(activityKey({ kind: "working" }));
  expect(activityKey({ kind: "subagents", target: "a", more: 2 })).not.toBe(
    activityKey({ kind: "subagents", target: "a", more: 3 }),
  );
});

test("mcpParts: server and tool, shared by the activity line and the tool row", () => {
  expect(mcpParts("mcp__github__create_pull_request")).toEqual({
    server: "github",
    tool: "create_pull_request",
  });
  expect(mcpParts("mcp__srv__a__b")).toEqual({ server: "srv", tool: "a__b" });
  expect(mcpParts("mcp__solo")).toEqual({ server: "solo" });
  expect(mcpParts("Bash")).toBeUndefined();
});

test("live tool input reads through the open tool's formatter, so the label doesn't change when the call lands", () => {
  const cases: [string, string, Record<string, string>][] = [
    ["Write", "/w/src/app.ts", { file_path: "/w/src/app.ts" }],
    ["Bash", "pnpm test\n--watch", { command: "pnpm test\n--watch" }],
    ["Grep", "TODO", { pattern: "TODO" }],
  ];
  for (const [name, target, input] of cases) {
    const live = deriveActivity(undefined, { toolInput: { name, target }, texts: [] });
    const landed = deriveActivity(
      { openSubagents: [], newestOpenTool: tool(name, input) },
      undefined,
    );
    expect(live.target).toBe(landed.target);
    expect(live.kind).toBe("tool_input");
  }
  // No target parsed yet: the tool's name alone.
  expect(deriveActivity(undefined, { toolInput: { name: "Write" }, texts: [] })).toEqual({
    kind: "tool_input",
    tool: "Write",
  });
});

test("thinking counts only while a thinking block is open", () => {
  expect(deriveActivity(undefined, { thinking: { tokens: 0 }, texts: [] }).kind).toBe("thinking");
  expect(deriveActivity(undefined, { texts: [] }).kind).toBe("working");
});
